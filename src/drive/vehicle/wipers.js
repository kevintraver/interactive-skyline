// The wipers (plan 02, D8.2; section 7.6): which mode the rain rate asks for, and where the two blades are, as pure
// functions of simulation time. No three.js. glassRain.js computes the same per fragment and per drop (the time since a
// blade last passed a point of the glass) and draws the blades.
//
// The blades sweep the arcs the dirt mask already assumes (veil.js WIPERS: a left-hand-drive tandem pair,
// pivots under the cowl, both parked along the cowl at a0 and sweeping counter-clockwise to a1), in step, on one
// linkage. One cycle is an out-stroke and a return taking SWEEP seconds, then a pause at park (intermittent only):
//     q(phase) = (1 - cos(2 pi phase / sweep)) / 2  for phase < sweep, else 0;  angle = a0 + (a1 - a0) q
// (a crank-and-rocker linkage moves the blade close to sinusoidally; ASSUMED), phase = (t mod period), t in simulation
// seconds since the epoch, so the same time always puts the blades in the same place.
//
// Modes by rain rate R (mm/h), the thresholds:
//   off           R = 0: parked at a0
//   intermittent  0 < R < 2.5: one low-speed cycle, then a pause of clamp(3 / R, 1.5, 12) s (3 s at 1 mm/h)
//   low           2.5 <= R < 8: 45 cycles a minute
//   high          R >= 8: 65 cycles a minute
// The rates: FMVSS 104 S4.2 asks for at least two frequencies, one of at least 45 cycles a minute and the highest
// at least 15 above the lowest; 45 and 65 meet it. The rain thresholds and the pause are ASSUMED (light rain 1 mm/h
// intermittent, rain 4 mm/h low, heavy rain 12 mm/h high, the three presets of env.js).
//
// Comfort (section 4.11) at fast clock rates: see comfortOf. The angle stays a pure function of simulation time; what
// changes with the clock's rate is only how the blade is drawn (the exposure it is blurred over).

export const WIPER_THRESHOLDS = Object.freeze({ lowMmPerHour: 2.5, highMmPerHour: 8 });
export const WIPER_CPM = Object.freeze({ low: 45, high: 65 });
/** The intermittent pause: PAUSE_K / R seconds, within [PAUSE_MIN, PAUSE_MAX]. */
export const PAUSE_K = 3, PAUSE_MIN = 1.5, PAUSE_MAX = 12;
/** Comfort: the blade is drawn sharp up to COMFORT_HZ wipes per real second, and as its average over a whole cycle
 * from 2 x COMFORT_HZ (blended between). Section 4.11 allows no full-field flashing above 3 Hz. */
export const COMFORT_HZ = 1.5;

/** @returns {'off'|'intermittent'|'low'|'high'} */
export function wiperMode(R) {
  if (!(R > 0)) return 'off';
  if (R < WIPER_THRESHOLDS.lowMmPerHour) return 'intermittent';
  if (R < WIPER_THRESHOLDS.highMmPerHour) return 'low';
  return 'high';
}

/** The cycle for a rain rate: { mode, sweepS, pauseS, periodS } (periodS Infinity when off). */
export function wiperSchedule(R) {
  const mode = wiperMode(R);
  if (mode === 'off') return Object.freeze({ mode, sweepS: 60 / WIPER_CPM.low, pauseS: Infinity, periodS: Infinity });
  const sweepS = 60 / (mode === 'high' ? WIPER_CPM.high : WIPER_CPM.low);
  const pauseS = mode === 'intermittent' ? Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, PAUSE_K / R)) : 0;
  return Object.freeze({ mode, sweepS, pauseS, periodS: sweepS + pauseS });
}

const mod = (a, m) => ((a % m) + m) % m;

/** Where in its cycle the linkage is at simulation time tSec (seconds into the period; 0 when off). */
export const wipePhase = (tSec, sched) => (Number.isFinite(sched.periodS) ? mod(tSec, sched.periodS) : 0);

/** The sweep fraction (0 parked, 1 at the top of the stroke) at a phase. */
export function sweepAtPhase(phase, sched) {
  if (!Number.isFinite(sched.periodS) || phase >= sched.sweepS) return 0;
  return (1 - Math.cos((2 * Math.PI * phase) / sched.sweepS)) / 2;
}

/** The sweep fraction at simulation time tSec. */
export const sweepAt = (tSec, sched) => sweepAtPhase(wipePhase(tSec, sched), sched);

/** Blade angle (degrees, counter-clockwise from the glass's +x about its pivot) for one wiper (windshield.js WIPERS). */
export const bladeAngle = (q, w) => w.a0 + (w.a1 - w.a0) * q;

/**
 * How long ago (s) the blade last passed the sweep fraction q (0..1), seen at a phase of the cycle; Infinity when
 * the wipers are off. The blade passes q twice a cycle, going up at tau and coming back at sweep - tau.
 */
export function passAgoAtPhase(phase, sched, q) {
  if (!Number.isFinite(sched.periodS)) return Infinity;
  const qq = Math.min(1, Math.max(0, q));
  const up = (sched.sweepS / (2 * Math.PI)) * Math.acos(1 - 2 * qq);
  const down = sched.sweepS - up;
  let a = phase - up; if (a < 0) a += sched.periodS;
  let b = phase - down; if (b < 0) b += sched.periodS;
  return Math.min(a, b);
}

/**
 * How long ago (s) any blade last passed the glass point (x, y) (glass metres: x from the left along the bottom, y up
 * the glass), Infinity if no blade sweeps it or the wipers are off.
 * @param {number} x @param {number} y @param {number} phase @param {object} sched @param {readonly object[]} wipers
 */
export function passAgoAt(x, y, phase, sched, wipers) {
  let best = Infinity;
  for (const w of wipers) {
    const dx = x - w.x, dy = y - w.y, r = Math.hypot(dx, dy);
    if (r < w.rIn || r > w.rOut) continue;
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (a < w.a0 || a > w.a1) continue;
    best = Math.min(best, passAgoAtPhase(phase, sched, (a - w.a0) / (w.a1 - w.a0)));
  }
  return best;
}

/**
 * How the blades are drawn at a clock rate: c (0 sharp .. 1 averaged over a whole cycle) and the exposure (simulation
 * seconds) the blade is blurred over. Playing at `rate`, a frame (60 a second assumed) spans rate / 60 simulation
 * seconds; the blade is blurred over that, and once the wipes come faster than COMFORT_HZ per real second the
 * exposure grows to the whole period, so at 16x the blades read as a steady faint fan instead of strobing.
 */
export function comfortOf(sched, rate, playing) {
  if (!playing || !Number.isFinite(sched.periodS)) return { c: 0, exposureS: 0, wipesPerRealS: 0 };
  const r = Math.abs(rate || 1);
  const hz = r / sched.periodS;
  const c = Math.min(1, Math.max(0, (hz - COMFORT_HZ) / COMFORT_HZ));
  return { c, exposureS: Math.max(r / 60, c * sched.periodS), wipesPerRealS: hz };
}

/** The wipers' state at simulation time tSec for rain rate R: { mode, q, angle (the driver's blade), angles }. */
export function wiperState(tSec, R, wipers) {
  const sched = wiperSchedule(R);
  const q = sweepAt(tSec, sched);
  const angles = wipers.map((w) => bladeAngle(q, w));
  return { mode: sched.mode, q, angle: angles[0], angles };
}

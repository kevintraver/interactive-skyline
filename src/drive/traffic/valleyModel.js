// The arithmetic of the valley's light ribbons (plan 02, D6.6), in JavaScript. Pure: no three.js, no DOM.
//
// Mirror: valley.glsl.js does the same per vertex and per fragment (shapeAt, densityPerMetre, lampIntensity,
// ribbonRadiance, driftSpeed, the drift pattern); tests/unit/traffic/valley.test.js holds this file to the
// counts. Change both together.
//
// A ribbon is one direction of one road. Its brightness along the road is the light of the vehicles on it:
//   vehicles per metre      n = Q x shape(how) / (3600 v)        Q daily volume, shape the hour-of-week share of
//                                                                 a mean day (valley.json), v the speed, m/s
//   intensity toward the eye per vehicle  I(c) = head(c) + spill(c) + tail(c), c = cos(angle between the
//                                         direction of travel and the direction from the road to the eye):
//                                         c = 1 the traffic comes straight at the eye (head lamps, white),
//                                         c = -1 it goes straight away (tail lamps, red)
//   luminance of a strip of width w facing the eye at angle theta to the road   L = n I / (w sin theta);
//   of a strip lying on the ground, seen from elevation e                      L = n I / (w sin e)
// so the light a stretch of road sends to the eye is n I per metre whatever the strip's width: the strip can be
// drawn at least a pixel or two wide far away without changing how bright the road reads.

import { tzOffsetMs, HOUR_MS } from './flow.js';

export const HOURS = 168;

/**
 * Per-vehicle lamp intensities (candela toward the eye), consistent with the light sprites of the route's own
 * traffic, which take FMVSS 108's photometry. The eye that sees the valley's roads is above them (on the freeway
 * coming down into the valley, or on a hill): it looks at the vehicles from a degree or two below their lamps'
 * horizontal, inside the low beam's bright zone. ASSUMED within FMVSS 108's ranges:
 *  - head: a pair of low beams 1-2 deg below the horizontal near the axis, where the standard asks 1,000-10,000 cd
 *    per lamp and wants at least 2,000 at 1.5D across +-9 deg: 2 x 1,200 cd, falling as cos^HEAD_POWER off the
 *    axis (cos^2 is half at 45 deg, about the width of a low beam's spread below the horizontal).
 *  - spill: the head lamps' light on the pavement ahead and their side spill, seen from the side and above
 *    (about 400 lm on asphalt of albedo 0.1 is about 13 cd toward a raised eye from each side of the pool; side
 *    marker lamps a few cd more): 40 cd from the front, falling to none from straight behind.
 *  - tail: a pair of tail lamps (FMVSS 108: 2-18 cd each at H-V; 2 x 12 cd) plus a share of stop lamps lit in
 *    traffic (2 x 80 cd and a 25 cd high-mounted lamp on about 1 vehicle in 12 at the evening peak: 15 cd).
 */
export const VALLEY_LAMPS = Object.freeze({ head: 2400, headPower: 2, spill: 40, tail: 40 });
/** Linear sRGB colours at luminance 1: a cool-white mix of LED and halogen head lamps; tail-lamp red (about 620 nm). */
export const HEAD_COLOR = Object.freeze([1.03, 0.99, 0.93]);
export const TAIL_COLOR = Object.freeze([3.9, 0.22, 0.06]);
/** The drift pattern: cell length (m) and the cells in one period (the pattern repeats every CELLS x CELL_M). */
export const DRIFT_CELL_M = 60;
export const DRIFT_CELLS = 64;
/** Simulation seconds after which the drift's time wraps (see driftSpeed). */
export const DRIFT_WRAP_S = 3600;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Local hour of week as a real number: 24 * day + hour + minutes / 60, day 0 = Monday. */
export function hourOfWeekAt(utcMs, tz) {
  const L = utcMs + tzOffsetMs(utcMs, tz);
  const days = Math.floor(L / 86400000);
  const day = (((days + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday
  return 24 * day + (L - days * 86400000) / HOUR_MS;
}

/**
 * The shape's value at a real hour of week, linear between the middles of the hours (so the value at h + 0.5 is
 * exactly values[h] and the week wraps).
 * @param {ArrayLike<number>} values 168  @param {number} how
 */
export function shapeAt(values, how) {
  const x = how - 0.5;
  const i = Math.floor(x);
  const f = x - i;
  const a = values[((i % HOURS) + HOURS) % HOURS], b = values[(((i + 1) % HOURS) + HOURS) % HOURS];
  return a + (b - a) * f;
}

/** Vehicles per metre of one direction: daily volume x shape / (3600 x speed in m/s). */
export function densityPerMetre(volume, values, how, speedMps) {
  return (volume * shapeAt(values, how)) / (3600 * speedMps);
}

/**
 * Intensity of one vehicle toward the eye, split by colour.
 * @param {number} c cos of the angle between the direction of travel and the direction from the road to the eye
 * @returns {{ head: number, tail: number }} candela of white (head lamps and their spill) and of red
 */
export function lampIntensity(c, lamps = VALLEY_LAMPS) {
  const front = clamp01(c), back = clamp01(-c);
  return {
    head: lamps.head * front ** lamps.headPower + lamps.spill * clamp01(0.5 + 0.5 * c),
    tail: lamps.tail * back,
  };
}

/** The share of red in a ribbon's light seen at c (0 all white .. 1 all red), by intensity. */
export function redShare(c, lamps = VALLEY_LAMPS) {
  const { head, tail } = lampIntensity(c, lamps);
  return head + tail > 0 ? tail / (head + tail) : 0;
}

/**
 * Luminance (cd/m^2) of a strip of width w (m) on a road of n vehicles per metre, each of intensity I toward the
 * eye. A strip facing the eye is seen foreshortened by sinTheta of the angle between the road and the line of
 * sight (clamped at 0.1, as the shader does); a strip flat on the ground by the sine of the eye's elevation (pass
 * flat = true and that sine as proj).
 */
export function ribbonRadiance(n, intensity, width, proj, flat = false) {
  return (n * intensity) / (width * (flat ? Math.max(proj, 1e-3) : Math.max(proj, 0.1)));
}

/**
 * The speed the drift pattern moves at: the traffic's speed rounded to a step that makes the pattern come back to
 * itself after DRIFT_WRAP_S, so the shader's time can wrap there without a jump.
 */
export function driftSpeed(speedMps) {
  const q = (DRIFT_CELL_M * DRIFT_CELLS) / DRIFT_WRAP_S;
  return Math.max(1, Math.round(speedMps / q)) * q;
}

/** The drift's time for a simulation time: seconds, wrapped at DRIFT_WRAP_S. */
export const driftTime = (simMs) => (((simMs / 1000) % DRIFT_WRAP_S) + DRIFT_WRAP_S) % DRIFT_WRAP_S;

/** The hash of the drift pattern (the shader's hash11): a cell index to 0..1. */
export function hash11(i) {
  let p = (i * 0.1031) % 1;
  if (p < 0) p += 1;
  p *= p + 33.33;
  p *= p + p;
  return ((p % 1) + 1) % 1;
}

/** The mean of hash11 over one period of cells (the pattern is centred on it so that its mean is exactly 1). */
export const HASH_MEAN = Array.from({ length: DRIFT_CELLS }, (_, i) => hash11(i)).reduce((a, b) => a + b, 0) / DRIFT_CELLS;

/**
 * The drift pattern's brightness factor at metre u along a ribbon at drift time t (mean 1 over a period): smooth
 * value noise in cells of DRIFT_CELL_M moving with the traffic, of amplitude 1 / sqrt(vehicles per cell) (the
 * spread of a Poisson count), at most 0.9.
 */
export function driftFactor(u, t, speedMps, n) {
  const x = (u - driftSpeed(speedMps) * t) / DRIFT_CELL_M;
  const i = Math.floor(x), f = x - i;
  const s = f * f * (3 - 2 * f);
  const m = (k) => ((k % DRIFT_CELLS) + DRIFT_CELLS) % DRIFT_CELLS;
  const v = hash11(m(i)) + (hash11(m(i + 1)) - hash11(m(i))) * s - HASH_MEAN + 0.5;
  const amp = Math.min(0.9, 1 / Math.sqrt(n * DRIFT_CELL_M + 1e-6));
  return 1 + amp * (2 * v - 1);
}

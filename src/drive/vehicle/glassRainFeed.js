// What the rain on the windshield gives its shaders each frame (plan 02, D8.2), shared by both renderers: glassRain.js
// (the classic renderer) and glassRain.node.js (plan 01's) hold the same values in their own uniforms and pass them in
// as `out`. The rules are drops.js and wipers.js; this is glassRain.js's per-frame work, moved here unchanged.
//
// Per frame (update): the weather's rain rate (env.weather.state()), the wiper cycle for it, the window of bins
// (drops.js createBinWindow: per half-second bin of absolute simulation time, the expected arrivals per site from the
// car's pose at that time, journey.poseAt, and the rain relative to it, rainMirror.js relativeRain; cached per bin, so a
// playing clock computes about one new bin a frame at 16x and a seek 64), and the blades' sweep at SAMPLES instants over
// the frame's exposure (wipers.js comfortOf). Everything the GPU sees is a pure function of simulation time, the weather
// and the clock's rate (the last only for how the blades blur).

import { DROP, arrivalRate, runSpeed, createBinWindow, glassDrops } from './drops.js';
import { wiperSchedule, wipePhase, sweepAtPhase, comfortOf, bladeAngle } from './wipers.js';
import { WIPERS } from './veil.js';
import { relativeRain } from '../weather/rainMirror.js';

/** Instants over the exposure at which the blades are drawn. */
export const SAMPLES = 12;
/** Micro-drops of the mist per unit of arriving water (ASSUMED: rain holds an order of magnitude more drops under
 * 1 mm than over it, Marshall-Palmer's ratio at a few mm/h), each in a MIST_CELL (4 mm) cell. */
export const MIST_K = 10, MIST_CELL = 0.004;
/** The lens: a drop shows the scene over MAG times its own radius, upside down (ASSUMED, by eye; a real drop shows a
 * still wider field). */
export const MAG = 14;

/**
 * @param {{ glass: object, layout: object, env: object, session: object, enabled?: boolean }} o
 *   glass: drops.js glassOf; layout: drops.js siteLayout
 * @returns the feed: update(frame, out, { sky }), raining, state(), drops(), setEnabled, setSpeedOverride, stats()
 *   out = { bins: Vector4[DROP.BINS], k0, tw, renewOffset, comfort, qStep, mistRate, haze: { value }, wipe: Vector4,
 *   q: number[SAMPLES], qRange: Vector2, sky: Color, blade: Color } (the shaders' values, written in place)
 */
export function createRainFeed({ glass, layout, env, session, enabled: on = true }) {
  let enabled = on;
  let speedOverride = null;
  let R = 0, sched = wiperSchedule(0), phase = 0, tSec = 0, raining = false, comfort = { c: 0, exposureS: 0, wipesPerRealS: 0 };
  let win = null, poseNow = null, rateNow = 0;
  let state = null;

  // one bin of absolute simulation time: the expected arrivals per site and the runners' speed up the glass, from the
  // car's pose at the bin's start. Pure in k for one cache key (the journey and its timing, the weather, the hold).
  let held = null;
  function source(k) {
    const journey = session?.journey;
    const tMs = k * DROP.BIN_S * 1000;
    let pose = held ? held : journey ? journey.poseAt(tMs) : poseNow;
    if (speedOverride !== null && pose) pose = { ...pose, speed: speedOverride };
    if (!pose) return { lambda: 0, vy: 0 };
    const rel = relativeRain(state, pose);
    return { lambda: (arrivalRate(R, rel.velocityCar, glass, rel.fallMps) * DROP.BIN_S) / layout.count, vy: runSpeed(pose.speed || 0) };
  }
  const bins = createBinWindow(source);

  /**
   * This frame's values into `out`. Returns whether it rains on the glass (dry: nothing is written but the state).
   * @param {object} frame the session's frame  @param {object} out  @param {{ sky?: import('three').Color }} [o]
   *   sky: the haze's colour (linear)
   */
  function update(frame, out, { sky } = {}) {
    state = env?.weather?.state?.() || { precipMmPerHour: 0 };
    R = state.precipMmPerHour || 0;
    raining = enabled && R > 0;
    sched = wiperSchedule(R);
    tSec = frame.simMs / 1000;
    phase = wipePhase(tSec, sched);
    if (!raining) { win = null; return false; }
    poseNow = frame.pose;
    const journey = session?.journey;
    const locked = !!session?.locked;
    held = locked && journey ? { ...journey.poseAtS(frame.pose.s), speed: 0 } : null;
    const key = `${journey?.id}|${journey?.departMs}|${R}|${state.windMps}|${state.windFromDeg}|${locked ? Math.round(frame.pose.s * 10) : ''}|${speedOverride}`;
    win = bins.at(tSec, key);
    const b = out.bins;
    for (let j = 0; j < DROP.BINS; j++) b[j].fromArray(win.data, 4 * j);
    out.k0.value = win.k0 >>> 0;
    out.tw.value = win.tw;
    out.renewOffset.value = win.renewOffset;
    const wiping = Number.isFinite(sched.periodS);
    out.wipe.set(phase, sched.sweepS, wiping ? sched.periodS : 1, wiping ? 1 : 0);
    rateNow = frame.rate;
    comfort = comfortOf(sched, frame.rate, frame.playing);
    out.comfort.value = comfort.c;
    // the blades over the exposure: SAMPLES instants from now back
    let step = 0, prev = null, qlo = 1, qhi = 0;
    for (let s = 0; s < SAMPLES; s++) {
      const ph = wiping ? wipePhase(tSec - (comfort.exposureS * s) / (SAMPLES - 1), sched) : 0;
      const q = sweepAtPhase(ph, sched);
      out.q[s] = q;
      if (prev !== null) step = Math.max(step, Math.abs(q - prev));
      prev = q; qlo = Math.min(qlo, q); qhi = Math.max(qhi, q);
    }
    out.qStep.value = step;
    out.qRange.set(qlo, qhi);
    // the mist: micro-drops per cell per second at the arrival rate now
    const rel = relativeRain(state, speedOverride !== null ? { ...frame.pose, speed: speedOverride } : held || frame.pose);
    const perM2 = arrivalRate(R, rel.velocityCar, glass, rel.fallMps) / glass.area;
    out.mistRate.value = perM2 * MIST_CELL * MIST_CELL * MIST_K;
    out.haze.value = 0.25 + 0.25 * Math.min(1, R / 12);
    if (sky) {
      const c = out.sky.copy(sky).convertLinearToSRGB();
      out.blade.copy(c).multiplyScalar(0.06).addScalar(0.008);
    }
    return true;
  }

  /** What the GPU draws, from the JavaScript mirror (for tests: a few milliseconds over every site). */
  function mirrorDrops() {
    if (!raining || !win) return [];
    return glassDrops({ layout, win: { ...win, data: win.data.slice() }, wipe: { phase, sched }, wipers: WIPERS });
  }

  return {
    update,
    get raining() { return raining; },
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; },
    setSpeedOverride(v) { speedOverride = Number.isFinite(v) ? v : null; },
    drops: mirrorDrops,
    /** { mode, angle (the driver's blade, degrees), angles, q, dropCount, comfort, rate } */
    state() {
      const q = sweepAtPhase(phase, sched);
      return {
        mode: sched.mode, q, angle: bladeAngle(q, WIPERS[0]), angles: WIPERS.map((w) => bladeAngle(q, w)),
        dropCount: mirrorDrops().length, periodS: sched.periodS, comfort: comfort.c, exposureS: comfort.exposureS,
        rateMmPerHour: R, clockRate: rateNow, sites: layout.count,
      };
    },
    get mode() { return sched.mode; },
    get binCount() { return bins.size; },
  };
}

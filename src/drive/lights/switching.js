// Street lamps switching on at dusk (plan 02, D5.5 and section 5.9). Pure: no three.js, no DOM.
//
// Each lamp has a photocell threshold: it is lit while the ambient horizontal illuminance is below it. A hash of
// the lamp's index spreads thresholds log-logistically around a middle value, so a city switches on over several
// minutes rather than at once. Because the threshold is a fixed function of the index and ambient light a fixed
// function of the sun, the moment a lamp switched on, and so its warm-up, is a pure function of simulation time:
// scrubbing backwards or forwards gives the same picture as playing.
//
// Shader mirror: lampHash() is integer-only (an fmix32 finaliser) and switchThresholdLux() one pow, so a vertex
// shader can decide lit / unlit per instance from its index and an ambientLux uniform:
//   u = hash(index); T = mid * pow(u / (1 - u), spread); lit = ambient < T.
// The switch-on time (for warm-up) is cheaper per lamp on the CPU or in the worker, as an instance attribute.

import { ambientLux } from '../env.js';

/** Middle threshold, lux. ASSUMED: roadway photocontrols are commonly set to switch on near 1-3 fc (11-32 lux) and
 * off at a higher level (ANSI C136.10, recalled, not re-opened); 16 lux (1.5 fc) is the middle of that. */
export const SWITCH_MID_LUX = 16;
/** Spread of thresholds in log space (log-logistic scale). ASSUMED; 0.4 puts the middle 80% of lamps between
 * 0.4x and 2.4x the middle value. The acceptance test pins the consequences (5% to 95% between sun 0 and -6 deg,
 * no step above 10% in 30 s). */
export const SWITCH_SPREAD = 0.4;
const DAY_MS = 86400000;

/** A well-mixed hash of a non-negative integer, in [0, 1). murmur3's fmix32 finaliser. */
export function lampHash(index, seed = 0x9e3779b9) {
  let h = (index ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** The ambient illuminance (lux) below which lamp `index` is lit. */
export function switchThresholdLux(index, { midLux = SWITCH_MID_LUX, spread = SWITCH_SPREAD } = {}) {
  const u = Math.min(1 - 1e-4, Math.max(1e-4, lampHash(index)));
  return midLux * (u / (1 - u)) ** spread;
}

/** Whether lamp `index` is lit at an ambient illuminance (lux). */
export const isLit = (index, ambient, opts) => ambient < switchThresholdLux(index, opts);

/** Share of lamps lit at an ambient illuminance (lux): the log-logistic distribution of thresholds. */
export function litShare(ambient, { midLux = SWITCH_MID_LUX, spread = SWITCH_SPREAD } = {}) {
  if (!(ambient > 0)) return 1;
  return 1 / (1 + (ambient / midLux) ** (1 / spread));
}

/** The sun elevation (degrees) at which ambientLux() equals `lux`; ambientLux is monotonic, so bisection. */
export function elevationForLux(lux, fn = ambientLux) {
  let a = -30, b = 90;
  if (lux <= fn(a)) return a;
  if (lux >= fn(b)) return b;
  for (let k = 0; k < 60; k++) {
    const m = (a + b) / 2;
    if (fn(m) < lux) a = m; else b = m;
  }
  return (a + b) / 2;
}

/**
 * When lamp `index` last switched on, as of simulation time simMs (UTC ms), or NaN if it is off then.
 * @param {number} index
 * @param {number} simMs
 * @param {{ sun: (ms: number) => { elevation: number }, timeOfSunElevation: (el: number, dayMs: number, evening: boolean) => number }} ephemeris
 * @param {{ midLux?: number, spread?: number }} [opts]
 */
export function switchOnTime(index, simMs, ephemeris, opts) {
  const threshold = switchThresholdLux(index, opts);
  if (!(ambientLux(ephemeris.sun(simMs).elevation) < threshold)) return NaN;
  const el = elevationForLux(threshold);
  // the evening crossing of this local day; after midnight and before dawn, the previous evening's
  let t = ephemeris.timeOfSunElevation(el, simMs, true);
  if (!(t <= simMs)) t = ephemeris.timeOfSunElevation(el, simMs - DAY_MS, true);
  return t <= simMs ? t : NaN;
}

/**
 * Lamp state at simulation time: lit, and seconds since it switched on (NaN when off). Feed `secondsOn` to the
 * lamp type's warmup() for flux and colour.
 */
export function lampState(index, simMs, ephemeris, opts) {
  const on = switchOnTime(index, simMs, ephemeris, opts);
  return { lit: Number.isFinite(on), onAtMs: on, secondsOn: Number.isFinite(on) ? (simMs - on) / 1000 : NaN };
}

// ---------------------------------------------------------------- the switch-on table, for shaders
/** log10 of the threshold lux the table starts at, its step and its length: 10^-0.6 (0.25 lux) to 10^3.0. The
 * thresholds of switchThresholdLux lie in 0.4 .. 640 lux (u clamped to 1e-4 .. 1 - 1e-4 with the defaults). */
export const ON_TABLE = Object.freeze({ log0: -0.6, step: 0.1, n: 37 });

/**
 * Switch-on times by threshold, for a shader or a worker to read per lamp instead of calling switchOnTime: for
 * each threshold 10^(log0 + i step) lux, the moment the ambient light last fell through it (this evening's crossing,
 * or the previous evening's when this evening's is still ahead), exactly as switchOnTime decides. The crossings
 * are worked out once per local day and kept, so a frame costs a few comparisons.
 * @param {{ sun: Function, timeOfSunElevation: Function, solarNoon: (ms: number) => number }} ephemeris
 * @returns {(simMs: number, out?: Float32Array) => Float32Array} seconds since switch-on for each entry (negative
 *   or NaN where the crossing is ahead or there is none); a lamp's own value is the linear interpolation in log10 lux
 */
const RECHECK_MS = 10 * 60000;
export function createOnTable(ephemeris, { log0, step, n } = ON_TABLE) {
  let key = NaN, today = null, before = null, checkedAt = NaN;
  const els = Array.from({ length: n }, (_, i) => elevationForLux(10 ** (log0 + i * step)));
  return function secondsOn(simMs, out = new Float32Array(n)) {
    // which local day it is costs a time-zone conversion: asked again only when the clock has moved RECHECK_MS.
    // A late answer near midnight changes nothing: either day's crossings give the same last evening then.
    if (!(Math.abs(simMs - checkedAt) < RECHECK_MS)) {
      checkedAt = simMs;
      const noon = ephemeris.solarNoon(simMs);
      if (noon !== key) { key = noon; today = null; }
    }
    if (!today) {
      today = els.map((el) => ephemeris.timeOfSunElevation(el, simMs, true));
      before = els.map((el) => ephemeris.timeOfSunElevation(el, simMs - DAY_MS, true));
    }
    for (let i = 0; i < n; i++) {
      const t = today[i] <= simMs ? today[i] : before[i];
      out[i] = t <= simMs ? (simMs - t) / 1000 : NaN;
    }
    return out;
  };
}

/** A lamp's seconds since switch-on from the table (the shader's lookup): linear in log10 of its threshold. */
export function secondsOnFromTable(table, thresholdLux, { log0, step, n } = ON_TABLE) {
  const f = Math.min(Math.max((Math.log10(thresholdLux) - log0) / step, 0), n - 1);
  const i = Math.min(Math.floor(f), n - 2), t = f - i;
  return table[i] * (1 - t) + table[i + 1] * t;
}

/**
 * The share of lamps in a slice [u0, u1) of the hash that is lit at an ambient illuminance, and the threshold of
 * the lamp in the middle of the lit part (its switch-on time stands for the slice's warm-up). For the pool maps,
 * which hold the light of many lamps per texel in a few slices.
 */
export function sliceLit(ambient, u0, u1, { midLux = SWITCH_MID_LUX, spread = SWITCH_SPREAD } = {}) {
  // lit when T(u) = mid (u / (1 - u))^spread > ambient, i.e. u > q / (1 + q) with q = (ambient / mid)^(1 / spread)
  const q = ambient > 0 ? (ambient / midLux) ** (1 / spread) : 0;
  const us = q / (1 + q);
  const lo = Math.max(u0, us);
  if (lo >= u1) return { share: 0, midThresholdLux: NaN };
  const um = Math.min(1 - 1e-4, Math.max(1e-4, (lo + u1) / 2));
  return { share: (u1 - lo) / (u1 - u0), midThresholdLux: midLux * (um / (1 - um)) ** spread };
}

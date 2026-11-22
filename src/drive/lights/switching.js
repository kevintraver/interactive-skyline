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

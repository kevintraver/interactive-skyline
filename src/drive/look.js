// The drive's look at a moment (plan 02; third stretch, decision 5): the sky, the light, the haze and the exposure are
// plan 01's, so the look is only what the parts read, computed from plan 01's environment state (lookFromEnv). Pure.
//
// The dusk curve. `dusk` runs from 0 (day) to 1 (night). It is shaped on the logarithm of the horizontal illuminance,
// because brightness is seen roughly logarithmically: u = (log E(day) - log E) / (log E(day) - log E(night)), clamped,
// then smoothstep(u) so the look leaves day and arrives at night with zero rate. The two ends are the clear sky's light
// (env.js ambientLux) at:
//   DAY_ELEVATION +6 deg (about 5,600 lux): above it, day.
//   NIGHT_ELEVATION -9 deg (about 0.12 lux, deep in nautical twilight): below it, night.
// What that gives on the clear sky (sun elevation -> dusk): +6 0, +2 0.02, 0 0.08, -2 0.25, -3 0.36, -4 0.48, -6 0.75,
// -9 1. The fastest change is between about -2 and -6 degrees, in civil twilight, where the eye sees the scene darken.

import { ambientLux } from './env.js';

/** Day above this sun elevation (degrees). */
export const DAY_ELEVATION = 6;
/** Night below this sun elevation (degrees). */
export const NIGHT_ELEVATION = -9;
/** The sun elevation, in degrees below the horizon, where the boolean `night` switches: where the old switch was. */
export const NIGHT_BELOW = 1.5;
const L_DAY = Math.log10(ambientLux(DAY_ELEVATION));
const L_NIGHT = Math.log10(ambientLux(NIGHT_ELEVATION));
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** dusk 0..1 for a sun elevation in degrees (refracted, as ephemeris.sun reports it). Monotonic, continuous. */
export function duskAt(sunElevation) {
  const u = clamp01((L_DAY - Math.log10(ambientLux(sunElevation))) / (L_DAY - L_NIGHT));
  return u * u * (3 - 2 * u);
}

/** The sun elevation (degrees) at which duskAt() equals `dusk` (0 < dusk < 1); bisection, duskAt is monotonic. */
export function elevationForDusk(dusk) {
  let a = NIGHT_ELEVATION, b = DAY_ELEVATION;
  for (let k = 0; k < 60; k++) { const m = (a + b) / 2; if (duskAt(m) > dusk) a = m; else b = m; }
  return (a + b) / 2;
}

/**
 * `night` (the boolean for the interface theme, the app's night-only extras and any part that needs a yes or no)
 * is true from this dusk on. It sits where the old switch was (sun 1.5 degrees down), which every boolean
 * consumer was tuned against: the sky is past its warm low-sun state and dimming fast, and it is before the
 * default moment (sun -3 at the reveal), so nothing that switches pops while the visitor looks at the skyline.
 */
export const NIGHT_DUSK = duskAt(-NIGHT_BELOW); // 0.19

/** @param {number} sunElevation degrees  @returns {boolean} true for the night side of the look */
export const isNightAt = (sunElevation) => duskAt(sunElevation) >= NIGHT_DUSK;

/**
 * The headlamps' dusk curve, 0..1: on from just after the sun is low, full by mid civil twilight (dusk 0.45, about
 * -3.8 degrees). 0 at dusk 0 and 1 from dusk 0.45. The look's `beams` (the rain's streaks and spray read it).
 */
export const beamsAt = (dusk) => smooth(0.03, 0.45, dusk);

/**
 * The look, from plan 01's environment state (section 11.4): { night, dusk, lights, beams, sun, ambientLux }.
 *   dusk        the curve of duskAt(), on plan 01's horizontal illuminance (state.sky.horizontalLux): 0 at or above the
 *               clear sky's light at +6 degrees, 1 at or below its light at -9
 *   lights      plan 01's switch-on of the street lights (state.lights.street)
 *   beams       beamsAt(dusk)
 *   sun         { elevation, azimuth } in degrees (apparent), from state.sun
 *   ambientLux  state.sky.horizontalLux
 * @param {{ sun: { altDeg: number, azDeg: number }, sky: { horizontalLux: number }, lights: { street: number } }} state
 * @param {{ steps?: number }} [opts] steps: round dusk and lights to 1/steps
 */
export function lookFromEnv(state, { steps = 0 } = {}) {
  const lux = Math.max(state.sky.horizontalLux, 1e-6);
  const u = clamp01((L_DAY - Math.log10(lux)) / (L_DAY - L_NIGHT));
  const exact = u * u * (3 - 2 * u);
  const round = (v) => (steps > 0 ? Math.round(v * steps) / steps : v);
  const dusk = round(exact);
  return {
    night: exact >= NIGHT_DUSK, dusk, lights: round(clamp01(state.lights.street)), beams: beamsAt(dusk),
    sun: { elevation: state.sun.altDeg, azimuth: state.sun.azDeg }, ambientLux: state.sky.horizontalLux,
  };
}

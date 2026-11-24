// Digital billboard content and the brightness of every screen the drive draws (plan 02, D7.4, section 7.9).
//
// Schedule. A digital face holds each frame for HOLD_S seconds of the content clock (clock.js) and changes with a
// quick cross-fade of FADE_S: frame k of a face shows atlas design hash32(seed ^ (k * 0x9e3779b9)) mod DESIGNS,
// with k = floor((t + phase) / HOLD_S) and the face's own phase, so neighbouring boards do not change together.
// Nevada's dwell rule is to be confirmed (section 7.9); eight seconds is the common US practice (FHWA's 2007
// guidance accepts four to ten). The face shader (roadside/billboardsFace.js) does the same in GLSL.
// Flash: one change every HOLD_S simulated seconds is 2 transitions a second of real time at 16x, one flash a second,
// under the 3 Hz of section 4.11 (tests/unit/screens/programs.test.js measures it).
//
// Brightness follows the ambient illuminance, as real displays do: the outdoor advertising industry's guideline is
// 0.3 foot-candles above ambient, about 300 cd/m^2 at night, against 5,000-7,500 cd/m^2 by day [L9]. In scene
// units at today's fixed exposure (env.js LIGHTING_UNITS) a 300-nit face would be 30, which ACES clips to white,
// hue and all, so the night level is held at NIGHT_SCALE of it until plan 01's exposure takes over: 15 cd/m^2
// equivalent, 1.5 in scene units, still the brightest thing beside the road with the guide signs. By day the
// units are 2,000 times off (env.js), so the day level is set against the day look instead: about as bright as a
// sunlit white wall (readable, not glowing). Between them the level follows log10(ambientLux).
//
// On plan 01's renderer (plan 02, third stretch, decision 6) the faces are drawn in physical units instead
// (faceLevels, display 'physical'): a digital face's white is digitalCdM2(ambient), NIGHT_NITS at night and DAY_NITS by
// day, geometric in between; a static face is printed vinyl (VINYL) under STATIC_FACE_LUX from its floodlights; both
// are multiplied by the pre-exposure in the face shader (lights/photometry.node.js). At the classic display
// (?display=classic, the parity tool) the levels are the classic ones above divided by LIGHTING_UNITS.nit, which the
// shader multiplies back, so that display draws what the classic renderer did.

import { DESIGNS, hash32 } from './art.js';

export const HOLD_S = 8;
export const FADE_S = 0.6;
/** cd/m^2 of a digital face at night and by day (industry guidance [L9]) */
export const NIGHT_NITS = 300, DAY_NITS = 6000;
/** Share of the physical night level drawn until plan 01's exposure (see the header). */
export const NIGHT_SCALE = 0.05;
/** Scene emissive of a digital face by day: about a sunlit wall of albedo 0.5 in the day look. */
export const DAY_LEVEL = 0.55;
/** Ambient illuminance (lux) at and below which a screen is at its night level, and at and above which at its day level. */
export const NIGHT_LUX = 3, DAY_LUX = 3000;
/** Average illuminance on a static face from its own floodlights (lux, ASSUMED: bulletin floodlighting of 30-60 fc). */
export const STATIC_FACE_LUX = 400;

/** Share of the light a printed face reflects at a white of the image. */
export const VINYL = 0.82;
/** Linear albedo of a face with nothing on it yet (blank white-grey vinyl). */
export const PLAIN = [0.5, 0.5, 0.48];
/**
 * Luminance of a floodlight's lens seen from outside its beam (cd/m^2, ASSUMED): a 150 W floodlight of about 18,000 lm
 * behind a 0.06 m^2 lens, sending some 300 cd back toward the road against about 30,000 cd up its beam.
 */
export const FLOOD_LENS_CDM2 = 5000;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);

/** 0 at night .. 1 by day, by the logarithm of the ambient illuminance. */
export function daylight(ambientLux) {
  const u = (Math.log10(Math.max(ambientLux, 1e-6)) - Math.log10(NIGHT_LUX)) / (Math.log10(DAY_LUX) - Math.log10(NIGHT_LUX));
  return smooth(clamp01(u));
}

/** Scene emissive level of a digital face (multiplies the content colour, linear) for an ambient illuminance. */
export function digitalLevel(ambientLux, units = { nit: 0.1 }) {
  const night = NIGHT_NITS * NIGHT_SCALE * units.nit;
  return night + (DAY_LEVEL - night) * daylight(ambientLux);
}

/**
 * Emissive of a static face lit by its floodlights (multiplies the artwork's albedo): E / pi in cd/m^2 per unit
 * albedo, scaled like the digital faces, times `lampsOn` (0..1, the lamps' switching).
 */
export function staticLevel(lampsOn, units = { nit: 0.1 }) {
  return (STATIC_FACE_LUX / Math.PI) * NIGHT_SCALE * units.nit * clamp01(lampsOn);
}

/** cd/m^2 of a digital face's white for an ambient illuminance: NIGHT_NITS at night, DAY_NITS by day, geometric between. */
export function digitalCdM2(ambientLux) {
  return NIGHT_NITS * (DAY_NITS / NIGHT_NITS) ** daylight(ambientLux);
}

/**
 * The levels a face shader multiplies by, for a renderer and display:
 *   'legacy'    the classic renderer: scene units (digitalLevel, staticLevel, the lamps' emissive intensity)
 *   'classic'   plan 01's renderer at ?display=classic: the same divided by units.nit (the shader multiplies it back)
 *   'physical'  plan 01's renderer, the shipped look: cd/m^2 per unit of image colour (digital: digitalCdM2; static: the
 *               vinyl under its floodlights, VINYL x STATIC_FACE_LUX x lampsOn / pi; lamp: FLOOD_LENS_CDM2 x lampsOn)
 * @param {{ display?: 'legacy' | 'classic' | 'physical', ambientLux: number, lampsOn: number, units?: { nit: number } }} o
 * @returns {{ digital: number, static: number, lamp: number }}
 */
export function faceLevels({ display = 'legacy', ambientLux, lampsOn, units = { nit: 0.1 } }) {
  if (display === 'physical') {
    const on = clamp01(lampsOn);
    return { digital: digitalCdM2(ambientLux), static: (VINYL * STATIC_FACE_LUX * on) / Math.PI, lamp: FLOOD_LENS_CDM2 * on };
  }
  const k = display === 'classic' ? 1 / units.nit : 1;
  return { digital: digitalLevel(ambientLux, units) * k, static: staticLevel(lampsOn, units) * k, lamp: 1.5 * lampsOn * k };
}

/** The design of frame k of a face with this seed. */
export const frameDesign = (seed, k) => hash32((seed ^ Math.imul(k, 0x9e3779b9)) >>> 0) % DESIGNS;

/**
 * What a digital face shows at content time t: { k, cur, prev, fade } (fade 0 shows prev, 1 shows cur).
 * @param {number} seed  @param {number} phase seconds  @param {number} t content seconds
 */
export function digitalFrame(seed, phase, t) {
  const u = t + phase, k = Math.floor(u / HOLD_S), into = u - k * HOLD_S;
  const fade = smooth(clamp01(into / FADE_S));
  return { k, cur: frameDesign(seed, k), prev: frameDesign(seed, k - 1), fade };
}

/** Mean colour (linear, level 1) of a digital face at content time t, from the atlas means. */
export function digitalMean(means, seed, phase, t, out = [0, 0, 0]) {
  const { cur, prev, fade } = digitalFrame(seed, phase, t);
  for (let c = 0; c < 3; c++) out[c] = means[prev * 3 + c] + (means[cur * 3 + c] - means[prev * 3 + c]) * fade;
  return out;
}

/** A face's phase (seconds) from its seed, spread over a hold. */
export const phaseOf = (seed) => (hash32(seed ^ 0x27d4eb2f) / 4294967296) * HOLD_S;

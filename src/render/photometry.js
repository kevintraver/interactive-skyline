// The legacy look in physical units (plan 01, section 7.2; task T2.5). Pure: numbers in, numbers out, unit-tested.
//
// Light is authored in lux and cd/m2 and multiplied by the exposure before it reaches the HDR buffer. The legacy
// sky's keyframes (T1.4) still decide colour and how light falls through dusk; this file gives them sizes:
//   the Sun     100,000 lux at high altitude, falling with the keyframes' sun power (2.7 by day, 1.6 at sunset)
//   the sky     the environment's clear-sky ambient table (about 15,000 lux at noon, 0.0006 lux at night)
//   the Moon    0.25 lux full (the pinned night's stand-in moon is a full Moon); in the clock state the ephemeris's
//   the city    1 lux of ambient light at 4000 K where the street lights are on: an interim stand-in for the light a
//               lit city throws on itself, until phase 4 computes it from the night-lights product
//   windows     60 cd/m2 average, +-50 % by hash; `_GLOW` 30 cd/m2 per unit (7.12 said 200, see below); LED skins
//               1,200 cd/m2, dimmed to 3 % at night (section 7.12 said a quarter); street glow on the ground 2.2 cd/m2
//               at the legacy near-grid value
// These are working numbers; phase 4 calibrates the city's light end to end (section 7.8). The stability pass (plan 01,
// after phase 2) set the city light, the glow, the LED dimming and the street glow so the night reads as the classic
// night did (dark walls, windows that glow against them, coloured signs, a dim ground): 3 lux lit every wall a mid
// tone, 80 cd/m2 a unit made the models' glowing facades as bright as their windows, 300 cd/m2 blew the LED skins and
// the Sphere out to white; the ground's glow rose as the night's exposure fell (src/render/exposure.js, eyeKey).
import { ev100FromLuminance } from '../core/units.js';

export const PHOTOMETRY = {
  sunLux: 100000,
  sunPowerDay: 2.7, // the legacy keyframes' sun power at and above 10 degrees
  fullMoonLux: 0.25,
  cityLux: 1,
  // the prior's share of the city's own emission seen by the camera (windows, signs) at full switch-on, calibrated so
  // that the meter's offset from the prior is about the same by night as by day over the baseline views (measured on
  // the reference M4, phase 2: by day +0.05 to +0.4 EV); interim, until phase 4 knows the city's emission
  cityEmissionLux: 1,
  cityKelvin: 4000,
  windowCdM2: 60,
  // section 7.12 said 200; that lit whole facades of the hand-made models at 20 cd/m2 and more. Phase 2 used 80 (the
  // classic look's ratio to a window, 1 / 0.75), which after tone mapping drew glowing facades as light as their
  // windows; 30 reads as the classic night did
  glowCdM2PerUnit: 30,
  ledCdM2: 1200,
  ledNightDim: 0.03,
  streetCdM2: 2.2, // at the legacy near-grid street glow of 0.26
  streetLegacyNear: 0.26,
};

const DEG = Math.PI / 180;

/**
 * Physical lights from the legacy sky's classic values and the environment state.
 * @param {{ keyBody: 'sun'|'moon'|'none', keyWeight: number, sunPower: number }} classic  what the legacy sky set
 * @param {{ pinned: boolean, moonLux: number, ambientLux: number, street: number }} env
 * @returns {{ keyLux: number, ambientLux: number, cityLux: number }}
 */
export function physicalLights(classic, { pinned, moonLux, ambientLux, street }) {
  let keyLux = 0;
  if (classic.keyBody === 'sun') keyLux = PHOTOMETRY.sunLux * (classic.sunPower / PHOTOMETRY.sunPowerDay) * classic.keyWeight;
  else if (classic.keyBody === 'moon') keyLux = (pinned ? PHOTOMETRY.fullMoonLux : moonLux) * classic.keyWeight;
  return { keyLux, ambientLux, cityLux: PHOTOMETRY.cityLux * street, emissionLux: PHOTOMETRY.cityEmissionLux * street };
}

/**
 * The prior of section 7.2: the average luminance a meter would see, predicted from the light,
 * L = 0.2 (E_key max(sin alt, 0) + E_sky + E_city) / pi, and its EV100. In T2.5 this is the exposure table by solar
 * altitude; T2.6 meters the frame and keeps the result within -3 and +2 EV of it.
 */
export function priorLuminance({ keyLux, keyAltDeg, ambientLux, cityLux, emissionLux = 0 }) {
  return (0.2 * (keyLux * Math.max(Math.sin(keyAltDeg * DEG), 0) + ambientLux + cityLux + emissionLux)) / Math.PI;
}
export const priorEv100 = (o) => ev100FromLuminance(Math.max(priorLuminance(o), 1e-6));

/** Exposure from EV100 (Lagarde and de Rousiers, eq. 69 and listing 28): 1 / (1.2 x 2^EV100). */
export const exposureFromEv100 = (ev) => 1 / (1.2 * 2 ** ev);
export const ev100FromExposure = (k) => Math.log2(1 / (1.2 * k));

/** Window luminance factor for a hash in 0..1: 60 cd/m2 on average, +-50 %. */
export const windowCdM2 = (hash) => PHOTOMETRY.windowCdM2 * (0.5 + hash);

/** An LED skin's luminance: 1,200 cd/m2 by day, dimmed with the signs' switch-on state at night. */
export const ledCdM2 = (signs) => PHOTOMETRY.ledCdM2 * (1 + (PHOTOMETRY.ledNightDim - 1) * signs);

/** The ground's street glow in cd/m2 from the legacy sky's street value for a grid. */
export const streetCdM2 = (legacyStreet) => (legacyStreet / PHOTOMETRY.streetLegacyNear) * PHOTOMETRY.streetCdM2;

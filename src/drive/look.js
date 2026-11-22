// The drive's look at a moment: a continuous blend between the app's day and night looks, driven by the sun
// (plan 02, "Decisions for the second stretch": Dusk). A stand-in for plan 01's physical sky. Pure: the look is a
// function of the sun's elevation and azimuth only, so every frame is a pure function of simulation time.
//
// The curve. `dusk` runs from 0 (the app's DAY look, exactly) to 1 (its NIGHT look, exactly). It is shaped on the
// logarithm of the horizontal illuminance (env.js ambientLux, Schlyter's clear-sky table), because brightness is
// seen roughly logarithmically: u = (log E(day) - log E) / (log E(day) - log E(night)), clamped, then smoothstep(u)
// so the look leaves day and arrives at night with zero rate (no kink at either end).
//   DAY_ELEVATION +6 deg (about 5,600 lux): above it the app's day look, unchanged.
//   NIGHT_ELEVATION -9 deg (about 0.12 lux, deep in nautical twilight): below it the app's night look.
// What that gives (sun elevation -> dusk): +6 0, +2 0.02, 0 0.08, -2 0.25, -3 0.36, -4 0.48, -6 0.75, -9 1.
// The fastest change is between about -2 and -6 degrees, in civil twilight, where the eye sees the scene darken.
//
// The sky goes through key states along dusk (KEYS): DAY, a low sun with a warm horizon, civil twilight with a
// deep blue zenith and an orange band on the sun's side, late twilight, NIGHT. Between keys the colours mix
// linearly in sRGB and the intensities linearly, so every field is continuous in dusk and hence in time.

import { ambientLux } from './env.js';
import { DAY, NIGHT } from '../sky/legacySky.js';

/** The app's day look above this sun elevation (degrees). */
export const DAY_ELEVATION = 6;
/** The app's night look below this sun elevation (degrees). */
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
 * How far the artificial light is on, 0..1, by dusk: the shared `night` uniform (lit windows, LED skins) and the street
 * glow on the ground. 0 at dusk 0 and 1 at dusk 1, exactly.
 * It rises through civil twilight, ahead of the sky, because lit windows and signs read against a darkening facade
 * long before the sky is dark: about half on at the default moment (dusk 0.35), all on by the end of civil twilight.
 */
export const lightsAt = (dusk) => smooth(0.03, 0.66, dusk);

/**
 * How far the drive's own night glows are on, 0..1, by dusk: the road's and the signs' and delineators' emissive
 * terms, which stand in for the car's headlights on the pavement and on retroreflective sheeting. Drivers switch
 * headlights on around sunset, and the night look's road owes most of its brightness to this glow, so it leads the
 * other lights: on from just after the sun is low, full by mid civil twilight (dusk 0.45, about -3.8 degrees).
 * Without the lead the road in twilight is darker than the road at night. 0 at dusk 0 and 1 from dusk 0.45.
 */
export const beamsAt = (dusk) => smooth(0.03, 0.45, dusk);

/** Hex colour to sRGB [r, g, b] in 0..1, as THREE.Color.setHex reads it. */
export const rgbOf = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

// The key states. The colour fields are the legacy sky's (haze = horizon and fog, zenith, the hemisphere light's
// sky and ground colours, the directional light's colour); `glow` is the warm band low on the sun's side of the
// dome and `glowAmount` how strongly it shows (0 in the app's own looks); `sunPower` is the sun's directional
// light while it is up (it also fades with the sun's elevation, see sunLightAt).
export const KEYS = [
  { dusk: 0, ...DAY, glow: 0xffd2a0, glowAmount: 0 },
  // low sun, about +1 degree: a warm, hazy horizon and an orange sun, the sky still blue overhead
  { dusk: 0.05, haze: 0xe4cfb2, zenith: 0x4a7cbf, skyLight: 0xe6dccb, groundLight: 0x8b7d68, hemi: 0.72, sun: 0xffb36b, sunPower: 2.1, glow: 0xffa860, glowAmount: 0.55 },
  // civil twilight, about -3.5 degrees: deep blue zenith, a mauve-blue horizon, an orange band in the west
  { dusk: 0.42, haze: 0x8a90ae, zenith: 0x183c9e, skyLight: 0x7a86b4, groundLight: 0x5a4c3e, hemi: 0.66, sun: 0xff9a5a, sunPower: 0, glow: 0xff8c48, glowAmount: 0.9 },
  // late twilight, about -6.3 degrees: indigo overhead, the band gone to a low red glow
  { dusk: 0.78, haze: 0x4a4c6e, zenith: 0x0b173e, skyLight: 0x3c4a7c, groundLight: 0x4a3a2c, hemi: 0.44, sun: NIGHT.sun, sunPower: 0, glow: 0xb85a40, glowAmount: 0.35 },
  { dusk: 1, ...NIGHT, glow: 0xb85a40, glowAmount: 0 },
];
const COLOURS = ['haze', 'zenith', 'skyLight', 'groundLight', 'sun', 'glow'];
const NUMBERS = ['hemi', 'sunPower', 'glowAmount'];

/** The sky state at a dusk: KEYS interpolated. Colours as sRGB [r, g, b] in 0..1. */
export function skyAt(dusk) {
  const d = clamp01(dusk);
  let i = 0;
  while (i < KEYS.length - 2 && d > KEYS[i + 1].dusk) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp01((d - a.dusk) / (b.dusk - a.dusk));
  const out = {};
  for (const k of COLOURS) {
    const ca = rgbOf(a[k]), cb = rgbOf(b[k]);
    // t = 0 and t = 1 return the key's own numbers exactly, so the ends are the app's looks bit for bit
    out[k] = t === 0 ? ca : t === 1 ? cb : ca.map((v, j) => v + (cb[j] - v) * t);
  }
  for (const k of NUMBERS) out[k] = t === 0 ? a[k] : t === 1 ? b[k] : a[k] + (b[k] - a[k]) * t;
  return out;
}

/**
 * The directional light. While the sun is up it is the sun, from the ephemeris' direction, with the key states'
 * colour and power, fading out as the disc sets (gone 0.8 degrees below the horizon, when the upper limb drops
 * under the refracted horizon). Through the second half of twilight (dusk 0.5 on, about -4.2 degrees) the night
 * look's moon stand-in fades in, from the map's fixed
 * direction, reaching the night look's own power at dusk 1. The two never overlap, so the direction can change
 * hands while the light is off. @returns {{ source: 'sun'|'moon'|'none', weight: number }}
 */
export function sunLightAt(sunElevation, dusk) {
  const sun = smooth(-0.8, 3, sunElevation);
  if (sun > 0) return { source: 'sun', weight: sun };
  const moon = smooth(0.5, 1, dusk);
  return moon > 0 ? { source: 'moon', weight: moon } : { source: 'none', weight: 0 };
}

/**
 * How dark the sun's shadows are, 0..1 (three's LightShadow.intensity): 1 above SHADOW_FULL degrees, fading to 0 at
 * SHADOW_GONE. Near the horizon a tower's shadow is dozens of times its height, so the half-degree steps in which the
 * shadow map follows the sun (skyblend.js) would move shadows kilometres at once; real low-sun shadows are also faint
 * and diffuse, the sky lighting what the sun no longer does. 1 in the app's day look, exactly.
 */
export const SHADOW_FULL = 10, SHADOW_GONE = 2;
export const shadowAt = (sunElevation) => smooth(SHADOW_GONE, SHADOW_FULL, sunElevation);

/**
 * The whole look at a sun position.
 * @param {{ elevation: number, azimuth: number }} sun degrees (azimuth clockwise from north)
 * @param {{ steps?: number }} [opts] steps: round dusk to 1/steps (0 or absent: not rounded). Rounding keeps the
 *   look a pure function of time while letting the caller re-apply it only when it changes.
 * @returns {{ night: boolean, dusk: number, lights: number, beams: number, sun: { elevation: number, azimuth: number },
 *   ambientLux: number, sky: ReturnType<typeof skyAt>, light: { source: string, weight: number, color: number[], intensity: number, shadow: number },
 *   street: number[] }}
 *   sky: the dome, haze and hemisphere; light: the directional light (intensity already weighted); street: the
 *   ground's street glow (near-grid and far-grid emissive intensity, before the imagery factor).
 */
export function lookAt(sun, { steps = 0 } = {}) {
  const elevation = Number(sun.elevation), azimuth = Number(sun.azimuth) || 0;
  const exact = duskAt(elevation);
  const dusk = steps > 0 ? Math.round(exact * steps) / steps : exact;
  const lights = lightsAt(dusk);
  const sky = skyAt(dusk);
  const src = sunLightAt(elevation, dusk);
  const light = src.source === 'sun'
    ? { ...src, color: sky.sun, intensity: sky.sunPower * src.weight, shadow: shadowAt(elevation) }
    : { ...src, color: rgbOf(NIGHT.sun), intensity: src.weight === 1 ? NIGHT.sunPower : NIGHT.sunPower * src.weight, shadow: 1 };
  // the night look's light at dusk 1 is the moon at exactly NIGHT.sunPower; by day the sun at exactly DAY.sunPower
  return {
    night: exact >= NIGHT_DUSK, dusk, lights, beams: beamsAt(dusk), sun: { elevation, azimuth }, ambientLux: ambientLux(elevation), sky, light,
    street: NIGHT.street.map((v) => (lights === 1 ? v : v * lights)),
  };
}

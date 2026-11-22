// The wet road's rules (plan 02, D8.1) in JavaScript: what wet.glsl.js computes per fragment and what the weather part
// hands the reflected twins (sprites.glsl.js), function for function, for the tests and the CPU. Pure. Change both
// together.
//
// Numbers:
//  WET_DIFFUSE 0.55  wet over dry diffuse reflectance of asphalt. ASSUMED, after Lekner and Dorf, "Why some things are
//                    darker when wet" (Applied Optics 27(7), 1988), whose film model gives about half for a dark,
//                    rough, absorbing surface; the desert ground soaks rather than films (GROUND, 0.7).
//  WET_RETRO 0.15    the share of a marking's retroreflection left when it is wet. Recalled, not re-opened: wet-recovery
//                    measurements (ASTM E2177) of ordinary beaded paint keep roughly a tenth to a fifth of the dry
//                    coefficient (Texas Transportation Institute's wet-night visibility studies for FHWA and TxDOT,
//                    report 0-5008, about 2007); the beads drown under the film.
//  GLOSS 0.5         share of a mirror the film reaches on the pavement (the film is broken by the texture's peaks and
//                    by the rain's ripples), for the sky's sheen; 0.15 on the ground and the dirt. The lamps' twins
//                    take 0.7 (GLOSS.twin): their spread already stands for the roughness. ASSUMED.
//  Water cover       clamp(wetness x (1 + path), 0, 1), where path is the wheel paths' wear (atlas.js wearAt: 1 in a
//                    path, 0 on the crown): the ruts fill first and at wetness 0.5 they are covered while the crown is
//                    half covered. ASSUMED.
//  Facet slope       0.05 + 0.08 x (1 - wetness) radians rms: a damp road's streaks are long and soft, a flooded
//                    one's sharper. ASSUMED; with it a street lamp's twin reaches some 15 degrees toward the viewer.
//  Fresnel           water, n = 1.333, unpolarised (spriteMirror.js twinFresnel).

import { twinFresnel } from '../lights/spriteMirror.js';
import { WEAR } from '../roadnet/atlas.js';

export const WET_DIFFUSE = 0.55;
export const WET_RETRO = 0.15;
export const GLOSS = Object.freeze({ road: 0.5, ground: 0.15, twin: 0.7 });
export const GROUND_DIFFUSE = 0.7;
export { twinFresnel as fresnelWater };

/** Wheel-path wear across a lane region (atlas.js wearAt's path term), t in 0..1. */
export function pathWear(t) {
  const g = (m) => Math.exp(-0.5 * ((t - m) / WEAR.pathSigma) ** 2);
  return Math.max(g(WEAR.paths[0]), g(WEAR.paths[1]));
}

/** Water's share of the pavement at a point: wetness (0..1) and the point's wheel-path wear (0..1). */
export const waterCover = (wetness, path = 0) => Math.min(1, Math.max(0, wetness * (1 + path)));

/** The mean water cover across a lane (what the twins use), by integrating waterCover over t. */
export function meanCover(wetness) {
  if (!(wetness > 0)) return 0;
  let s = 0;
  const n = 64;
  for (let i = 0; i < n; i++) s += waterCover(wetness, pathWear((i + 0.5) / n));
  return s / n;
}

/** The rms facet slope of the wet surface (radians) for a wetness. */
export const facetSlope = (wetness) => 0.05 + 0.08 * (1 - Math.min(1, Math.max(0, wetness)));

/**
 * Mirrors the `wet` term's arithmetic on one fragment (wet.glsl.js wetBody).
 * @param {{ wetness: number, path?: number, normalY?: number, cosView: number, kind?: 'road'|'ground'|'dirt',
 *   sky: number[], diffuse?: number[], slE?: number[], slL?: number[] }} f
 *   diffuse: three's reflected diffuse light so far (direct + indirect) as one colour; slE, slL: the other terms'
 * @returns {{ cover: number, k: number, diffuse: number[], slE: number[], slL: number[] }}
 */
export function wetFragment({ wetness, path = 0, normalY = 1, cosView, kind = 'road', sky, diffuse = [0, 0, 0], slE = [0, 0, 0], slL = [0, 0, 0] }) {
  if (!(wetness > 0)) return { cover: 0, k: 1, diffuse: diffuse.slice(), slE: slE.slice(), slL: slL.slice() };
  const flat = smoothstep(0.5, 0.9, normalY);
  const cover = waterCover(wetness, kind === 'road' ? path : 0) * flat;
  const ratio = kind === 'ground' ? GROUND_DIFFUSE : WET_DIFFUSE; // 'dirt': the road material's dirt region
  const gloss = kind === 'road' ? GLOSS.road : GLOSS.ground;
  const F = twinFresnel(Math.min(1, Math.max(0, cosView)));
  const k = 1 - cover * (1 - ratio);
  const kE = k * (1 - cover * F);
  const kL = 1 - cover * (1 - WET_RETRO);
  return {
    cover, k,
    diffuse: diffuse.map((c) => c * k),
    slE: slE.map((c) => c * kE),
    slL: slL.map((c, i) => c * kL + sky[i] * cover * gloss * F),
  };
}

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

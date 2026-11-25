// Pure data the traffic's materials (material.js, ribbon.js, pools.js) share. No shader code, no
// three.js.

import { LAMP_CD, LENS_M } from './lamps.js';

/** Per-vertex `_lamp` values (renderCore.js makes them from the lens colours baked in the model). */
export const LAMP = Object.freeze({ none: 0, head: 1, tail: 2 });

/**
 * A pull toward the eye in depth, a share of the distance: the reference the contact shadows' and the pools' pulls are
 * set from (the pavement itself has none with reversed depth: roadnet/material.js).
 */
export const PAVEMENT_PULL = 4e-4;
/** The contact shadows' pull, so they win over the pavement at any distance. */
export const SHADOW_PULL = PAVEMENT_PULL * 1.6;
/** The headlamp pools' pull: a little more than the shadows'. */
export const POOL_PULL = SHADOW_PULL * 1.2;

/**
 * The lamp faces' default luminance, cd/m^2 (material.js createTrafficUniforms; the traffic part sets the faces from
 * physicalFaceCdM2). A look, not a measurement: a real LED head lamp's lens is some 10^5 cd/m^2 or more.
 */
export const LAMP_FACE_CDM2 = Object.freeze({ head: 60, tail: 9, brake: 22 });
/**
 * The lamp faces' luminance (third stretch, decision 6), cd/m^2: each lamp's on-axis intensity
 * over its lens's area (lamps.js LAMP_CD, LENS_M), so a face shows the light its sprite carries. The brake value is
 * the stop lamp's alone (the shader adds the tail's while the lamps are on).
 */
export function physicalFaceCdM2() {
  const area = (d) => (Math.PI * d * d) / 4;
  return { head: LAMP_CD.head / area(LENS_M.head), tail: LAMP_CD.tail / area(LENS_M.tail), brake: LAMP_CD.stop / area(LENS_M.tail) };
}
/** The lamp faces' colours (linear). */
export const HEAD_FACE_RGB = Object.freeze([1.0, 0.94, 0.82]);
export const TAIL_FACE_RGB = Object.freeze([1.0, 0.012, 0.006]);
/** Contact-shadow alpha at the centre by day (material.js createTrafficUniforms uStrength). */
export const SHADOW_STRENGTH = 0.6;

// headlamp pools (pools.js)
export const MAX_POOLS = 32;
/** Vehicles farther than this (m) get no pool: by then it is a few pixels of faint road. */
export const POOL_RANGE_M = 160;
export const POOL_LENGTH_M = 60;
/** Reflectance of the pavement (asphalt, ASSUMED). */
export const ASPHALT_RHO = 0.12;

// The pool shader's model in JavaScript (poolBeam, poolIlluminance, poolLuminance), for tests and the CPU.
const DEG = 180 / Math.PI;
/** The pool shader's low beam (cd) at beta degrees below the horizontal and phi to the side. */
export function poolBeam(beta, phi) {
  return 12000 * Math.exp(-(((beta - 1.2) / 1.6) ** 2)) * Math.exp(-((phi / 10) ** 2))
    + 3000 * Math.exp(-(((beta - 3) / 4) ** 2)) * Math.exp(-((phi / 28) ** 2));
}
/**
 * Illuminance (lux) on the road at (across, along) metres from a vehicle's front, from both lamps; on a wet road
 * (cover: the water's share of the pavement) each lamp's less what glances off the film, 1 - cover x F(incidence).
 * `fresnel(cosi)` is the water's Fresnel reflectance (weather/wetMirror.js fresnelWater).
 */
export function poolIlluminanceWith(fresnel, across, along, halfSpacing = 0.5, height = 0.65, cover = 0) {
  let E = 0;
  for (const x0 of [-halfSpacing, halfSpacing]) {
    const gx = across - x0, gy = along;
    const flat2 = gx * gx + gy * gy, r2 = flat2 + height * height;
    const beta = Math.atan2(height, Math.sqrt(flat2)) * DEG;
    const phi = Math.atan2(gx, Math.max(gy, 1e-3)) * DEG;
    const cosi = height / Math.sqrt(r2);
    E += ((poolBeam(beta, phi) * cosi) / r2) * (1 - cover * fresnel(cosi));
  }
  return E;
}

// The classic display on plan 01's renderer (?display=classic: ACES at exposure 1, no bloom) for the traffic's lights
// that the classic renderer tone-mapped in their own shader (the lane ribbons, the valley's ribbons: ribbon.glsl.js,
// valley.glsl.js) and wrote to the canvas untouched. Plan 01's output pass tone-maps every pixel, so such a light hands
// it the scene value that ACES turns back into the classic value: toScene(), the inverse of three's
// acesFilmicToneMapping (src/nodes/display/ToneMappingFunctions.js). Both pass through the same sRGB encoding, so it is
// left out. Test use: the shipped look writes scene light and does not need this; it goes with the GLSL path.
import { Matrix3 } from 'three';
import { Fn, vec3, dot, sqrt, max, clamp, toneMappingExposure } from 'three/tsl';

// three's ACES matrices, rows as written in ToneMappingFunctions.js (out.r = row 0 . in)
const IN = new Matrix3().set(0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777);
const OUT = new Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
const IN_INV = IN.clone().invert(), OUT_INV = OUT.clone().invert();
const rows = (m, v) => {
  const e = m.elements; // column-major
  return vec3(dot(vec3(e[0], e[3], e[6]), v), dot(vec3(e[1], e[4], e[7]), v), dot(vec3(e[2], e[5], e[8]), v));
};
/** inverse of RRTAndODTFit, per channel: the root of a quadratic */
const fitInverse = (u) => {
  const a = u.mul(-0.983729).add(1);
  const b = u.mul(-0.432951).add(0.0245786);
  const c = u.mul(0.238081).add(0.000090537).negate();
  return b.negate().add(sqrt(max(b.mul(b).sub(a.mul(c).mul(4)), 0))).div(a.mul(2));
};

/** The scene value plan 01's ACES output pass shows as the linear display value `c` (0..1). */
export const toScene = /*@__PURE__*/ Fn(([c]) => {
  const v = fitInverse(clamp(rows(OUT_INV, clamp(c, 0, 0.999)), 0, 1.01));
  return max(rows(IN_INV, v), vec3(0)).mul(0.6).div(toneMappingExposure);
}).setLayout({ name: 'trafficClassicToScene', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });

// Light ribbons on the route's own road (plan 02, D6.4; third stretch, decision 6): beyond the lamp sprites every lane of
// both carriageways is one emissive strip out to the horizon, its light density x per-vehicle intensity: the red river
// ahead and the white one coming. One draw call. The CPU side (geometry per route; three density sets for quantised
// times, the third worked out a slice per frame) is ribbonCore.js.
//
// The strip writes scene-referred light, as the light sprites do (lights/sprites.js), and the pipeline tone-maps
// the frame. A stretch ds of a lane holding lambda ds vehicles of intensity I toward the eye gives E = lambda ds I T / d^2
// there; spread over the W x pxPerM ds pixels the strip covers, each of pa^2 steradians, that is the luminance
// L = lambda I T / (d^2 W pxPerM pa^2) at the strip's centre (a Gaussian across whose integral is W). Written as
// L x gain x lightScale: `gain` in update() is a dimensionless fade (1 in the drive), the factory's `lightScale` (a
// number or a TSL node: the pre-exposure x the lights-out slider) carries the scale from cd/m^2.
//
// The uniforms are TSL uniform nodes in the render group (set by `.value`); tDensity is a { value } holder of the
// density texture.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, varying, vec2, vec3, vec4, float, int, ivec2, uniform, textureLoad, clamp, floor, min, max, mix,
  exp, pow, dot, length, select, positionGeometry, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, renderGroup,
} from 'three/tsl';
import { createRibbonsWith } from './ribbonCore.js';

export { STEP_M, BIN_M, DENSITY_Q_MS, LAMP_H, WIDTH_PX } from './ribbonCore.js';

const PI = Math.PI;
const shared = (v) => uniform(v).setGroup(renderGroup);
const asNode = (v) => (v && v.isNode ? v : float(v ?? 1));

/**
 * The ribbon material: a strip of uWidthPx pixels across, facing the screen, and its fragment (a Gaussian across whose
 * integral is the width).
 * @param {object} u the uniforms  @param {import('three').Texture} tex the density table
 * @param {import('three/webgpu').Node} lightScale
 */
function ribbonMaterial(u, tex, lightScale) {
  const aTangent = attribute('aTangent', 'vec3'), aInfo = attribute('aInfo', 'vec4'), aTruck = attribute('aTruck', 'float');
  const s = aInfo.x;
  const row = int(aInfo.y.add(0.5));
  const ds = s.sub(u.uCarS);
  const R = select(ds.greaterThanEqual(0), u.uAhead, u.uBehind);
  const B = u.uBand.mul(R);
  const x = clamp(ds.abs().sub(R.sub(B)).div(B), 0, 1);
  const wr = x.mul(x).mul(x.mul(-2).add(3)); // 1 - the sprites' weight (lamps.js spriteWeight)

  const rel = positionGeometry.sub(cameraPosition); // relative to the eye: no large numbers on the GPU
  const d = max(length(rel), 1);
  const toEye = rel.negate().div(d);
  const c0 = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(rel, 0)).xyz, 1));
  const c1 = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(rel.add(aTangent), 0)).xyz, 1));
  const hidden = wr.lessThanEqual(0).or(c0.w.lessThan(0.05)).or(c1.w.lessThan(0.05));

  const bins = u.uBins;
  const rowAt = (sv, r) => {
    const f = clamp(sv.sub(u.uS0).div(u.uBinM), 0, bins.sub(1));
    const i = floor(f);
    const i1 = min(i.add(1), bins.sub(1));
    const t = f.sub(i);
    return mix(textureLoad(tex, ivec2(int(i), r)).x, textureLoad(tex, ivec2(int(i1), r)).x, t);
  };
  const lam = mix(rowAt(s, int(u.uRows.x).add(row)), rowAt(s, int(u.uRows.y).add(row)), u.uRows.z).mul(aInfo.w);
  const c = dot(aTangent, toEye);
  const fw = max(c, 0), bw = max(c.negate(), 0);
  const T = exp(d.negate().div(u.uVisibility)).div(d.mul(d));
  const scale = u.uGain.mul(lightScale);
  // per light: its scene light over its pixels, colour x E x scale / pa^2 (px^2 of luminance)
  const sd = (colour, E) => colour.mul(E.mul(scale).div(u.uPixelAngle.mul(u.uPixelAngle)));
  // a vehicle's lights toward the eye (lamps.js vehicleIntensity)
  const S = sd(u.uCw, u.uCd.x.mul(2).mul(pow(fw, u.uLobe.x)).mul(T))
    .add(sd(u.uCr, u.uCd.y.mul(2).mul(pow(bw, u.uLobe.y)).add(aTruck.mul(u.uLobe.w).mul(u.uCd.w).mul(pow(bw, u.uLobe.z))).mul(T)))
    .add(sd(u.uCa, u.uLobe.w.mul(u.uCd.z).mul(pow(fw, u.uLobe.z)).mul(T)).mul(aTruck));

  const p0 = c0.xy.div(c0.w).mul(u.uViewport).mul(0.5);
  const p1 = c1.xy.div(c1.w).mul(u.uViewport).mul(0.5);
  const dp = p1.sub(p0);
  const pxPerM = max(length(dp), 1e-4);
  const dir = dp.div(pxPerM);
  const perp = vec2(dir.y.negate(), dir.x);
  const rad = lam.mul(u.uLit).mul(wr).mul(S).div(pxPerM.mul(u.uWidthPx));
  const across = aInfo.z.mul(u.uWidthPx.mul(1.5));
  const offset = perp.mul(across).mul(2).div(u.uViewport).mul(c0.w);
  const vRad = varying(select(hidden, vec3(0), rad), 'vTrafficRibbonRad');
  const vAcross = varying(select(hidden, float(0), across), 'vTrafficRibbonAcross');

  const material = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  material.name = 'traffic-ribbons';
  // hidden: zero width, the quad degenerates in place
  material.vertexNode = select(hidden, c0, c0.add(vec4(offset, 0, 0)));
  material.fragmentNode = Fn(() => {
    // a Gaussian across whose integral is uWidthPx: sigma = W / sqrt(pi), peak 1
    const sigma = u.uWidthPx.mul(0.5641895835);
    const q = vAcross.div(sigma);
    const c = vRad.mul(exp(q.mul(q).negate()));
    return vec4(c, 1);
  })();
  return material;
}

/**
 * @param {{ parent: THREE.Object3D, traffic: object, laneMap: object, frame: object,
 *   lightScale?: number | import('three/webgpu').Node }} opts
 *   traffic: the route's demand (demand.js); laneMap: lanemap.js's; frame: the city's frame (world/frame.js);
 *   lightScale: physical units -> what the material writes (default 1)
 */
export function createRibbons({ parent, traffic, laneMap, frame, lightScale = 1 }) {
  return createRibbonsWith({
    parent, traffic, laneMap, frame,
    uniform: shared,
    gain0: 1,
    material: (uniforms, tex) => ribbonMaterial(uniforms, tex, asNode(lightScale)),
  });
}

// Light ribbons on the route's own road (plan 02, D6.4) as a node material for plan 01's renderer (three r187): the
// sibling of ribbon.js and ribbon.glsl.js (plan 02, third stretch, decision 2), with the same factory, options and
// returned object. tests/manual/traffic-node-shots.mjs draws both and compares them; tests/unit/traffic/
// node-parity.test.js holds their geometry and density tables equal.
//
// Beyond the lamp sprites every lane of both carriageways is one emissive strip out to the horizon, its light
// density x per-vehicle intensity: the red river ahead and the white one coming. One draw call. The CPU side
// (geometry per route; three density sets for quantised times, the third worked out a slice per frame) is
// ribbonCore.js, shared with ribbon.js. The shader is ribbon.glsl.js's in TSL; its header has the flux rule.
//
// Two ways to show the light (option `tone`):
//  - 'scene' (the shipped look, plan 01's pipeline tone-maps the frame): the strip writes scene-referred light, as the
//    light sprites do (lights/sprites.node.js). A stretch ds of a lane holding lambda ds vehicles of intensity I toward
//    the eye gives E = lambda ds I T / d^2 there; spread over the W x pxPerM ds pixels the strip covers, each of pa^2
//    steradians, that is the luminance L = lambda I T / (d^2 W pxPerM pa^2) at the strip's centre (a Gaussian across
//    whose integral is W). Written as L x gain x lightScale; no tone in the shader.
//  - 'sprite' (the classic display and the parity page): ribbon.glsl.js's display rule, per vehicle, for each of its
//    lights, the tone-mapped far sprite integrated over its profile, spread over the strip's pixels; the colour is a
//    toned display value, handed to `toScene` (the scene value the output pass shows as that).
//
// What differs from ribbon.js, deliberately:
//  - light units (decision 6): `gain` in update() is the look's fade alone (look.beams at the classic display, 1 in
//    the shipped look), not lighting.units.nit x the fade; the factory's `lightScale` (a number or a TSL node: the
//    pre-exposure x the lights-out slider in the shipped look, 0.1 at the classic display) carries the scale from
//    cd/m^2.
//  - `toScene` (option, 'sprite' only): default identity, right for linear output with no tone mapping (the parity
//    page).
//  - the uniforms are TSL uniform nodes in the render group (set by `.value`, as the GLSL ones); tDensity stays a
//    { value } holder of the density texture.

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

// ------------------------------------------------------------------ the sprite tone (ribbon.glsl.js)
const acesFit = /*@__PURE__*/ Fn(([x0]) => {
  const x = x0.div(0.6);
  const a = x.mul(x.add(0.0245786)).sub(0.000090537);
  const b = x.mul(x.mul(0.983729).add(0.4329510)).add(0.238081);
  return clamp(a.div(b), 0, 1);
}).setLayout({ name: 'trafficRibbonAces', type: 'float', inputs: [{ name: 'x', type: 'float' }] });

/** The lamp sprites' tone (lights/sprites.glsl.js toneSprite) with the vehicle layer's whitening. */
const toneSprite = /*@__PURE__*/ Fn(([c, whiten]) => {
  const y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  const o = c.mul(acesFit(y).div(max(y, 1e-30)));
  const m = max(o.x, max(o.y, o.z));
  const white = mix(o.div(max(m, 1e-30)), vec3(1), whiten.mul(m.sub(1)).div(max(m, 1e-30)));
  return select(y.lessThanEqual(0), vec3(0), select(m.greaterThan(1), white, o));
}).setLayout({ name: 'trafficRibbonTone', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }, { name: 'whiten', type: 'float' }] });

/**
 * The toned light of one far sprite of colour x illuminance E (lux), integrated over its pixels (px^2): the sprite
 * rule at minPx (a Gaussian core e^{-r^2 / a^2}, a = 0.5 minPx / sqrt(ln 2), peak L x coreNorm), as ribbon.glsl.js.
 * `scale` is the light scale x the gain (the GLSL's uGain).
 */
const spriteDisplay = /*@__PURE__*/ Fn(([colour, E, minPx, pixelAngle, scale, whiten]) => {
  const px = minPx.mul(pixelAngle);
  const solid = px.mul(px).mul(PI / 4);
  const a = minPx.mul(0.5 / 0.8325546111576977);
  const coreNorm = minPx.mul(minPx).mul(PI / 4).div(a.mul(a).mul(PI));
  const P = E.div(solid).mul(scale).mul(coreNorm);
  // integral over u = r^2 / a^2 in [0, 8], trapezoids on a stretched grid (unrolled here: the grid is constant)
  let acc = vec3(0);
  let uPrev = 0;
  let fPrev = toneSprite(colour.mul(P), whiten);
  for (let i = 1; i <= 12; i++) {
    const t = i / 12, u = 8 * t * t;
    const f = toneSprite(colour.mul(P.mul(Math.exp(-u))), whiten);
    acc = acc.add(f.add(fPrev).mul(0.5 * (u - uPrev)));
    uPrev = u; fPrev = f;
  }
  return select(E.lessThanEqual(0), vec3(0), acc.mul(a.mul(a).mul(PI)));
}).setLayout({
  name: 'trafficRibbonSprite', type: 'vec3',
  inputs: [
    { name: 'colour', type: 'vec3' }, { name: 'E', type: 'float' }, { name: 'minPx', type: 'float' },
    { name: 'pixelAngle', type: 'float' }, { name: 'scale', type: 'float' }, { name: 'whiten', type: 'float' },
  ],
});

/**
 * The ribbon material: the vertex stage of ribbon.glsl.js (a strip of uWidthPx pixels across, facing the screen)
 * and its fragment (a Gaussian across whose integral is the width).
 * @param {object} u the uniforms  @param {import('three').Texture} tex the density table
 * @param {import('three/webgpu').Node} lightScale
 * @param {((c: import('three/webgpu').Node) => import('three/webgpu').Node) | null} toScene  null: scene light, no tone
 */
function ribbonMaterial(u, tex, lightScale, toScene) {
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
  // per light: the toned far sprite integrated over its pixels ('sprite'), or its scene light over its pixels, colour x
  // E x scale / pa^2 (px^2 of luminance: the same integral without the tone, 'scene')
  const sd = toScene
    ? (colour, E) => spriteDisplay(colour, E, u.uMinPx, u.uPixelAngle, scale, u.uWhiten)
    : (colour, E) => colour.mul(E.mul(scale).div(u.uPixelAngle.mul(u.uPixelAngle)));
  // a vehicle's lights toward the eye (lamps.js vehicleIntensity), each shown as its far sprite would be
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
    // a Gaussian across whose integral is uWidthPx: sigma = W / sqrt(pi), peak 1; the colour is already toned
    const sigma = u.uWidthPx.mul(0.5641895835);
    const q = vAcross.div(sigma);
    const c = vRad.mul(exp(q.mul(q).negate()));
    return vec4(toScene ? toScene(c) : c, 1);
  })();
  return material;
}

/**
 * @param {{ parent: THREE.Object3D, traffic: object, laneMap: object, frame: object,
 *   lightScale?: number | import('three/webgpu').Node, tone?: 'scene' | 'sprite',
 *   toScene?: (c: import('three/webgpu').Node) => import('three/webgpu').Node }} opts
 *   lightScale: physical units -> what the material writes (default 1); tone and toScene: see the header (default
 *   'sprite' and identity, which the parity page compares with ribbon.js)
 */
export function createRibbons({ parent, traffic, laneMap, frame, lightScale = 1, tone = 'sprite', toScene = (c) => c }) {
  return createRibbonsWith({
    parent, traffic, laneMap, frame,
    uniform: shared,
    gain0: 1,
    material: (uniforms, tex) => ribbonMaterial(uniforms, tex, asNode(lightScale), tone === 'scene' ? null : toScene),
  });
}

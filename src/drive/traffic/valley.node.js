// The `valley` drive part (plan 02, D6.6) as a node material for plan 01's renderer (three r187): the sibling of
// valley.js and valley.glsl.js (plan 02, third stretch, decision 2), with the same factory, part and options.
// tests/manual/traffic-node-shots.mjs draws both and compares them.
//
// Traffic on the rest of the valley as light ribbons, no vehicles: every freeway and principal arterial is a pair of
// thin glowing strips on the ground, one per direction; the route being driven is left out (setRoute). Their
// brightness is the light of the vehicles on them at the moment (valleyModel.js, mirrored by the shader below as by
// valley.glsl.js: vehicles per metre x each vehicle's intensity toward the eye, white coming, red going, a pattern
// drifting at the traffic's speed): a luminance in cd/m^2. The part's CPU side is valleyCore.js, shared with valley.js.
//
// Two ways to show the light (option `tone`):
//  - 'scene' (the shipped look; parts.js on plan 01's renderer): the strip writes its luminance x lightScale, scene-
//    referred light that plan 01's pipeline tone-maps with the frame, as the light sprites do. The look's `lights`
//    fade stood in for the classic fixed exposure; here the fade is the vehicles' lit share (traffic/lamps.js
//    vehicleLitShare) at the ambient light of the moment, read each frame, so the ribbons follow the vehicles' own
//    switching and need no look.
//  - 'sprite' (the classic display and the parity page): valley.glsl.js's tone on luminance, a display value handed
//    to `toScene` (the scene value the output pass shows as that); the fade is the look's `lights`.
//
// What differs from valley.js, deliberately:
//  - light units (decision 6): uGain is the fade x the debugging gain scale, without lighting.units.nit; the option
//    `lightScale` (a number or a TSL node: the pre-exposure x the lights-out slider in the shipped look, 0.1 at the
//    classic display) carries the scale from cd/m^2. The part reads no `env.lighting.units`.
//  - detail by plan 01's quality level (option `quality`, valleyCore.js VALLEY_CLASSES).
//  - options come as a second argument, `createValleyPart(ctx, { lightScale, tone, toScene, quality })`, or as
//    ctx.lightScale and ctx.toScene. Default: 'sprite', identity, no quality: what the parity page compares.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, varying, vec2, vec3, vec4, float, int, ivec2, uniform, textureLoad, floor, fract, mod, mix, clamp,
  max, min, pow, exp, dot, cross, length, normalize, smoothstep, select, inverseSqrt, abs, positionGeometry,
  cameraPosition, cameraViewMatrix, cameraProjectionMatrix, renderGroup,
} from 'three/tsl';
import { createValleyPartWith } from './valleyCore.js';
import { vehicleLitShare } from './lamps.js';

export { NEAR_M, MIN_PX } from './valleyCore.js';
/** valley.glsl.js driftSpeed's quantum: 64 cells of 60 m an hour, m/s. */
const DRIFT_Q = (60 * 64) / 3600;

const shared = (v) => uniform(v).setGroup(renderGroup);
const asNode = (v) => (v && v.isNode ? v : float(v ?? 1));

/** three's ACES fit on luminance, keeping the hue, whitening above 1 (valley.glsl.js toneRibbon). */
const acesFit = /*@__PURE__*/ Fn(([x0]) => {
  const x = x0.div(0.6);
  const a = x.mul(x.add(0.0245786)).sub(0.000090537);
  const b = x.mul(x.mul(0.983729).add(0.4329510)).add(0.238081);
  return clamp(a.div(b), 0, 1);
}).setLayout({ name: 'valleyRibbonAces', type: 'float', inputs: [{ name: 'x', type: 'float' }] });
const toneRibbon = /*@__PURE__*/ Fn(([c]) => {
  const y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  const o = c.mul(acesFit(y).div(max(y, 1e-30)));
  const m = max(o.x, max(o.y, o.z));
  const white = mix(o.div(max(m, 1e-30)), vec3(1), m.sub(1).div(max(m, 1e-30)));
  return select(y.lessThanEqual(0), vec3(0), select(m.greaterThan(1), white, o));
}).setLayout({ name: 'valleyRibbonTone', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
/** valleyModel.js hash11 */
const hash11 = /*@__PURE__*/ Fn(([i]) => {
  const p0 = fract(i.mul(0.1031));
  const p1 = p0.mul(p0.add(33.33));
  const p2 = p1.mul(p1.add(p1));
  return fract(p2);
}).setLayout({ name: 'valleyHash11', type: 'float', inputs: [{ name: 'i', type: 'float' }] });

/** The ribbons' node material (valley.glsl.js in TSL); toScene null: scene light, no tone (see the header). */
function valleyMaterial(u, lightScale, toScene) {
  const aDir = attribute('aDir', 'vec3'), aAlong = attribute('aAlong', 'vec2'), aTraffic = attribute('aTraffic', 'vec4');
  const rel = positionGeometry.sub(cameraPosition); // relative to the eye: no large numbers on the GPU
  const d = length(rel);
  const toEye = rel.negate().div(max(d, 1e-3));
  const fade = smoothstep(u.uNear.x, u.uNear.y, d);
  const dark = fade.lessThanEqual(0).or(aTraffic.x.lessThanEqual(0));

  // flat on the ground at the carriageway's width where that is at least uMinPx wide seen from above, else a strip
  // uMinPx wide facing the eye and standing on the ground (valley.glsl.js)
  const acrossRaw = cross(aDir, toEye);
  const sinT = length(acrossRaw);
  const across = select(sinT.greaterThan(1e-4), acrossRaw.div(max(sinT, 1e-30)), vec3(0, 1, 0));
  const elev = max(toEye.y, 1e-3);
  const wMin = u.uMinPx.mul(d).mul(u.uPixelAngle);
  const onGround = aTraffic.w.mul(elev).greaterThanEqual(wMin);
  const ground = normalize(vec3(aDir.z.negate(), 0, aDir.x));
  const w = select(onGround, aTraffic.w, wMin);
  const proj = select(onGround, elev, max(sinT, 0.1));
  const half = w.mul(0.5).mul(aAlong.y);
  const pGround = rel.add(ground.mul(half));
  const pFacing = rel.add(across.mul(half)).add(vec3(0, w.mul(0.5).mul(abs(across.y)), 0));
  const p = select(onGround, pGround, pFacing);

  // light: vehicles per metre x intensity toward the eye
  const shapeAt = (row, how) => {
    const x = how.sub(0.5);
    const i = floor(x);
    const f = x.sub(i);
    const r = int(row.add(0.5));
    const a = textureLoad(u.shapes, ivec2(int(mod(i, 168)), r)).x;
    const b = textureLoad(u.shapes, ivec2(int(mod(i.add(1), 168)), r)).x;
    return mix(a, b, f);
  };
  const n = aTraffic.x.mul(shapeAt(aTraffic.y, u.uHow)).div(aTraffic.z.mul(3600));
  const c = dot(aDir, toEye);
  const head = u.uLamps.x.mul(pow(clamp(c, 0, 1), u.uLamps.y)).add(u.uLamps.z.mul(clamp(c.mul(0.5).add(0.5), 0, 1)));
  const tail = u.uLamps.w.mul(clamp(c.negate(), 0, 1));
  const k = n.div(w.mul(proj)).mul(exp(d.negate().div(u.uVisibility))).mul(fade).mul(u.uGain).mul(lightScale);
  // the drift: cells of 60 m; amplitude from the Poisson spread of the vehicles in a cell, faded out where a cell is
  // under four pixels long on the screen
  const cellPx = max(sinT, 0.05).mul(60).div(d.mul(u.uPixelAngle));
  const amp = min(0.9, inverseSqrt(n.mul(60).add(1e-6))).mul(smoothstep(1.5, 4.0, cellPx));
  const speed = max(1.0, floor(aTraffic.z.div(DRIFT_Q).add(0.5))).mul(DRIFT_Q);

  const vLight = varying(select(dark, vec2(0), vec2(head, tail).mul(k)), 'vValleyLight');
  const vU = varying(aAlong.x, 'vValleyU');
  const vSpeed = varying(select(dark, float(0), speed), 'vValleySpeed');
  const vAmp = varying(select(dark, float(0), amp), 'vValleyAmp');
  const vSide = varying(aAlong.y, 'vValleySide');

  const material = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    side: THREE.DoubleSide,
  });
  material.name = 'valley-ribbons';
  // no light here: the strip pinches to its centre line (moving the vertex away would stretch the triangles it shares
  // with lit neighbours across the screen)
  const clip = (q) => cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(q, 0)).xyz, 1));
  material.vertexNode = clip(select(dark, rel, p));
  material.fragmentNode = Fn(() => {
    const x = vU.sub(vSpeed.mul(u.uTime)).div(60);
    const i = floor(x), f = x.sub(i);
    const s = f.mul(f).mul(f.mul(-2).add(3));
    const v = mix(hash11(mod(i, 64)), hash11(mod(i.add(1), 64)), s).sub(u.uHashMean).add(0.5);
    const drift = vAmp.mul(v.mul(2).sub(1)).add(1);
    const acrossK = float(1).sub(vSide.mul(vSide)).mul(1.5); // a soft line across the strip, of mean 1
    const col = u.uHeadColor.mul(vLight.x).add(u.uTailColor.mul(vLight.y)).mul(drift.mul(acrossK));
    return vec4(toScene ? toScene(toneRibbon(col)) : col, 1);
  })();
  return material;
}

/**
 * @param {object} ctx the part context (parts.js)
 * @param {{ lightScale?: number | import('three/webgpu').Node, tone?: 'scene' | 'sprite',
 *   toScene?: (c: import('three/webgpu').Node) => import('three/webgpu').Node, quality?: object | null }} [opts]
 *   lightScale: physical units -> what the material writes (default ctx.lightScale, else 1); tone, toScene: see the
 *   header; quality: plan 01's app.quality
 */
export function createValleyPart(ctx, opts = {}) {
  const lightScale = asNode(opts.lightScale ?? ctx.lightScale ?? 1);
  const scene = (opts.tone ?? ctx.tone) === 'scene';
  const toScene = opts.toScene ?? ctx.toScene ?? ((c) => c);
  return createValleyPartWith(ctx, {
    uniform: shared,
    unit: 1,
    material: (uniforms, shapes) => valleyMaterial({ ...uniforms, shapes }, lightScale, scene ? null : toScene),
    quality: opts.quality ?? null,
    // the shipped look: the vehicles' lit share at the ambient light now (traffic/lamps.js), drawn above a thousandth
    ...(scene ? { liveFade: () => vehicleLitShare(ctx.env.lighting.ambientLux()), minFade: 1e-3 } : {}),
  });
}

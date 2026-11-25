// The `valley` drive part (plan 02, D6.6): traffic on the rest of the valley as light ribbons, no vehicles.
//
// Every freeway and principal arterial of the valley is a pair of thin glowing strips on the ground, one per
// direction, offset to the right of travel. The driven routes' own carriageways are in the file as groups by route
// (valleyFormat.js); the part leaves out the group(s) of the route being driven (setRoute), whose traffic is drawn
// as vehicles by the `traffic` part, and keeps the other routes' freeways lit.
// Their brightness is the light of the vehicles on them at the moment: vehicles per metre (daily volume x the
// hour-of-week shape / speed) x each vehicle's intensity toward the eye, white where the traffic comes toward the
// eye (head lamps), red where it goes away (tail lamps), with a pattern drifting along at the traffic's speed.
// The arithmetic is valleyModel.js, mirrored by the shader below; the data is public/data/<city>/traffic/valley.json
// + valley.bin (scripts/build_valley_traffic.py, read by valleyFormat.js), the strips valleyGeometry.js.
//
// One draw call. Per frame the part sets six uniforms (the hour of week, the drift time, the pixel angle, the
// visibility); nothing else runs on the CPU. Off by day: drawn only while the vehicles' lit share is above a
// thousandth, scaled by it (below). Faded out within NEAR_M of the eye, where a strip would read as paint on the ground and where the
// route's own traffic is drawn as vehicles anyway.
//
// Light (third stretch, decision 6): the strip writes its luminance in cd/m^2 x photometry.js artificialScale (the
// pre-exposure x the lights-out slider), scene-referred light that plan 01's pipeline tone-maps with the frame, as the
// light sprites do. The fade is the vehicles' lit share (traffic/lamps.js vehicleLitShare) at the ambient light of the
// moment, read each frame, so the ribbons follow the vehicles' own switching. Detail follows plan 01's quality level
// (valleyCore.js VALLEY_CLASSES). The part's CPU side is valleyCore.js.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, varying, vec2, vec3, vec4, float, int, ivec2, uniform, textureLoad, floor, fract, mod, mix, clamp,
  max, min, pow, exp, dot, cross, length, normalize, smoothstep, select, inverseSqrt, abs, positionGeometry,
  cameraPosition, cameraViewMatrix, cameraProjectionMatrix, renderGroup,
} from 'three/tsl';
import { createValleyPartWith } from './valleyCore.js';
import { vehicleLitShare } from './lamps.js';
import { photometryContext, artificialScale } from '../lights/photometry.js';

export { NEAR_M, MIN_PX } from './valleyCore.js';
/** The drift speed's quantum: 64 cells of 60 m an hour, m/s. */
const DRIFT_Q = (60 * 64) / 3600;

const shared = (v) => uniform(v).setGroup(renderGroup);

/** valleyModel.js hash11 */
const hash11 = /*@__PURE__*/ Fn(([i]) => {
  const p0 = fract(i.mul(0.1031));
  const p1 = p0.mul(p0.add(33.33));
  const p2 = p1.mul(p1.add(p1));
  return fract(p2);
}).setLayout({ name: 'valleyHash11', type: 'float', inputs: [{ name: 'i', type: 'float' }] });

/** The ribbons' node material (see the header). */
function valleyMaterial(u, lightScale) {
  const aDir = attribute('aDir', 'vec3'), aAlong = attribute('aAlong', 'vec2'), aTraffic = attribute('aTraffic', 'vec4');
  const rel = positionGeometry.sub(cameraPosition); // relative to the eye: no large numbers on the GPU
  const d = length(rel);
  const toEye = rel.negate().div(max(d, 1e-3));
  const fade = smoothstep(u.uNear.x, u.uNear.y, d);
  const dark = fade.lessThanEqual(0).or(aTraffic.x.lessThanEqual(0));

  // flat on the ground at the carriageway's width where that is at least uMinPx wide seen from above, else a strip
  // uMinPx wide facing the eye and standing on the ground
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
    return vec4(col, 1);
  })();
  return material;
}

/** @param {object} ctx the part context (parts.js) */
export function createValleyPart(ctx) {
  const lightScale = artificialScale(photometryContext({ nodes: ctx.env.nodes }));
  return createValleyPartWith(ctx, {
    uniform: shared,
    material: (uniforms, shapes) => valleyMaterial({ ...uniforms, shapes }, lightScale),
    quality: ctx.app?.plan01?.quality ?? null,
    // the vehicles' lit share at the ambient light now (traffic/lamps.js), drawn above a thousandth
    fade: () => vehicleLitShare(ctx.env.lighting.ambientLux()), minFade: 1e-3,
  });
}

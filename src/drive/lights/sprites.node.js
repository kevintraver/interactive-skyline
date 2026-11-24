// The light-sprite layer on plan 01's renderer (plan 02, third stretch, decisions 2 and 6): sprites.js and
// sprites.glsl.js written with three/webgpu and three/tsl. Same factory, options, methods, patterns, flux rule,
// twins and whiten, so a caller changes only its import:
//
//   import { createSpriteLayer, setTwins, TWIN_UNIFORMS } from './sprites.node.js';
//   const layer = createSpriteLayer({ capacity: 4096, name: 'vehicle-lamps', reflect: true });
//   scene.add(layer.mesh);
//   const tail = layer.definePattern({ kind: 'lobe', exponent: 2 });
//   layer.set(i, { position: [x, y, z], color: [1, 0.05, 0.02], intensity: 30, pattern: tail, axis: [0, 0, 1] });
//   layer.commit(count);
//   each frame: layer.setFrame({ camera, renderer, gain, ambientLux, onTable, visibility })
//
// Instance fields, the texel layout, the draw list and the twins are exactly sprites.js's (read its header); the
// arithmetic is sprites.glsl.js's, function for function, and its JavaScript mirror spriteMirror.js holds for both.
//
// Where it differs from sprites.js, on purpose:
//   - Light units. The sprite's radiance is cd/m^2 x photometry.node.js artificialScale(ctx) x the fade: the
//     pre-exposure and the lights-out slider in the shipped look, LIGHTING_UNITS at the classic display. setFrame
//     takes `fade` (dimensionless); a `gain` (sprites.js: LIGHTING_UNITS.nit x the fade, what every caller passes) is
//     read as fade = gain / LIGHTING_UNITS.nit, so callers' code does not change.
//   - The tone. On the new renderer the layer is drawn in the pipeline's scene pass (transparent, so after the opaque
//     geometry; additive, depth-tested, no depth write) and writes linear HDR radiance: the pipeline's tone mapping
//     and bloom treat it as everything else, and `whiten` is unused. `tone: 'sprite'` applies sprites.glsl.js's own
//     tone (ACES on luminance, `whiten` of the clipping excess turned white) for drawing straight to a canvas without
//     a tone-mapping pass, which is what the parity page compares with the GLSL layer.
//   - The pixel size and viewport are read from the render target being drawn (screenSize and the projection), not
//     from setFrame's renderer, so a pipeline drawing at a render scale gets the right flux; camera and renderer are
//     accepted and ignored.
//   - commitRows uploads whole instance textures: three r187's WebGPURenderer has no partial texture upload.
//   - The pixel's solid angle is taken where the sprite is: pa^2 cos^3 off the camera's axis (spriteData.js
//     pixelAngleOffAxis), so a sprite anywhere on the screen carries I / d^2. sprites.glsl.js takes the centre's pa^2
//     everywhere, which loses cos^3 of the light off axis (tests/manual/lights-probe.mjs found 0.859 at 18 degrees).

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, uniform, uniformArray, textureLoad, varyingProperty, cameraPosition, cameraProjectionMatrix, cameraViewMatrix,
  screenSize, int, ivec2, float, vec2, vec3, vec4, select, exp, pow, max, min, clamp, length, dot, acos, atan, cos, sin, log, sqrt,
  abs, mix, floor, normalize,
} from 'three/tsl';
import { SPRITE_TEX_WIDTH, MAX_PATTERNS, ON_TABLE_N, PATTERN, TWIN_FOOT, TWIN_LIST_M, TWIN_RELIST_M } from './spriteData.js';
import { ON_TABLE } from './switching.js';
import { LUMINAIRE_DIAMETER_M } from './lamps.js';
import { photometryContext, artificialScale, LIGHTING_UNITS } from './photometry.node.js';

export { TWIN_LIST_M, TWIN_RELIST_M, TWIN_FOOT, PATTERN };

const ALWAYS_ON = 1e30;
const TWIN_CELL_M = 64;
const GRID_SLICE = 8192;
const RAD = 0.017453292519943295;
const W = SPRITE_TEX_WIDTH;

/** Uniforms shared by every reflecting layer's twins (see setTwins); TSL uniform nodes, whose `.value` is as sprites.js's. */
export const TWIN_UNIFORMS = {
  uTwinWet: uniform(0).setName('uTwinWet'),
  uTwinSlope: uniform(0.05).setName('uTwinSlope'),
  uTwinRoad: uniform(new THREE.Vector4(0, 0, 0, -1)).setName('uTwinRoad'),
  uTwinPlane: uniform(new THREE.Vector4(0, 0, 24, 300)).setName('uTwinPlane'),
};
const twinLayers = new Set();

/** The twins of every reflecting node layer: as sprites.js setTwins. */
export function setTwins({ wet, slope, car, forward, roadY, grade, halfWidth, range }) {
  const u = TWIN_UNIFORMS;
  u.uTwinWet.value = wet > 0 ? Math.min(1, wet) : 0;
  if (slope > 0) u.uTwinSlope.value = slope;
  if (car && forward) {
    const n = Math.hypot(forward.x, forward.z) || 1;
    u.uTwinRoad.value.set(car.x, car.z, forward.x / n, forward.z / n);
  }
  const pl = u.uTwinPlane.value;
  if (Number.isFinite(roadY)) pl.x = roadY;
  if (Number.isFinite(grade)) pl.y = grade;
  if (halfWidth > 0) pl.z = halfWidth;
  if (range > 0) pl.w = range;
  for (const l of twinLayers) l.twinFrame();
}

// ---------------------------------------------------------------- the shader's functions (sprites.glsl.js)
// Plain functions that build nodes; each is the GLSL function of the same name.

const smoothstep01 = (a, b, x) => { const t = clamp(x.sub(a).div(float(b).sub(a)), 0, 1); return t.mul(t).mul(t.mul(-2).add(3)); };
const wing = (t, peak, width) => { const u = t.sub(peak).div(width); return exp(u.mul(u).negate()); };
/** GLSL mod for floats (x - y floor(x / y)); WGSL's % truncates. */
const fmod = (x, y) => x.sub(floor(x.div(y)).mul(y));

/** lamps.js OPTICS; theta and phi in degrees; avg (bool node) asks for the phi-average. */
function patternShape(kind, k, t, p, avg) {
  const ct = cos(t.mul(RAD)), cp = cos(p.mul(RAD)), sp = sin(p.mul(RAD));
  const over = t.greaterThan(90);
  const lobe = pow(max(ct, 0), k.z);
  // cutoff
  const latC = select(avg, float(0.65), cp.mul(cp).mul(0.7).add(0.3).mul(sp.mul(0.35).add(1)));
  const axC = select(avg, float(1), sp.mul(0.35).add(1));
  const cutoff = select(over, float(0), k.x.mul(ct.mul(0.35).mul(axC).add(wing(t, 65, 14).mul(latC))).mul(float(1).sub(smoothstep01(78, 90, t))));
  // droplens
  const latD = select(avg, float(0.675), cp.mul(cp).mul(0.65).add(0.35).mul(sp.mul(0.3).add(1)));
  const axD = select(avg, float(1), sp.mul(0.3).add(1));
  const drop = select(over, k.y.mul(wing(t, 98, 10)), k.x.mul(ct.mul(0.3).mul(axD).add(wing(t, 70, 16).mul(latD))).mul(float(1).sub(smoothstep01(84, 90, t))));
  // highmast
  const high = select(over, float(0), k.x.mul(ct.mul(0.3).add(wing(t, 60, 18))).mul(float(1).sub(smoothstep01(80, 90, t))));
  return select(kind.lessThan(0.5), float(1),
    select(kind.greaterThan(3.5), lobe,
      select(kind.lessThan(1.5), cutoff, select(kind.lessThan(2.5), drop, high))));
}

/** Gamma(1 + 2 / n) for n in [2, 6], by the shader's table. */
function gammaTerm(n) {
  const f = clamp(n.sub(2), 0, 3.999);
  const i = floor(f), t = f.sub(i);
  const g0 = select(i.lessThan(0.5), float(1), select(i.lessThan(1.5), float(0.902745), select(i.lessThan(2.5), float(0.886227), float(0.887264))));
  const g1 = select(i.lessThan(0.5), float(0.902745), select(i.lessThan(1.5), float(0.886227), select(i.lessThan(2.5), float(0.887264), float(0.89298))));
  return mix(g0, g1, t);
}

function onSeconds(threshold, onTable, onSpec) {
  const f = clamp(log(threshold).div(Math.log(10)).sub(onSpec.x).div(onSpec.y), 0, onSpec.z.sub(1));
  const i = min(int(floor(f)), int(onSpec.z).sub(2));
  const t = f.sub(float(i));
  return mix(onTable.element(i), onTable.element(i.add(1)), t);
}

function xyzFromUv(uv) {
  const d = uv.x.mul(6).sub(uv.y.mul(16)).add(12);
  const x = uv.x.mul(9).div(d), y = uv.y.mul(4).div(d);
  return vec3(x.div(y), 1, float(1).sub(x).sub(y).div(y));
}
function linearSrgbFromXyz(c) {
  return vec3(
    c.x.mul(3.2404542).sub(c.y.mul(1.5371385)).sub(c.z.mul(0.4985314)),
    c.x.mul(-0.969266).add(c.y.mul(1.8760108)).add(c.z.mul(0.041556)),
    c.x.mul(0.0556434).sub(c.y.mul(0.2040259)).add(c.z.mul(1.0572252)));
}

/** sprites.glsl.js toneSprite: three's ACES fit on luminance, hue kept, `whiten` of what would clip turned white. */
function toneSprite(c, whiten) {
  const y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  const x = y.div(0.6);
  const a = x.mul(x.add(0.0245786)).sub(0.000090537);
  const b = x.mul(x.mul(0.983729).add(0.432951)).add(0.238081);
  const o = c.mul(clamp(a.div(b), 0, 1).div(max(y, 1e-30)));
  const m = max(o.x, max(o.y, o.z));
  const white = mix(o.div(m), vec3(1), whiten.mul(m.sub(1)).div(m));
  return select(y.lessThanEqual(0), vec3(0), select(m.greaterThan(1), white, o));
}

/** The warm-up: { flux, color } (lamps.js warmup: sodium from a dim pink-white to amber). */
function warmUp(p1, p3, u) {
  const warm = p3.y.greaterThan(0.5);
  const s0 = onSeconds(p3.x, u.uOnTable, u.uOnSpec);
  const s = select(s0.greaterThanEqual(0), s0, float(0));
  const sc = s.div(140), sf = s.div(100);
  const pc = float(1).sub(exp(sc.mul(sc).negate()));
  const pf = float(1).sub(exp(sf.mul(sf).negate()));
  return {
    flux: select(warm, pf.mul(0.95).add(0.05), float(1)),
    color: select(warm, linearSrgbFromXyz(xyzFromUv(mix(u.uSodium.xy, u.uSodium.zw, pc))), p1.xyz),
  };
}

/** Intensity toward `dir` (unit, from the lamp) by the instance's pattern, theta from its axis, phi from its aim. */
function intensityToward(p0, p1, p2, dir, u) {
  const pid = int(p1.w.add(0.5));
  const kind = u.uPatKind.element(pid);
  const k = u.uPatK.element(pid);
  const theta = acos(clamp(dot(p2.xyz, dir), -1, 1)).div(RAD);
  const avg = p2.w.lessThan(-9);
  const az = atan(dir.z.negate(), dir.x).div(RAD);
  const phi = select(avg, float(0), fmod(az.sub(p2.w.div(RAD)).add(90 + 540), 360).sub(180));
  return { I: p0.w.mul(patternShape(kind, k, theta, phi, avg)), kind, k };
}

/** The four texels of the instance a drawn sprite names, and its weight. */
function fetchInstance(u) {
  const si = attribute('spriteIndex', 'vec2');
  const idx = int(si.x.add(0.5));
  const row = idx.div(W);
  const st = ivec2(idx.sub(row.mul(W)), row);
  return {
    weight: si.y,
    p0: textureLoad(u.tPos, st).toVar('spP0'),
    p1: textureLoad(u.tColor, st).toVar('spP1'),
    p2: textureLoad(u.tAxis, st).toVar('spP2'),
    p3: textureLoad(u.tSwitch, st).toVar('spP3'),
  };
}

/** Radians per pixel at the centre of the view of the target being drawn: 2 tan(fov / 2) / height. */
const pixelAngleNode = () => float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y).max(1));
/**
 * The pixel's angular size toward `rel` (eye to point, world): pa cos^1.5 of the angle off the camera's axis
 * (spriteData.js pixelAngleOffAxis), so a sprite off the screen's centre keeps its flux.
 */
const pixelAngleToward = (rel) => {
  const v = cameraViewMatrix.mul(vec4(rel, 0)).xyz;
  const c = max(v.z.negate().div(max(length(v), 1e-6)), 1e-3);
  return pixelAngleNode().mul(pow(c, 1.5));
};

// varyings of the sprites
const vPx = varyingProperty('vec2', 'vSpPx');
const vAmp = varyingProperty('vec3', 'vSpAmp');
const vShape = varyingProperty('vec4', 'vSpShape');
const vHaloNorm = varyingProperty('float', 'vSpHaloNorm');
// varyings of the twins
const vTw = varyingProperty('vec2', 'vTw');
const vTwAmp = varyingProperty('vec3', 'vTwAmp');
const vTwSig = varyingProperty('vec3', 'vTwSig');
const vTwEdge = varyingProperty('float', 'vTwEdge');

const OFF = () => vec4(2, 2, 2, 1);

/** The sprite's vertex stage (sprites.glsl.js spriteVertex main). */
function spriteVertexNode(u, gain) {
  return Fn(() => {
    const corner = attribute('corner', 'vec2');
    const { weight, p0, p1, p2, p3 } = fetchInstance(u);
    const viewport = screenSize;

    const on = u.uAmbient.lessThan(p3.x);
    const rel = p0.xyz.sub(cameraPosition).toVar('spRel');
    const pixelAngle = pixelAngleToward(rel).toVar('spPixelAngle');
    const d0 = length(rel);
    const d = max(d0, 0.5).toVar('spD');
    const toEye = rel.negate().div(d).toVar('spToEye');

    const { flux, color: colorW } = warmUp(p1, p3, u);
    const color = colorW.toVar('spColor');
    const { I: I0, kind, k } = intensityToward(p0, p1, p2, toEye, u);
    // the lamp's own pool seen from afar
    const cz = clamp(cameraPosition.y.sub(p0.y.sub(p3.w)).div(d), 0, 1);
    const glowOn = p3.w.greaterThan(0).and(kind.greaterThan(0.5)).and(kind.lessThan(3.5));
    const glow = u.uGroundAlbedo.mul(p0.w).mul(k.z).div(Math.PI).mul(cz).mul(smoothstep01(u.uGlowRange.x, u.uGlowRange.y, d));
    const I = I0.add(select(glowOn, glow, float(0))).mul(flux).mul(weight).toVar('spI');

    // the sprite rule (lamps.js spriteFlux)
    const T = exp(d.negate().div(u.uVisibility));
    const E = T.mul(I).div(d.mul(d));
    const dPx = max(p3.z.div(d).div(pixelAngle), u.uMinPx).toVar('spDPx');
    const solid = dPx.mul(dPx).mul(pixelAngle).mul(pixelAngle).mul(0.7853981633974483);
    const L = E.div(solid).toVar('spL');
    const n = mix(2, 6, smoothstep01(2, 8, dPx)).toVar('spN');
    const a = dPx.mul(0.5).div(pow(0.6931471805599453, float(1).div(n))).toVar('spA');
    const h = u.uHalo.mul(smoothstep01(2, 6, dPx)).toVar('spH');
    const ha = max(dPx.mul(2), 4).toVar('spHa');
    const area = dPx.mul(dPx).mul(0.7853981633974483);
    const coreNorm = float(1).sub(h).mul(area).div(a.mul(a).mul(Math.PI).mul(gammaTerm(n))).toVar('spCoreNorm');
    const haloNorm = h.mul(area).div(ha.mul(ha).mul(Math.PI)).toVar('spHaloNorm');
    const cmaxC = max(color.x, max(color.y, color.z));
    const peak = L.mul(gain).mul(coreNorm.add(haloNorm));
    const cmax = L.mul(gain).mul(cmaxC);
    const rCore = a.mul(pow(max(log(cmax.mul(coreNorm).mul(1024)), 0), float(1).div(n)));
    const rHalo = select(h.greaterThan(0), ha.mul(sqrt(max(log(cmax.mul(haloNorm).mul(1024)), 0))), float(0));
    const extent = min(max(rCore, rHalo), max(a.mul(2.6), select(h.greaterThan(0), ha.mul(2.6), float(0)))).toVar('spExtent');

    const visible = on.and(d0.greaterThanEqual(0.5)).and(peak.mul(cmaxC).greaterThanEqual(2e-4)).and(extent.greaterThanEqual(0.5));
    const px = corner.mul(extent.add(0.5));
    vPx.assign(select(visible, px, vec2(0)));
    vAmp.assign(select(visible, color.mul(L).mul(gain), vec3(0)));
    vShape.assign(select(visible, vec4(a, n, ha, coreNorm), vec4(1, 2, 1, 0)));
    vHaloNorm.assign(select(visible, haloNorm, float(0)));

    // pulled a little toward the eye so its own lamp head does not hide it
    const pr = rel.add(toEye.mul(min(1, d.mul(0.02))));
    const clip = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(pr, 0)).xyz, 1)).toVar('spClip');
    const moved = vec4(clip.xy.add(px.mul(2).div(viewport).mul(clip.w)), clip.z, clip.w);
    return select(visible, moved, OFF());
  })();
}

/** The sprite's fragment stage (sprites.glsl.js spriteFragment). */
function spriteColorNode(u, tone) {
  return Fn(() => {
    const r = length(vPx);
    const core = exp(pow(r.div(vShape.x), vShape.y).negate());
    const hr = r.div(vShape.z);
    const halo = select(vHaloNorm.greaterThan(0), exp(hr.mul(hr).negate()), float(0));
    const c = vAmp.mul(vShape.w.mul(core).add(vHaloNorm.mul(halo)));
    return vec4(tone === 'sprite' ? toneSprite(c, u.uWhiten) : c, 1);
  })();
}

// ---------------------------------------------------------------- reflected twins (sprites.glsl.js spriteTwinVertex)

function twinErf(x) {
  const t = float(1).div(abs(x).mul(0.3275911).add(1));
  const poly = t.mul(1.061405429).sub(1.453152027).mul(t).add(1.421413741).mul(t).sub(0.284496736).mul(t).add(0.254829592).mul(t);
  const y = float(1).sub(poly.mul(exp(x.mul(x).negate())));
  return select(x.lessThan(0), y.negate(), y);
}

function twinFresnel(c0) {
  const c = clamp(c0, 0, 1);
  const nI = 1.333;
  const st = sqrt(max(0, float(1).sub(c.mul(c)))).div(nI);
  const ct = sqrt(max(0, float(1).sub(st.mul(st))));
  const rs = c.sub(ct.mul(nI)).div(c.add(ct.mul(nI)));
  const rp = ct.sub(c.mul(nI)).div(ct.add(c.mul(nI)));
  return rs.mul(rs).add(rp.mul(rp)).mul(0.5);
}

function twinVertexNode(u, gain) {
  const T = TWIN_UNIFORMS;
  return Fn(() => {
    const corner = attribute('corner', 'vec2');
    const { weight, p0, p1, p2, p3 } = fetchInstance(u);
    const viewport = screenSize;
    const on = T.uTwinWet.greaterThan(0).and(u.uAmbient.lessThan(p3.x));

    // the plane, relative to the eye: y = -he + grade * (forward . xz)
    const fwd = T.uTwinRoad.zw;
    const eyeQ = cameraPosition.xz.sub(T.uTwinRoad.xy).toVar('twEyeQ');
    const he = cameraPosition.y.sub(T.uTwinPlane.x.add(T.uTwinPlane.y.mul(dot(eyeQ, fwd)))).toVar('twHe');
    const rel = p0.xyz.sub(cameraPosition).toVar('twRel');
    const hl = rel.y.sub(he.negate().add(T.uTwinPlane.y.mul(dot(rel.xz, fwd)))).toVar('twHl');
    const m = vec3(rel.x, rel.y.sub(hl.mul(2)), rel.z);
    const dm0 = length(m);
    const dm = max(dm0, 1).toVar('twDm');
    const hsum = max(he.add(hl), 0.2);
    const r = m.mul(he.div(hsum)).toVar('twR');
    const pixelAngle = pixelAngleToward(r).toVar('twPixelAngle'); // at the mirror point, where the twin is drawn
    const rq = eyeQ.add(r.xz);
    const along = dot(rq, fwd), across = dot(rq, vec2(fwd.y.negate(), fwd.x));
    const rLen = length(r.xz).toVar('twRLen');
    const mask = float(1).sub(smoothstep01(T.uTwinPlane.z.sub(4), T.uTwinPlane.z, abs(across)))
      .mul(float(1).sub(smoothstep01(T.uTwinPlane.w.mul(0.75), T.uTwinPlane.w, abs(along))))
      .mul(smoothstep01(5, 15, rLen)).toVar('twMask');

    const { flux, color: colorW } = warmUp(p1, p3, u);
    const color = colorW.toVar('twColor');
    const dirL = normalize(r.sub(rel));
    const { I: I0 } = intensityToward(p0, p1, p2, dirL, u);
    const I = I0.mul(flux).mul(weight);

    const cosi = he.add(hl).div(dm).toVar('twCosi');
    const E = T.uTwinWet.mul(mask).mul(twinFresnel(cosi)).mul(exp(dm.negate().div(u.uVisibility))).mul(I).div(dm.mul(dm)).toVar('twE');
    const kk = hl.div(hsum);
    const sigU0 = T.uTwinSlope.mul(2).mul(cosi).mul(kk).div(pixelAngle);
    const sigA0 = T.uTwinSlope.mul(2).mul(kk).div(pixelAngle);
    const disc = p3.z.mul(0.4247).div(dm).div(pixelAngle);
    const sigU = max(max(sigU0, disc), 0.6).toVar('twSigU');
    const sigA = max(sigA0, sigU);
    const dUp = max(atan(he.div(max(rLen, 1e-3))).sub(atan(he.div(max(length(rel.xz), 1e-3)))).div(pixelAngle), 0.5).toVar('twDUp');
    const sDn = sigA.mul(2.2).toVar('twSDn');
    const a = clamp(dUp.mul(0.2), 0.5, dUp);
    const Q = TWIN_FOOT;
    const runUp = dUp.mul((1 + Q) * 0.5).sub(a.mul(float(Q * 0.5).add(a.mul(0.15 * (1 - Q)).div(dUp)))).toVar('twRunUp');
    const k0 = E.mul(gain).div(pixelAngle.mul(pixelAngle).mul(2.5066282746).mul(sigU).mul(runUp.add(sDn.mul(1.2533141373))));
    const cmaxC = max(color.x, max(color.y, color.z));
    const cmax0 = k0.mul(cmaxC);
    const reach = min(sqrt(max(log(cmax0.mul(1024)), 0).mul(2)), 4.5).toVar('twReach');
    const edge = exp(reach.mul(reach).mul(-0.5)).toVar('twEdge');
    const ef = twinErf(reach.mul(0.7071067812));
    const acrossInt = sigU.mul(ef.mul(2.5066282746).sub(reach.mul(2).mul(edge))).div(float(1).sub(edge));
    const downInt = sDn.mul(ef.mul(1.2533141373).sub(reach.mul(edge))).div(float(1).sub(edge));
    const c = color.mul(E.mul(gain).div(pixelAngle.mul(pixelAngle).mul(acrossInt).mul(runUp.add(downInt))));

    // the screen's up at R, and R itself pulled toward the eye
    const rl = length(r);
    const pr = r.mul(float(1).sub(min(0.03, float(1.5).div(max(rl, 1))))).toVar('twPr');
    const view = (v) => vec4(cameraViewMatrix.mul(vec4(v, 0)).xyz, 1);
    const c0 = cameraProjectionMatrix.mul(view(pr)).toVar('twC0');
    const c1 = cameraProjectionMatrix.mul(view(pr.add(vec3(0, rl.mul(0.02).add(0.05), 0)))).toVar('twC1');
    const upRaw = c1.xy.div(c1.w).sub(c0.xy.div(c0.w));
    const up = normalize(upRaw.mul(viewport).add(vec2(0, 1e-6))).toVar('twUp');
    const side = vec2(up.y, up.x.negate());
    const px = vec2(corner.x.mul(reach).mul(sigU), select(corner.y.greaterThan(0), dUp, reach.negate().mul(sDn))).toVar('twPx');

    const visible = on.and(he.greaterThanEqual(0.1)).and(hl.greaterThanEqual(0.1)).and(dm0.greaterThanEqual(1)).and(mask.greaterThan(0))
      .and(cmax0.greaterThanEqual(2e-4)).and(reach.mul(sigU).greaterThanEqual(0.25)).and(c0.w.greaterThan(0)).and(c1.w.greaterThan(0));
    vTwEdge.assign(select(visible, edge, float(0)));
    vTw.assign(select(visible, px, vec2(0)));
    vTwAmp.assign(select(visible, c, vec3(0)));
    vTwSig.assign(select(visible, vec3(sigU, dUp, sDn), vec3(1)));
    const moved = vec4(c0.xy.add(side.mul(px.x).add(up.mul(px.y)).mul(2).div(viewport).mul(c0.w)), c0.z, c0.w);
    return select(visible, moved, OFF());
  })();
}

function twinColorNode(u, tone) {
  return Fn(() => {
    const uu = vTw.x.div(vTwSig.x);
    const gu = max(exp(uu.mul(uu).mul(-0.5)).sub(vTwEdge), 0).div(float(1).sub(vTwEdge));
    const dUp = vTwSig.y, a = clamp(dUp.mul(0.2), 0.5, dUp);
    const upper = float(1).sub(vTw.y.mul(1 - TWIN_FOOT).div(dUp)).mul(float(1).sub(smoothstep01(dUp.sub(a), dUp, vTw.y)));
    const v = vTw.y.div(vTwSig.z);
    const lower = max(exp(v.mul(v).mul(-0.5)).sub(vTwEdge), 0).div(float(1).sub(vTwEdge));
    const gv = select(vTw.y.greaterThan(0), upper, lower);
    const c = vTwAmp.mul(gu.mul(gv));
    return vec4(tone === 'sprite' ? toneSprite(c, u.uWhiten) : c, 1);
  })();
}

/** An unlit additive material drawing `vertex` and `color` (transparent: after the opaque geometry). */
function spriteMaterial(name, vertexNode, colorNode) {
  const m = new MeshBasicNodeMaterial({ name, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false });
  m.vertexNode = vertexNode;
  m.colorNode = colorNode;
  m.lights = false;
  return m;
}

/**
 * @param {{ capacity: number, name?: string, minPx?: number, halo?: number, renderOrder?: number, whiten?: number,
 *   reflect?: boolean, tone?: 'scene' | 'sprite', photometry?: { display?: 'classic' | 'physical', nodes?: object } }} opts
 *   as sprites.js; tone: 'scene' (default, linear HDR for the pipeline) or 'sprite' (sprites.glsl.js's tone, with
 *   whiten); photometry: the light scale's context (photometry.node.js photometryContext)
 */
export function createSpriteLayer({ capacity, name = 'sprites', minPx = 1.5, halo = 0.006, renderOrder = 10, whiten = 1, reflect = false,
  tone = 'scene', photometry = {} }) {
  if (!(capacity > 0)) throw new Error('sprites: capacity is required');
  const rows = Math.ceil(capacity / SPRITE_TEX_WIDTH);
  const texels = SPRITE_TEX_WIDTH * rows;
  const data = [0, 1, 2, 3].map(() => new Float32Array(texels * 4));
  const textures = data.map((d) => {
    const t = new THREE.DataTexture(d, SPRITE_TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  });
  const patKind = new Array(MAX_PATTERNS).fill(0), patK = Array.from({ length: MAX_PATTERNS }, () => new THREE.Vector3());
  let patterns = 1;

  const geometry = new THREE.InstancedBufferGeometry();
  const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
  geometry.setAttribute('corner', new THREE.BufferAttribute(corners, 2));
  // unused by the shader; there so the geometry has the attribute every renderer path may expect
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const indexArray = new Float32Array(capacity * 2);
  const identity = () => { for (let i = 0; i < capacity; i++) { indexArray[2 * i] = i; indexArray[2 * i + 1] = 1; } };
  identity();
  const indexAttr = new THREE.InstancedBufferAttribute(indexArray, 2);
  indexAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('spriteIndex', indexAttr);
  geometry.instanceCount = 0;

  const ctx = photometryContext(photometry);
  const uniforms = {
    tPos: { value: textures[0] }, tColor: { value: textures[1] }, tAxis: { value: textures[2] }, tSwitch: { value: textures[3] },
    uMinPx: uniform(minPx), uVisibility: uniform(80000), uHalo: uniform(halo), uAmbient: uniform(0),
    uFade: uniform(1),
    uOnTable: uniformArray(new Array(ON_TABLE_N).fill(1e6), 'float'), uOnSpec: uniform(new THREE.Vector3(ON_TABLE.log0, ON_TABLE.step, ON_TABLE.n)),
    uSodium: uniform(new THREE.Vector4(0.2, 0.5, 0.25, 0.52)), uGlowRange: uniform(new THREE.Vector2(800, 1000)), uGroundAlbedo: uniform(0.15),
    uPatKind: uniformArray(patKind, 'float'), uPatK: uniformArray(patK, 'vec3'),
    uWhiten: uniform(whiten),
  };
  // the shader reads the textures as nodes; `uniforms.tPos.value` and friends stay as sprites.js's for callers
  const u = { ...uniforms };
  for (const [k, i] of [['tPos', 0], ['tColor', 1], ['tAxis', 2], ['tSwitch', 3]]) u[k] = textures[i];
  /** Buffer units per cd/m^2 x the fade: what sprites.glsl.js calls uGain. */
  const gain = artificialScale(ctx).mul(uniforms.uFade);
  uniforms.uGain = {
    get value() { return uniforms.uFade.value * LIGHTING_UNITS.nit; },
    set value(v) { uniforms.uFade.value = v / LIGHTING_UNITS.nit; },
  };

  const material = spriteMaterial(name, spriteVertexNode(u, gain), spriteColorNode(u, tone));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;

  let drawCount = 0, usingList = false;

  // ---- reflected twins (as sprites.js)
  let twin = null, disposed = false;
  if (reflect) {
    const tg = new THREE.InstancedBufferGeometry();
    tg.setAttribute('corner', geometry.getAttribute('corner'));
    tg.setAttribute('position', geometry.getAttribute('position'));
    tg.setIndex(geometry.getIndex());
    const list = new Float32Array(capacity * 2);
    const listAttr = new THREE.InstancedBufferAttribute(list, 2);
    listAttr.setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('spriteIndex', listAttr);
    tg.instanceCount = 0;
    const tm = spriteMaterial(`${name}-twins`, twinVertexNode(u, gain), twinColorNode(u, tone));
    const tmesh = new THREE.Mesh(tg, tm);
    tmesh.name = `${name}-twins`;
    tmesh.frustumCulled = false;
    tmesh.matrixAutoUpdate = false;
    tmesh.renderOrder = renderOrder - 1;
    tmesh.visible = false;
    mesh.add(tmesh);
    twin = { mesh: tmesh, geometry: tg, material: tm, list, listAttr, count: 0, dynamic: false, grid: null, gridAt: 0, gridJob: null, at: [NaN, NaN] };
  }
  function twinScan(n) {
    const v = TWIN_UNIFORMS.uTwinRoad.value, cx = v.x, cz = v.y, r2 = TWIN_LIST_M * TWIN_LIST_M;
    const P = data[0], L = twin.list;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const o = 4 * i, dx = P[o] - cx, dz = P[o + 2] - cz;
      if (dx * dx + dz * dz < r2 && P[o + 3] > 0) { L[2 * w] = i; L[2 * w + 1] = 1; w++; }
    }
    twinCommit(w);
  }
  function growGrid(until) {
    const P = data[0];
    if (!twin.grid) { twin.grid = new Map(); twin.gridAt = 0; }
    const end = Math.min(capacity, until);
    for (let i = twin.gridAt; i < end; i++) {
      const o = 4 * i;
      if (!(P[o + 3] > 0)) continue;
      const key = (Math.floor(P[o] / TWIN_CELL_M) + 32768) * 65536 + Math.floor(P[o + 2] / TWIN_CELL_M) + 32768;
      let cell = twin.grid.get(key);
      if (!cell) twin.grid.set(key, (cell = []));
      cell.push(i);
    }
    twin.gridAt = Math.max(twin.gridAt, end);
    return twin.gridAt >= capacity;
  }
  function scheduleGrid() {
    if (!twin || twin.dynamic || twin.gridJob || (twin.grid && twin.gridAt >= capacity)) return;
    const idle = typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 2000 })
      : (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: false }), 50);
    const step = (deadline) => {
      twin.gridJob = null;
      if (disposed || twin.dynamic) return;
      let done = false;
      while (!done && (deadline.timeRemaining() > 2 || deadline.didTimeout)) {
        done = growGrid((twin.gridAt || 0) + GRID_SLICE);
        if (deadline.didTimeout) break;
      }
      if (!done) twin.gridJob = idle(step);
    };
    twin.gridJob = idle(step);
  }
  function twinGridList() {
    const v = TWIN_UNIFORMS.uTwinRoad.value, cx = v.x, cz = v.y;
    if (Math.hypot(cx - twin.at[0], cz - twin.at[1]) < TWIN_RELIST_M) return;
    twin.at[0] = cx; twin.at[1] = cz;
    const P = data[0];
    if (!twin.grid || twin.gridAt < capacity) growGrid(capacity);
    const r = Math.ceil(TWIN_LIST_M / TWIN_CELL_M), gx = Math.floor(cx / TWIN_CELL_M), gz = Math.floor(cz / TWIN_CELL_M);
    const r2 = TWIN_LIST_M * TWIN_LIST_M, L = twin.list;
    let w = 0;
    for (let a = gx - r; a <= gx + r; a++) {
      for (let b = gz - r; b <= gz + r; b++) {
        const cell = twin.grid.get((a + 32768) * 65536 + b + 32768);
        if (!cell) continue;
        for (const i of cell) {
          const o = 4 * i, dx = P[o] - cx, dz = P[o + 2] - cz;
          if (dx * dx + dz * dz < r2 && w < capacity) { L[2 * w] = i; L[2 * w + 1] = 1; w++; }
        }
      }
    }
    twinCommit(w);
  }
  function twinCommit(w) {
    twin.count = w;
    twin.listAttr.clearUpdateRanges();
    twin.listAttr.addUpdateRange(0, Math.max(2 * w, 2));
    twin.listAttr.needsUpdate = true;
    twin.geometry.instanceCount = w;
  }
  const dropList = () => { identity(); indexAttr.clearUpdateRanges(); indexAttr.needsUpdate = true; usingList = false; };

  const layer = {
    mesh, material, uniforms, capacity, data,
    /** The photometry context the layer was built with. */
    photometry: ctx,
    get drawn() { return geometry.instanceCount; },
    get twins() { return twin ? { mesh: twin.mesh, listed: twin.mesh.visible ? twin.count : 0 } : null; },
    twinFrame() {
      if (!twin) return;
      const on = TWIN_UNIFORMS.uTwinWet.value > 0;
      twin.mesh.visible = on;
      if (!on) { twin.at[0] = NaN; return; }
      if (!twin.dynamic) twinGridList();
    },
    invalidateTwins() { if (twin) { twin.grid = null; twin.gridAt = 0; twin.at[0] = NaN; scheduleGrid(); } },
    get twinGridReady() { return !!(twin && twin.grid && twin.gridAt >= capacity); },

    /** As sprites.js definePattern. */
    definePattern({ kind, exponent = 1, kDown = 0, kUp = 0, downShare = 1 }) {
      if (!(kind in PATTERN)) throw new Error(`sprites: unknown pattern kind "${kind}"`);
      if (kind === 'isotropic') return 0;
      if (patterns >= MAX_PATTERNS) throw new Error('sprites: too many patterns');
      const id = patterns++;
      patKind[id] = PATTERN[kind];
      patK[id].set(kDown, kUp, kind === 'lobe' ? exponent : downShare);
      return id;
    },

    /** As sprites.js set. */
    set(i, { position, color = [1, 1, 1], intensity = 0, pattern = 0, axis = [0, -1, 0], aim = null,
      threshold = ALWAYS_ON, warm = 0, diameter = LUMINAIRE_DIAMETER_M, mount = 0 }) {
      const o = i * 4;
      const [a, b, c, d] = data;
      a[o] = position[0]; a[o + 1] = position[1]; a[o + 2] = position[2]; a[o + 3] = intensity;
      b[o] = color[0]; b[o + 1] = color[1]; b[o + 2] = color[2]; b[o + 3] = pattern;
      c[o] = axis[0]; c[o + 1] = axis[1]; c[o + 2] = axis[2]; c[o + 3] = aim == null || !Number.isFinite(aim) ? -10 : aim;
      d[o] = Number.isFinite(threshold) ? threshold : ALWAYS_ON; d[o + 1] = warm; d[o + 2] = diameter; d[o + 3] = mount;
    },
    setPosition(i, x, y, z) { const o = i * 4; data[0][o] = x; data[0][o + 1] = y; data[0][o + 2] = z; },

    commit(count) {
      layer.markDirty();
      if (twin && !twin.dynamic) scheduleGrid();
      if (Number.isFinite(count)) {
        if (usingList) dropList();
        drawCount = Math.min(count, capacity);
        geometry.instanceCount = drawCount;
      }
    },
    markDirty() { for (const t of textures) t.needsUpdate = true; },
    commitRows(count) {
      count = Math.max(0, Math.min(count, capacity));
      if (usingList) dropList();
      if (count > 0) for (const t of textures) t.needsUpdate = true; // whole textures: r187 has no partial texture upload
      drawCount = count;
      geometry.instanceCount = count;
      if (twin) { twin.dynamic = true; if (TWIN_UNIFORMS.uTwinWet.value > 0) twinScan(count); }
    },

    setDrawList(indices, n, weights) {
      n = Math.min(n, capacity);
      for (let j = 0; j < n; j++) { indexArray[2 * j] = indices[j]; indexArray[2 * j + 1] = weights ? weights[j] : 1; }
      indexAttr.clearUpdateRanges();
      indexAttr.addUpdateRange(0, 2 * n);
      indexAttr.needsUpdate = true;
      usingList = true;
      drawCount = n;
      geometry.instanceCount = n;
    },
    get drawIndices() { usingList = true; return indexArray; },
    setDrawCount(n) {
      n = Math.min(n, capacity);
      indexAttr.clearUpdateRanges();
      indexAttr.addUpdateRange(0, Math.max(2 * n, 2));
      indexAttr.needsUpdate = true;
      drawCount = n;
      geometry.instanceCount = n;
    },

    /**
     * Per-frame values, as sprites.js setFrame. `fade` (dimensionless) multiplies the light; a `gain` without a fade
     * is read as LIGHTING_UNITS.nit x the fade (what sprites.js callers pass). camera and renderer are not needed.
     */
    setFrame({ fade, gain, ambientLux, onTable, visibility, sodium, glowRange, groundAlbedo } = {}) {
      if (fade != null) uniforms.uFade.value = fade;
      else if (gain != null) uniforms.uFade.value = gain / LIGHTING_UNITS.nit;
      if (ambientLux != null) uniforms.uAmbient.value = ambientLux;
      if (onTable) { const a = uniforms.uOnTable.array; for (let i = 0; i < ON_TABLE_N; i++) a[i] = Number.isFinite(onTable[i]) ? onTable[i] : -1; }
      if (visibility != null) uniforms.uVisibility.value = visibility;
      if (sodium) uniforms.uSodium.value.set(sodium.startUv[0], sodium.startUv[1], sodium.steadyUv[0], sodium.steadyUv[1]);
      if (glowRange) uniforms.uGlowRange.value.set(glowRange[0], glowRange[1]);
      if (groundAlbedo != null) uniforms.uGroundAlbedo.value = groundAlbedo;
    },

    dispose() {
      disposed = true;
      mesh.parent?.remove(mesh);
      if (twin) { twinLayers.delete(layer); twin.geometry.dispose(); twin.material.dispose(); }
      geometry.dispose();
      material.dispose();
      for (const t of textures) t.dispose();
    },
  };
  if (twin) twinLayers.add(layer);
  return layer;
}

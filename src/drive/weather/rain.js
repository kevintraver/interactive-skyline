// Falling rain near the camera (plan 02, phase 8; third stretch, decision 6): MAX_DROPS instanced streaks, as many drawn
// as the rate asks for (rainMirror.js dropCount), each drop's place a pure function of simulation time (rainMirror.js
// rainOffsets, in double precision on the CPU in onBeforeRender with the camera the frame is drawn from), lit by the
// visitor's low beam (brightest in the beam) at night and by the sky by day. Mirror: rainMirror.js (dropLocal,
// lowBeamShare, streakLight); tests/unit/weather/rain.test.js.
//
//   - It is drawn in the pipeline's scene pass and writes linear HDR (additive), so tone mapping and bloom treat it as
//     everything else.
//   - Light units: the headlamps' light on a drop is scaled by photometry.js artificialScale (the pre-exposure x
//     cityFactor) and the sky's by lightScale; update() takes the sky in cd/m^2 (`skyCdM2`).
//   - The viewport and the pixel's angle are read from the target being drawn (as sprites.js does).
//   - First rain: while dry the mesh is drawn with no instances until the weather part has had it in a frame, so
//     three builds its program then (drawing nothing) and the first rain builds none.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, uniformArray, varyingProperty, cameraViewMatrix, cameraProjectionMatrix, screenSize,
  int, float, vec2, vec3, vec4, select, exp, max, min, abs, length, dot, atan, floor, mix, smoothstep, degrees } from 'three/tsl';
import { BOX_M, AHEAD_M, CLASS_MM, MAX_DROPS, BACKSCATTER, DAY_CONTRAST, STREAK_GAIN, LOW_PEAK_CD, dropSeed, dropCount, dropVelocity, rainOffsets, shutterAt } from './rainMirror.js';
import { photometryContext, artificialScale, lightScale } from '../lights/photometry.js';

/** The car's box for leaving drops out of the cabin (half width, roof, half length, floor; metres from its road point). */
const CAR_BOX = [1.0, 1.75, 2.5, -0.3];
/** The headlamps relative to the car's road point (car frame: right, up, forward), as headlights.js places them. */
const LAMPS = [[-0.7, 0.65, 2.85], [0.7, 0.65, 2.85]];

const vAcross = varyingProperty('float', 'vRainAcross');
const vAlong = varyingProperty('float', 'vRainAlong');
const vLen = varyingProperty('float', 'vRainLen');
const vAmp = varyingProperty('vec3', 'vRainAmp');

/** GLSL mod for floats (x - y floor(x / y)); WGSL's % truncates. */
const fmod = (x, y) => x.sub(floor(x.div(y)).mul(y));

/** The low beam's share of its peak toward c (car frame; rainMirror.js lowBeamShare). */
function lowBeam(c) {
  const h = degrees(atan(c.x, c.z));
  const v = degrees(atan(c.y, length(c.xz)));
  const dv = v.add(1.75);
  const sv = select(dv.lessThan(0), float(4.5), float(1));
  const hh = h.sub(2).div(14);
  const q = dv.div(sv);
  return select(c.z.lessThanEqual(0), float(0), exp(hh.mul(hh).negate()).mul(exp(q.mul(q).negate())));
}

/**
 * @param {{ parent: THREE.Object3D, maxDrops?: number, photometry?: object }} o  photometry: the light scale's context
 */
export function createRain({ parent, maxDrops = MAX_DROPS, photometry = {} }) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([0, -1, 1, -1, 1, 1, 0, 1]), 2));
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3)); // unread
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(4 * maxDrops);
  for (let i = 0; i < maxDrops; i++) seeds.set(dropSeed(i), 4 * i);
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = 0;

  const ctx = photometryContext(photometry);
  const uniforms = {
    uBox: uniform(BOX_M),
    uOff: uniformArray(CLASS_MM.map(() => new THREE.Vector3()), 'vec3'),
    uStreak: uniformArray(CLASS_MM.map(() => new THREE.Vector3()), 'vec3'),
    uDiam: uniform(new THREE.Vector4(...CLASS_MM.map((d) => d / 1000))),
    uCentre: uniform(new THREE.Vector3()),
    uLamp0: uniform(new THREE.Vector3()), uLamp1: uniform(new THREE.Vector3()),
    uCarR: uniform(new THREE.Vector3(1, 0, 0)), uCarU: uniform(new THREE.Vector3(0, 1, 0)), uCarF: uniform(new THREE.Vector3(0, 0, -1)),
    // x headlamp peak cd x on, y unused (the light scale is a node here), z backscatter x gain, w day contrast x gain
    uLight: uniform(new THREE.Vector4(0, 0, BACKSCATTER * STREAK_GAIN, DAY_CONTRAST * STREAK_GAIN)),
    uSky: uniform(new THREE.Color()), // cd/m^2
    uLampColour: uniform(new THREE.Color(1, 0.95, 0.86).multiplyScalar(1 / (0.2126 + 0.7152 * 0.95 + 0.0722 * 0.86))),
    uCarRel: uniform(new THREE.Vector3()),
    uCarBox: uniform(new THREE.Vector4(...CAR_BOX)),
    uVisibility: uniform(80000),
  };
  const U = uniforms;
  const lampScale = artificialScale(ctx), skyScale = lightScale(ctx);

  const material = new MeshBasicNodeMaterial({ name: 'rain', transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false });
  material.lights = false;
  material.vertexNode = Fn(() => {
    const corner = attribute('corner', 'vec2');
    const aSeed = attribute('aSeed', 'vec4');
    const c = min(int(floor(aSeed.w.mul(4))), int(3)).toVar('rnC');
    const box = U.uBox;
    const local = fmod(aSeed.xyz.mul(box).add(U.uOff.element(c)), box).sub(box.mul(0.5)).toVar('rnLocal');
    const head = local.add(U.uCentre).toVar('rnHead');
    const d = length(head).toVar('rnD');
    // inside the car: none
    const rel = head.sub(U.uCarRel);
    const q = vec3(dot(rel, U.uCarR), dot(rel, U.uCarU), dot(rel, U.uCarF));
    const inCar = abs(q.x).lessThan(U.uCarBox.x).and(q.y.lessThan(U.uCarBox.y)).and(q.y.greaterThan(U.uCarBox.w)).and(abs(q.z).lessThan(U.uCarBox.z));
    const edge = max(abs(local.x), max(abs(local.y), abs(local.z))).div(box.mul(0.5));
    const fade = float(1).sub(smoothstep(0.7, 1, edge));
    // light on the drop: the headlamps (both), and the sky
    const lampLux = (L) => {
      const v = head.sub(L);
      const r2 = max(dot(v, v), 0.25);
      return U.uLight.x.mul(lowBeam(vec3(dot(v, U.uCarR), dot(v, U.uCarU), dot(v, U.uCarF)))).div(r2);
    };
    const lux = lampLux(U.uLamp0).add(lampLux(U.uLamp1));
    const D = select(c.equal(0), U.uDiam.x, select(c.equal(1), U.uDiam.y, select(c.equal(2), U.uDiam.z, U.uDiam.w)));
    const A = D.mul(D).mul(0.7853981633974483);
    const T = exp(d.negate().div(U.uVisibility));
    const E = U.uLampColour.mul(lux.mul(A).mul(U.uLight.z).mul(lampScale)).add(U.uSky.mul(skyScale).mul(U.uLight.w.mul(A)))
      .mul(fade.mul(T).div(max(d.mul(d), 1e-6))).toVar('rnE');
    // the streak on screen
    const tail = head.sub(U.uStreak.element(c));
    const ch = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(head, 0)).xyz, 1)).toVar('rnCh');
    const ct = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(tail, 0)).xyz, 1)).toVar('rnCt');
    const viewport = screenSize;
    const sh = ch.xy.div(ch.w).mul(0.5).mul(viewport), st = ct.xy.div(ct.w).mul(0.5).mul(viewport);
    const dir = st.sub(sh).toVar('rnDir');
    const len = length(dir).toVar('rnLen');
    const ax = select(len.greaterThan(1e-3), dir.div(max(len, 1e-3)), vec2(0, -1)).toVar('rnAx');
    const side = vec2(ax.y.negate(), ax.x);
    const L = max(len, 1.5).toVar('rnL');
    const sigma = 0.6, halfW = 1.6;
    // radians per pixel at the centre of the view of the target being drawn: 2 tan(fov / 2) / height
    const pixelAngle = float(2).div(cameraProjectionMatrix.element(1).y.mul(viewport.y).max(1));
    // summed light E over the streak: per pixel E / pixelAngle^2 / (L x sqrt(2 pi) sigma) on its axis
    const amp = E.div(pixelAngle.mul(pixelAngle).mul(L).mul(2.5066282746310002 * sigma)).toVar('rnAmp');
    const visible = d.greaterThanEqual(0.6).and(inCar.not()).and(ch.w.greaterThan(0.05)).and(ct.w.greaterThan(0.05))
      .and(max(amp.x, max(amp.y, amp.z)).greaterThanEqual(1e-4)).toVar('rnVisible');
    const cl = mix(ch, ct, corner.x).toVar('rnCl');
    const offPx = side.mul(corner.y.mul(halfW)).add(ax.mul(corner.x.mul(2).sub(1)).mul(0.75)).add(ax.mul(corner.x.mul(L.sub(len))));
    const moved = vec4(cl.xy.add(offPx.mul(2).div(viewport).mul(cl.w)), cl.z, cl.w);
    vAcross.assign(select(visible, corner.y.mul(halfW), float(0)));
    vAlong.assign(select(visible, corner.x, float(0)));
    vLen.assign(select(visible, L, float(1)));
    vAmp.assign(select(visible, amp, vec3(0)));
    return select(visible, moved, vec4(2, 2, 2, 1));
  })();
  material.colorNode = Fn(() => {
    const a = vAcross.div(0.6);
    // soft ends over about a pixel each
    const ends = smoothstep(0, float(1).div(vLen), vAlong).mul(smoothstep(0, float(1).div(vLen), float(1).sub(vAlong)));
    return vec4(vAmp.mul(exp(a.mul(a).mul(-0.5)).mul(ends)), 1);
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rain';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 12;
  mesh.visible = false;
  parent.add(mesh);

  // what onBeforeRender needs, set by update()
  let state = null, simMs = 0, rate = 1, pose = null, beamGain = 0;
  const camPos = new THREE.Vector3(), camDir = new THREE.Vector3();

  mesh.onBeforeRender = (renderer, scene, camera) => {
    if (!state || !pose) return;
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    const centre = [camPos.x + camDir.x * AHEAD_M, camPos.y + camDir.y * AHEAD_M, camPos.z + camDir.z * AHEAD_M];
    const off = rainOffsets(simMs, state, centre);
    const sh = shutterAt(rate);
    const car = pose.forward, s = pose.speed || 0;
    for (let k = 0; k < 4; k++) {
      U.uOff.array[k].set(off[k][0], off[k][1], off[k][2]);
      const v = dropVelocity(state, k);
      U.uStreak.array[k].set((v[0] - car.x * s) * sh, (v[1] - car.y * s) * sh, (v[2] - car.z * s) * sh);
    }
    U.uCentre.value.set(centre[0] - camPos.x, centre[1] - camPos.y, centre[2] - camPos.z);
    const p = pose.position, r = pose.right, u = pose.up, f = pose.forward;
    U.uCarRel.value.set(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z);
    U.uCarR.value.set(r.x, r.y, r.z); U.uCarU.value.set(u.x, u.y, u.z); U.uCarF.value.set(f.x, f.y, f.z);
    LAMPS.forEach(([x, y, z], i) => (i ? U.uLamp1 : U.uLamp0).value.set(
      p.x + r.x * x + u.x * y + f.x * z - camPos.x, p.y + r.y * x + u.y * y + f.y * z - camPos.y, p.z + r.z * x + u.z * y + f.z * z - camPos.z));
    U.uLight.value.x = LOW_PEAK_CD * beamGain;
  };

  return {
    mesh, uniforms,
    get drops() { return mesh.visible ? geometry.instanceCount : 0; },
    /**
     * @param {{ state: object, simMs: number, rate: number, pose: object, beams: number, skyCdM2: {r,g,b} }} f
     *   beams: the headlamps' drawn strength (0 off, 1 on at night); skyCdM2: the sky's luminance near the horizon
     */
    update(f) {
      const n = Math.min(maxDrops, dropCount(f.state.precipMmPerHour));
      mesh.visible = n > 0;
      geometry.instanceCount = n;
      if (!n) { state = null; return; }
      state = f.state; simMs = f.simMs; rate = f.rate; pose = f.pose; beamGain = f.beams;
      U.uSky.value.setRGB(f.skyCdM2.r, f.skyCdM2.g, f.skyCdM2.b);
      U.uVisibility.value = f.state.visibilityM;
    },
    dispose() { parent.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}

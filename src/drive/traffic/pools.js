// Headlamp pools of other vehicles (plan 02, D6.4): a soft pool of light on the road ahead of each of the
// nearest lit vehicles, as an instanced additive decal (pools.glsl.js). One draw call, at most MAX_POOLS
// instances; nothing by day. Cheap: no lights, no shadow maps, no change to the road's materials. On a wet road the
// pools are weakened as the visitor's own is (pools.glsl.js; the cover from lights/sprites.js TWIN_UNIFORMS).

import * as THREE from 'three';
import { poolVertex, poolFragment } from './pools.glsl.js';
import { SHADOW_PULL } from './material.js';
import { LAMP_RGB } from './lamps.js';
import { TWIN_UNIFORMS } from '../lights/sprites.js';
import { WET_DIFFUSE, GLOSS, fresnelWater } from '../weather/wetMirror.js';

export const MAX_POOLS = 32;
/** Vehicles farther than this (m) get no pool: by then it is a few pixels of faint road. */
export const POOL_RANGE_M = 160;
export const POOL_LENGTH_M = 60;
/** Reflectance of the pavement (asphalt, ASSUMED). */
export const ASPHALT_RHO = 0.12;

const DEG = 180 / Math.PI;
/** The pool shader's low beam (cd) at beta degrees below the horizontal and phi to the side. */
export function poolBeam(beta, phi) {
  return 12000 * Math.exp(-(((beta - 1.2) / 1.6) ** 2)) * Math.exp(-((phi / 10) ** 2))
    + 3000 * Math.exp(-(((beta - 3) / 4) ** 2)) * Math.exp(-((phi / 28) ** 2));
}
/**
 * Illuminance (lux) on the road at (across, along) metres from a vehicle's front, from both lamps; on a wet road
 * (cover: the water's share of the pavement) each lamp's less what glances off the film, 1 - cover x F(incidence).
 */
export function poolIlluminance(across, along, halfSpacing = 0.5, height = 0.65, cover = 0) {
  let E = 0;
  for (const x0 of [-halfSpacing, halfSpacing]) {
    const gx = across - x0, gy = along;
    const flat2 = gx * gx + gy * gy, r2 = flat2 + height * height;
    const beta = Math.atan2(height, Math.sqrt(flat2)) * DEG;
    const phi = Math.atan2(gx, Math.max(gy, 1e-3)) * DEG;
    const cosi = height / Math.sqrt(r2);
    E += ((poolBeam(beta, phi) * cosi) / r2) * (1 - cover * fresnelWater(cosi));
  }
  return E;
}
/**
 * Mirrors the pool shader: the decal's luminance (cd/m^2) at a point, dry or wet (the visitor's own pool's rule,
 * weather/wet.glsl.js: the light that reaches the pavement is reflected k = 1 - cover x (1 - WET_DIFFUSE) as strongly).
 */
export function poolLuminance(across, along, { halfSpacing = 0.5, height = 0.65, cover = 0, rho = ASPHALT_RHO } = {}) {
  const k = 1 - cover * (1 - WET_DIFFUSE);
  return (rho * poolIlluminance(across, along, halfSpacing, height, cover) * k) / Math.PI;
}

/**
 * @param {{ parent: THREE.Object3D, sidecar: object, bodyNames: string[] }} opts sidecar: vehicles.json (head lamp positions)
 */
export function createPools({ parent, sidecar, bodyNames }) {
  const quad = new THREE.InstancedBufferGeometry();
  const N = 12; // along, so the shape tapers smoothly
  const corners = [], idx = [];
  for (let i = 0; i <= N; i++) { const y = i / N; corners.push(-1, y, 1, y); if (i) { const a = 2 * (i - 1); idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
  quad.setAttribute('corner', new THREE.Float32BufferAttribute(corners, 2));
  quad.setIndex(idx);
  const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const aOrigin = mk(3), aFwd = mk(3), aUp = mk(3), aLamp = mk(2), aScale = mk(1);
  quad.setAttribute('iOrigin', aOrigin); quad.setAttribute('iFwd', aFwd); quad.setAttribute('iUp', aUp);
  quad.setAttribute('iLamp', aLamp); quad.setAttribute('iScale', aScale);
  quad.instanceCount = 0;
  const uniforms = {
    uLength: { value: POOL_LENGTH_M }, uHalfWidth: { value: 12 }, uPull: { value: SHADOW_PULL * 1.2 },
    uGain: { value: 0.1 }, uRho: { value: ASPHALT_RHO }, uColor: { value: new THREE.Vector3(...LAMP_RGB.white) },
    // the wet road: the weather part's cover for the twins (the same object, so it follows without a call here)
    uTwinWet: TWIN_UNIFORMS.uTwinWet, uWetPool: { value: new THREE.Vector2(GLOSS.twin, WET_DIFFUSE) },
  };
  const material = new THREE.ShaderMaterial({
    name: 'traffic-head-pools', uniforms, vertexShader: poolVertex, fragmentShader: poolFragment,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: true, fog: false,
  });
  const mesh = new THREE.Mesh(quad, material);
  mesh.name = 'traffic-head-pools';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  parent.add(mesh);

  // per body: front overhang (m ahead of the origin), half the head lamp spacing, lamp height
  const bodies = bodyNames.map((name) => {
    const b = sidecar.bodies[name];
    const h = b.lamps?.head || [[-0.5, 0.65, -b.length / 2], [0.5, 0.65, -b.length / 2]];
    return { front: -h[0][2], half: Math.abs(h[0][0]), height: h[0][1] };
  });
  const pick = new Int32Array(256), pickD = new Float32Array(256);
  let count = 0;

  /**
   * @param {{ near: object|null, eye: {x,y,z}, ambient: number, gain: number, threshold: (id) => number }} f
   */
  function update({ near, eye, ambient, gain, threshold }) {
    count = 0;
    if (!near || !(gain > 0)) { mesh.visible = false; quad.instanceCount = 0; return; }
    let m = 0;
    const R2 = POOL_RANGE_M * POOL_RANGE_M;
    for (let i = 0; i < near.count && m < pick.length; i++) {
      if (near.alpha[i] < 0.05) continue;
      const dx = near.pos[3 * i] - eye.x, dy = near.pos[3 * i + 1] - eye.y, dz = near.pos[3 * i + 2] - eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      if (!(ambient < threshold(near.id[i]))) continue;
      pick[m] = i; pickD[m] = d2; m++;
    }
    // the nearest MAX_POOLS (selection: m is a few dozen)
    const n = Math.min(m, MAX_POOLS);
    for (let a = 0; a < n; a++) {
      let best = a;
      for (let b = a + 1; b < m; b++) if (pickD[b] < pickD[best]) best = b;
      const ti = pick[a], td = pickD[a]; pick[a] = pick[best]; pickD[a] = pickD[best]; pick[best] = ti; pickD[best] = td;
      const i = pick[a], i3 = 3 * i, B = bodies[near.body[i]];
      const Fx = near.fwd[i3], Fy = near.fwd[i3 + 1], Fz = near.fwd[i3 + 2];
      aOrigin.array[3 * a] = near.pos[i3] + Fx * B.front; aOrigin.array[3 * a + 1] = near.pos[i3 + 1] + Fy * B.front; aOrigin.array[3 * a + 2] = near.pos[i3 + 2] + Fz * B.front;
      aFwd.array[3 * a] = Fx; aFwd.array[3 * a + 1] = Fy; aFwd.array[3 * a + 2] = Fz;
      aUp.array[3 * a] = near.up[i3]; aUp.array[3 * a + 1] = near.up[i3 + 1]; aUp.array[3 * a + 2] = near.up[i3 + 2];
      aLamp.array[2 * a] = B.half; aLamp.array[2 * a + 1] = B.height;
      // fade over the last fifth of the range so nothing pops
      const d = Math.sqrt(pickD[a]);
      const f = Math.min(1, Math.max(0, (POOL_RANGE_M - d) / (0.2 * POOL_RANGE_M)));
      aScale.array[a] = near.alpha[i] * f;
    }
    count = n;
    for (const a of [aOrigin, aFwd, aUp, aLamp, aScale]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * a.itemSize); a.needsUpdate = true; }
    quad.instanceCount = n;
    uniforms.uGain.value = gain;
    mesh.visible = n > 0;
  }

  return {
    mesh, update,
    clear() { count = 0; quad.instanceCount = 0; mesh.visible = false; },
    stats: () => ({ pools: count }),
    dispose() { parent.remove(mesh); quad.dispose(); material.dispose(); },
  };
}

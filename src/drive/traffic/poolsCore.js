// Headlamp pools of other vehicles (plan 02, D6.4): the work both renderers share, with no shader in it. pools.js
// (GLSL, the classic renderer) and pools.node.js (TSL, plan 01's) each hand this their uniforms and material; the
// decal's geometry, the choice of the nearest lit vehicles and the pool model in JavaScript are here once (plan 02,
// third stretch, decision 2: pure logic is shared, not copied).

import * as THREE from 'three';
import { WET_DIFFUSE, fresnelWater } from '../weather/wetMirror.js';
import { MAX_POOLS, POOL_RANGE_M, POOL_LENGTH_M, ASPHALT_RHO, poolBeam, poolIlluminanceWith } from './lightData.js';

export { MAX_POOLS, POOL_RANGE_M, POOL_LENGTH_M, ASPHALT_RHO, poolBeam };

/**
 * Illuminance (lux) on the road at (across, along) metres from a vehicle's front, from both lamps; on a wet road
 * (cover: the water's share of the pavement) each lamp's less what glances off the film, 1 - cover x F(incidence).
 */
export const poolIlluminance = (across, along, halfSpacing = 0.5, height = 0.65, cover = 0) =>
  poolIlluminanceWith(fresnelWater, across, along, halfSpacing, height, cover);

/**
 * Mirrors the pool shader: the decal's luminance (cd/m^2) at a point, dry or wet (the visitor's own pool's rule,
 * weather/wet.glsl.js: the light that reaches the pavement is reflected k = 1 - cover x (1 - WET_DIFFUSE) as strongly).
 */
export function poolLuminance(across, along, { halfSpacing = 0.5, height = 0.65, cover = 0, rho = ASPHALT_RHO } = {}) {
  const k = 1 - cover * (1 - WET_DIFFUSE);
  return (rho * poolIlluminance(across, along, halfSpacing, height, cover) * k) / Math.PI;
}

/**
 * The pools: an instanced decal of at most MAX_POOLS instances, one per nearest lit vehicle.
 * @param {{ parent: THREE.Object3D, sidecar: object, bodyNames: string[], uniforms: object,
 *   material: (uniforms: object) => THREE.Material, positions?: boolean }} opts
 *   uniforms: the material's (at least uGain, set each update); positions: give the decal a `position` attribute of
 *   zeros (node materials read it even when their positionNode replaces it)
 */
export function createPoolsWith({ parent, sidecar, bodyNames, uniforms, material: makeMaterial, positions = false }) {
  const quad = new THREE.InstancedBufferGeometry();
  const N = 12; // along, so the shape tapers smoothly
  const corners = [], idx = [];
  for (let i = 0; i <= N; i++) { const y = i / N; corners.push(-1, y, 1, y); if (i) { const a = 2 * (i - 1); idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
  quad.setAttribute('corner', new THREE.Float32BufferAttribute(corners, 2));
  if (positions) quad.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((corners.length / 2) * 3), 3));
  quad.setIndex(idx);
  const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const aOrigin = mk(3), aFwd = mk(3), aUp = mk(3), aLamp = mk(2), aScale = mk(1);
  quad.setAttribute('iOrigin', aOrigin); quad.setAttribute('iFwd', aFwd); quad.setAttribute('iUp', aUp);
  quad.setAttribute('iLamp', aLamp); quad.setAttribute('iScale', aScale);
  quad.instanceCount = 0;
  const material = makeMaterial(uniforms);
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
    mesh, update, uniforms,
    /** For probes: pool a's origin (the vehicle's front, scene metres), forward, up, half lamp spacing and height, and scale. */
    instance(a) {
      if (!(a >= 0 && a < count)) return null;
      const v = (attr, n) => Array.from(attr.array.subarray(n * a, n * a + n));
      return { origin: v(aOrigin, 3), fwd: v(aFwd, 3), up: v(aUp, 3), half: aLamp.array[2 * a], height: aLamp.array[2 * a + 1], scale: aScale.array[a] };
    },
    clear() { count = 0; quad.instanceCount = 0; mesh.visible = false; },
    stats: () => ({ pools: count }),
    dispose() { parent.remove(mesh); quad.dispose(); material.dispose(); },
  };
}

// Spray behind the vehicles near the camera on a wet road (plan 02, D8.3). From the traffic part's vehicles of the
// frame (traffic/index.js placed()): the nearest MAX_VEHICLES moving vehicles within RANGE_M each throw PUFFS soft
// puffs behind their rear wheels, growing and thinning with distance behind, stronger with speed and wetness. Lit by
// the sky by day; at night by a little ambient light, by the vehicle's own tail lamps inside the spray (red, more
// when it brakes), by the head lamps of the vehicle following it, and by the visitor's low beam when the spray is
// in it. A pure function of the vehicles of the frame, the weather and the look. Cheap: at most 64 sprites, one draw.
//
// Numbers (ASSUMED, by eye): SPRAY_OPACITY at full wetness and SPRAY_FULL_MPS and up; the puffs' places and sizes
// (PUFFS); the spray's albedo SPRAY_ALBEDO (water droplets scatter almost all they intercept); the night's ambient
// illuminance on it AMBIENT_NIGHT_LUX (a lit freeway's spill).

import * as THREE from 'three';
import { sprayVertex, sprayFragment } from './spray.glsl.js';
import { lowBeamShare, LOW_PEAK_CD } from './rainMirror.js';
import { LAMP_CD, LAMP_RGB } from '../traffic/lamps.js';

export const MAX_VEHICLES = 16;
export const RANGE_M = 160;
export const SPRAY_OPACITY = 0.35;
export const SPRAY_FULL_MPS = 26;
export const SPRAY_ALBEDO = 0.8;
export const AMBIENT_NIGHT_LUX = 1.5;
/** Puffs behind a body: x across (share of the half track; 0 the middle), metres behind the rear, height, radius,
 * opacity share. */
export const PUFFS = Object.freeze([
  [-1, 0.6, 0.45, 0.7, 0.7], [1, 0.6, 0.45, 0.7, 0.7], [0, 2.6, 0.75, 1.4, 0.5], [0, 6, 1.1, 2.2, 0.3],
]);
const HEAD_LAMPS = [[-0.7, 0.65, 2.85], [0.7, 0.65, 2.85]];

/** Spray's strength for a vehicle (0..1): wetness x the speed's share, squared to start gently. */
export function sprayStrength(wetness, speedMps) {
  const s = Math.min(1, Math.max(0, (speedMps - 4) / (SPRAY_FULL_MPS - 4)));
  return Math.min(1, Math.max(0, wetness)) * s * s;
}

export function createSpray({ parent, maxVehicles = MAX_VEHICLES }) {
  const cap = maxVehicles * PUFFS.length;
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const attr = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const A = { aPos: attr(3), aSize: attr(1), aAlpha: attr(1), aColor: attr(3), aSeed: attr(1) };
  for (const [k, a] of Object.entries(A)) geometry.setAttribute(k, a);
  geometry.instanceCount = 0;
  const uniforms = { uRef: { value: new THREE.Vector3() }, uTime: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    name: 'spray', uniforms, vertexShader: sprayVertex, fragmentShader: sprayFragment,
    transparent: true, premultipliedAlpha: true, blending: THREE.NormalBlending, depthWrite: false, depthTest: true, toneMapped: false, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'spray';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 9;
  mesh.visible = false;
  parent.add(mesh);
  const ref = [0, 0, 0];
  const cam = new THREE.Vector3();
  mesh.onBeforeRender = (renderer, scene, camera) => {
    camera.getWorldPosition(cam);
    uniforms.uRef.value.set(ref[0] - cam.x, ref[1] - cam.y, ref[2] - cam.z);
  };

  const near = []; // [distance, index]
  const puffs = []; // { d, pos[3], size, alpha, color[3], seed }
  for (let i = 0; i < cap; i++) puffs.push({ d: 0, pos: [0, 0, 0], size: 0, alpha: 0, color: [0, 0, 0], seed: 0 });
  const order = [];
  let count = 0, vehicles = 0;

  /**
   * @param {{ placed: object|null, lengths: number[], eye: {x,y,z}, pose: object, wetness: number, simMs: number,
   *   lights: number, beams: number, units: number, sky: THREE.Color }} f
   *   placed: traffic placed(); lengths: body lengths by body index; lights: the look's night share (0 day, 1 night);
   *   beams: the visitor's headlamps' drawn strength; units: lighting.units.nit (= lux)
   */
  function update({ placed, lengths, eye, pose, wetness, simMs, lights, beams, units, sky }) {
    count = 0; vehicles = 0;
    if (!(wetness > 0) || !placed || !placed.count) { mesh.visible = false; geometry.instanceCount = 0; return; }
    const P = placed.pos, F = placed.fwd, U = placed.up;
    near.length = 0;
    for (let i = 0; i < placed.count; i++) {
      if (sprayStrength(wetness, placed.speed[i]) * placed.alpha[i] < 0.01) continue;
      const dx = P[3 * i] - eye.x, dy = P[3 * i + 1] - eye.y, dz = P[3 * i + 2] - eye.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < RANGE_M + 60) near.push([d, i]);
    }
    near.sort((a, b) => a[0] - b[0]);
    let n = 0;
    while (n < near.length && n < maxVehicles && near[n][0] < RANGE_M) n++;
    ref[0] = pose.position.x; ref[1] = pose.position.y; ref[2] = pose.position.z;
    const pr = pose.position, cr = pose.right, cu = pose.up, cf = pose.forward;
    const lamps = HEAD_LAMPS.map(([x, y, z]) => [pr.x + cr.x * x + cu.x * y + cf.x * z, pr.y + cr.y * x + cu.y * y + cf.y * z, pr.z + cr.z * x + cu.z * y + cf.z * z]);
    const red = LAMP_RGB.red;
    for (let j = 0; j < n; j++) {
      const i = near[j][1], i3 = 3 * i;
      const len = lengths[placed.body[i]] || 4.6;
      const truck = len > 7;
      const half = truck ? 1.05 : 0.78, scale = truck ? 1.3 : 1;
      const Fx = F[i3], Fy = F[i3 + 1], Fz = F[i3 + 2], Ux = U[i3], Uy = U[i3 + 1], Uz = U[i3 + 2];
      const Rx = Fy * Uz - Fz * Uy, Ry = Fz * Ux - Fx * Uz, Rz = Fx * Uy - Fy * Ux;
      const strength = SPRAY_OPACITY * sprayStrength(wetness, placed.speed[i]) * placed.alpha[i];
      // the vehicle following this one in its lane (its head lamps light the spray), within 60 m
      let follow = Infinity;
      for (let m = 0; m < near.length; m++) {
        const k = near[m][1];
        if (k === i || placed.dir[k] !== placed.dir[i] || placed.lane[k] !== placed.lane[i]) continue;
        const gx = P[i3] - P[3 * k], gy = P[i3 + 1] - P[3 * k + 1], gz = P[i3 + 2] - P[3 * k + 2];
        const along = gx * Fx + gy * Fy + gz * Fz;
        if (along > 0 && along < 60 && along < follow) follow = along;
      }
      vehicles++;
      for (let q = 0; q < PUFFS.length; q++) {
        const [xs, back, y, size, share] = PUFFS[q];
        const x = xs * half, z = len / 2 + back * scale;
        const px = P[i3] + Rx * x + Ux * y * scale - Fx * z, py = P[i3 + 1] + Ry * x + Uy * y * scale - Fy * z, pz = P[i3 + 2] + Rz * x + Uz * y * scale - Fz * z;
        // light on the puff, lux: ambient at night, the visitor's low beam, the follower's head lamps, the tail lamps inside
        let white = AMBIENT_NIGHT_LUX * lights;
        if (beams > 0) {
          for (const L of lamps) {
            const vx = px - L[0], vy = py - L[1], vz = pz - L[2];
            const d2 = Math.max(vx * vx + vy * vy + vz * vz, 1);
            const c = [vx * cr.x + vy * cr.y + vz * cr.z, vx * cu.x + vy * cu.y + vz * cu.z, vx * cf.x + vy * cf.y + vz * cf.z];
            white += (beams * LOW_PEAK_CD * lowBeamShare(c)) / d2;
          }
        }
        if (Number.isFinite(follow)) { const g = Math.max(2, follow - 2.3 - z); white += (lights * 2 * LAMP_CD.head) / (g * g); } // 2.3: a car's half length
        const tailD = Math.max(1.5, (back + 0.5 * size) * scale); // to the puff's bulk, not its near edge
        const redLux = (lights * 2 * (LAMP_CD.tail + (placed.brake[i] ? LAMP_CD.stop : 0))) / (tailD * tailD);
        const k = (SPRAY_ALBEDO / (4 * Math.PI)) * units; // single scattering, isotropic: albedo x E / 4 pi
        const p = puffs[count];
        p.pos[0] = px - ref[0]; p.pos[1] = py - ref[1]; p.pos[2] = pz - ref[2];
        p.d = Math.hypot(px - eye.x, py - eye.y, pz - eye.z);
        p.size = size * scale;
        p.alpha = Math.min(0.9, strength * share);
        const day = 0.85 * (1 - lights); // a little under the sky behind it
        p.color[0] = day * sky.r + k * (white + redLux * red[0]);
        p.color[1] = day * sky.g + k * (white + redLux * red[1]);
        p.color[2] = day * sky.b + k * (white + redLux * red[2]);
        p.seed = ((placed.id[i] * 0.6180339887) % 1 + q * 0.17) % 1;
        count++;
      }
    }
    // far to near
    order.length = 0;
    for (let i = 0; i < count; i++) order.push(puffs[i]);
    order.sort((a, b) => b.d - a.d);
    order.forEach((p, i) => {
      A.aPos.array.set(p.pos, 3 * i); A.aSize.array[i] = p.size; A.aAlpha.array[i] = p.alpha;
      A.aColor.array.set(p.color, 3 * i); A.aSeed.array[i] = p.seed;
    });
    for (const a of Object.values(A)) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, count) * a.itemSize); a.needsUpdate = true; }
    geometry.instanceCount = count;
    mesh.visible = count > 0;
    uniforms.uTime.value = (simMs / 1000) % 1000;
  }

  return {
    mesh, update,
    get sprites() { return mesh.visible ? count : 0; },
    get vehicles() { return vehicles; },
    dispose() { parent.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}

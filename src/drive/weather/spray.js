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
import { createPuffs, writePuffs, MAX_VEHICLES } from './sprayPuffs.js';

export { MAX_VEHICLES, RANGE_M, SPRAY_OPACITY, SPRAY_FULL_MPS, SPRAY_ALBEDO, AMBIENT_NIGHT_LUX, PUFFS, sprayStrength } from './sprayPuffs.js';

export function createSpray({ parent, maxVehicles = MAX_VEHICLES }) {
  const st = createPuffs(maxVehicles);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const attr = (k, n) => { const a = new THREE.InstancedBufferAttribute(st.arrays[k], n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const A = { aPos: attr('aPos', 3), aSize: attr('aSize', 1), aAlpha: attr('aAlpha', 1), aColor: attr('aColor', 3), aSeed: attr('aSeed', 1) };
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
  const ref = st.ref;
  const cam = new THREE.Vector3();
  mesh.onBeforeRender = (renderer, scene, camera) => {
    camera.getWorldPosition(cam);
    uniforms.uRef.value.set(ref[0] - cam.x, ref[1] - cam.y, ref[2] - cam.z);
  };
  let count = 0, vehicles = 0;

  /**
   * @param {{ placed: object|null, lengths: number[], eye: {x,y,z}, pose: object, wetness: number, simMs: number,
   *   lights: number, beams: number, units: number, sky: THREE.Color }} f
   *   placed: traffic placed(); lengths: body lengths by body index; lights: the look's night share (0 day, 1 night);
   *   beams: the visitor's headlamps' drawn strength; units: lighting.units.nit (= lux)
   */
  function update(f) {
    ({ count, vehicles } = writePuffs(st, f));
    if (!count) { mesh.visible = false; geometry.instanceCount = 0; return; }
    for (const a of Object.values(A)) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, count) * a.itemSize); a.needsUpdate = true; }
    geometry.instanceCount = count;
    mesh.visible = count > 0;
    uniforms.uTime.value = (f.simMs / 1000) % 1000;
  }

  return {
    mesh, update,
    get sprites() { return mesh.visible ? count : 0; },
    get vehicles() { return vehicles; },
    dispose() { parent.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}

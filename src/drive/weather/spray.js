// Spray behind the vehicles near the camera on a wet road (plan 02, D8.3; third stretch, decision 6). From the traffic
// part's vehicles of the frame (traffic/index.js placed()): the nearest MAX_VEHICLES moving vehicles within RANGE_M each
// throw PUFFS soft puffs behind their rear wheels, growing and thinning with distance behind, stronger with speed and
// wetness. Lit by the sky by day; at night by a little ambient light, by the vehicle's own tail lamps inside the spray
// (red, more when it brakes), by the head lamps of the vehicle following it, and by the visitor's low beam when the
// spray is in it. A pure function of the vehicles of the frame, the weather and the look. Cheap: at most 64 sprites, one
// draw. The puffs are worked out on the CPU by sprayPuffs.js (with its numbers); this draws them in the pipeline's scene
// pass, in linear HDR: soft camera-facing puffs, premultiplied "over" blending, sorted far to near.
//
// Light units (decision 6). update() takes `units` (dimensionless: cityFactor, which the lamps' light obeys) and `sky`
// (cd/m^2), so the CPU writes each puff's radiance in cd/m^2; the shader multiplies by the light scale
// (photometry.js lightScale: the pre-exposure).
//
// First rain. The mesh is drawn with no instances while dry until the weather part has had it in a frame (three
// builds its program then and draws nothing), so the first rain builds no program.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, varyingProperty, cameraViewMatrix, cameraProjectionMatrix, float, vec2, vec3, vec4, select,
  fract, floor, dot, mix, exp, smoothstep, clamp, Discard, If } from 'three/tsl';
import { createPuffs, writePuffs, MAX_VEHICLES } from './sprayPuffs.js';
import { photometryContext, lightScale } from '../lights/photometry.js';

export { MAX_VEHICLES, sprayStrength } from './sprayPuffs.js';

const vUv = varyingProperty('vec2', 'vSprUv');
const vAlpha = varyingProperty('float', 'vSprAlpha');
const vColor = varyingProperty('vec3', 'vSprColor');
const vSeed = varyingProperty('float', 'vSprSeed');

const h21 = (p0) => {
  const p = fract(p0.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
};
const vnoise = (p) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  return mix(mix(h21(i), h21(i.add(vec2(1, 0))), u.x), mix(h21(i.add(vec2(0, 1))), h21(i.add(vec2(1, 1))), u.x), u.y);
};

/**
 * @param {{ parent: THREE.Object3D, maxVehicles?: number, photometry?: object }} o  photometry: the light scale's
 *   context (photometry.js photometryContext)
 */
export function createSpray({ parent, maxVehicles = MAX_VEHICLES, photometry = {} }) {
  const st = createPuffs(maxVehicles);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)); // unread
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const attr = (k, n) => { const a = new THREE.InstancedBufferAttribute(st.arrays[k], n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const A = { aPos: attr('aPos', 3), aSize: attr('aSize', 1), aAlpha: attr('aAlpha', 1), aColor: attr('aColor', 3), aSeed: attr('aSeed', 1) };
  for (const [k, a] of Object.entries(A)) geometry.setAttribute(k, a);
  geometry.instanceCount = 0;
  const uRef = uniform(new THREE.Vector3()).setName('uSprayRef');
  const uTime = uniform(0).setName('uSprayTime');
  const scale = lightScale(photometryContext(photometry));

  const material = new MeshBasicNodeMaterial({ name: 'spray', transparent: true, premultipliedAlpha: true, blending: THREE.NormalBlending,
    depthWrite: false, depthTest: true, fog: false });
  material.lights = false;
  material.vertexNode = Fn(() => {
    const corner = attribute('corner', 'vec2');
    const aAlpha = attribute('aAlpha', 'float');
    const v = cameraViewMatrix.mul(vec4(attribute('aPos', 'vec3').add(uRef), 0)).xyz.toVar('sprV');
    vUv.assign(corner);
    vAlpha.assign(aAlpha);
    vColor.assign(attribute('aColor', 'vec3'));
    vSeed.assign(attribute('aSeed', 'float'));
    const moved = vec3(v.xy.add(corner.mul(attribute('aSize', 'float'))), v.z);
    const clip = cameraProjectionMatrix.mul(vec4(moved, 1));
    return select(aAlpha.lessThanEqual(0).or(v.z.greaterThan(-0.3)), vec4(2, 2, 2, 1), clip);
  })();
  material.colorNode = Fn(() => {
    const r2 = dot(vUv, vUv);
    If(r2.greaterThan(1), () => { Discard(); });
    const body = exp(r2.mul(-3)).mul(float(1).sub(smoothstep(0.6, 1, r2))).mul(smoothstep(-1, -0.35, vUv.y)).toVar('sprBody');
    const p = vUv.mul(1.7).add(vec2(vSeed.mul(17), vSeed.mul(5).add(uTime.mul(0.9)))).toVar('sprP');
    const n = vnoise(p).mul(0.6).add(vnoise(p.mul(2.3).add(7.1)).mul(0.4));
    const a = clamp(vAlpha.mul(body).mul(n.mul(1.1).add(0.45)), 0, 1).toVar('sprA');
    return vec4(vColor.mul(scale), a); // three premultiplies (premultipliedAlpha): vec4(colour x a, a)
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'spray';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 9;
  mesh.visible = false;
  parent.add(mesh);
  const cam = new THREE.Vector3();
  mesh.onBeforeRender = (renderer, scene, camera) => {
    camera.getWorldPosition(cam);
    uRef.value.set(st.ref[0] - cam.x, st.ref[1] - cam.y, st.ref[2] - cam.z);
  };
  let count = 0, vehicles = 0;

  /**
   * This frame's spray (sprayPuffs.js writePuffs), with `units` dimensionless (cityFactor) and `sky` in cd/m^2 (see the
   * header).
   * @param {{ placed: object|null, lengths: number[], eye: {x,y,z}, pose: object, wetness: number, simMs: number,
   *   lights: number, beams: number, units: number, sky: {r,g,b} }} f
   */
  function update(f) {
    ({ count, vehicles } = writePuffs(st, f));
    if (!count) { mesh.visible = false; geometry.instanceCount = 0; return; }
    for (const a of Object.values(A)) { a.clearUpdateRanges(); a.addUpdateRange(0, count * a.itemSize); a.needsUpdate = true; }
    geometry.instanceCount = count;
    mesh.visible = true;
    uTime.value = (f.simMs / 1000) % 1000;
  }

  return {
    mesh, update,
    get sprites() { return mesh.visible ? count : 0; },
    get vehicles() { return vehicles; },
    dispose() { parent.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}

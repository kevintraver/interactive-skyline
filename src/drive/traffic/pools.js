// Headlamp pools of other vehicles (plan 02, D6.4): a soft pool of light on the road ahead of each of the
// nearest lit vehicles, as an instanced additive decal (pools.glsl.js). One draw call, at most MAX_POOLS
// instances; nothing by day. Cheap: no lights, no shadow maps, no change to the road's materials. On a wet road the
// pools are weakened as the visitor's own is (pools.glsl.js; the cover from lights/sprites.js TWIN_UNIFORMS).
// The CPU side (the decal, the nearest lit vehicles, the pool model in JavaScript) is poolsCore.js, shared with
// pools.node.js (plan 01's renderer); this file is the GLSL material.

import * as THREE from 'three';
import { poolVertex, poolFragment } from './pools.glsl.js';
import { SHADOW_PULL } from './material.js';
import { LAMP_RGB } from './lamps.js';
import { TWIN_UNIFORMS } from '../lights/sprites.js';
import { WET_DIFFUSE, GLOSS } from '../weather/wetMirror.js';
import { createPoolsWith, ASPHALT_RHO, POOL_LENGTH_M } from './poolsCore.js';

export { MAX_POOLS, POOL_RANGE_M, POOL_LENGTH_M, ASPHALT_RHO, poolBeam, poolIlluminance, poolLuminance } from './poolsCore.js';

/**
 * @param {{ parent: THREE.Object3D, sidecar: object, bodyNames: string[] }} opts sidecar: vehicles.json (head lamp positions)
 */
export function createPools({ parent, sidecar, bodyNames }) {
  const uniforms = {
    uLength: { value: POOL_LENGTH_M }, uHalfWidth: { value: 12 }, uPull: { value: SHADOW_PULL * 1.2 },
    uGain: { value: 0.1 }, uRho: { value: ASPHALT_RHO }, uColor: { value: new THREE.Vector3(...LAMP_RGB.white) },
    // the wet road: the weather part's cover for the twins (the same object, so it follows without a call here)
    uTwinWet: TWIN_UNIFORMS.uTwinWet, uWetPool: { value: new THREE.Vector2(GLOSS.twin, WET_DIFFUSE) },
  };
  return createPoolsWith({
    parent, sidecar, bodyNames, uniforms,
    material: () => new THREE.ShaderMaterial({
      name: 'traffic-head-pools', uniforms, vertexShader: poolVertex, fragmentShader: poolFragment,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: true, fog: false,
    }),
  });
}

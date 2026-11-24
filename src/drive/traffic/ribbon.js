// Light ribbons on the route's own road (plan 02, D6.4): beyond the lamp sprites every lane of both carriageways
// is one emissive strip out to the horizon, its light density x per-vehicle intensity: the red river ahead and
// the white one coming. Shader and the flux rule: ribbon.glsl.js. One draw call.
//
// Geometry (per route, once): each lane's centre line from the lane map (lanemap.js), sampled every STEP_M of
// route chainage, at LAMP_H above the pavement, with its direction of travel, lane weight and truck share.
// Density (per frame, cheap): demand.js laneDensities at every BIN_M of route chainage for three quantised
// times t_q, t_q + Q, t_q + 2Q (Q = DENSITY_Q_MS); the shader mixes the first two by (t - t_q) / Q, so the light
// changes continuously with time, and the third is worked out a slice per frame while the first two are in use
// (all of it at once after a seek). The rows are a pure function of t_q.
// That CPU work is ribbonCore.js's, shared with ribbon.node.js (plan 01's renderer); this file is the GLSL material.

import * as THREE from 'three';
import { ribbonVertex, ribbonFragment } from './ribbon.glsl.js';
import { createRibbonsWith } from './ribbonCore.js';

export { STEP_M, BIN_M, DENSITY_Q_MS, LAMP_H, WIDTH_PX } from './ribbonCore.js';

/**
 * @param {{ parent: THREE.Object3D, traffic: object, laneMap: object, frame: object }} opts
 */
export function createRibbons({ parent, traffic, laneMap, frame }) {
  return createRibbonsWith({
    parent, traffic, laneMap, frame,
    uniform: (value) => ({ value }),
    gain0: 0.1,
    material: (uniforms) => new THREE.ShaderMaterial({
      name: 'traffic-ribbons', uniforms, vertexShader: ribbonVertex, fragmentShader: ribbonFragment,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    }),
  });
}

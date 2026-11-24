// The `valley` drive part (plan 02, D6.6): traffic on the rest of the valley as light ribbons, no vehicles.
//
// Every freeway and principal arterial of the valley is a pair of thin glowing strips on the ground, one per
// direction, offset to the right of travel. The driven routes' own carriageways are in the file as groups by route
// (valleyFormat.js); the part leaves out the group(s) of the route being driven (setRoute), whose traffic is drawn
// as vehicles by the `traffic` part, and keeps the other routes' freeways lit.
// Their brightness is the light of the vehicles on them at the moment: vehicles per metre (daily volume x the
// hour-of-week shape / speed) x each vehicle's intensity toward the eye, white where the traffic comes toward the
// eye (head lamps), red where it goes away (tail lamps), with a pattern drifting along at the traffic's speed.
// The arithmetic is valleyModel.js, mirrored by valley.glsl.js; the data is public/data/<city>/traffic/valley.json
// + valley.bin (scripts/build_valley_traffic.py, read by valleyFormat.js), the strips valleyGeometry.js.
//
// One draw call. Per frame the part sets six uniforms (the hour of week, the drift time, the pixel angle, the
// visibility); nothing else runs on the CPU. Off by day: drawn only while the look's `lights` is above zero,
// scaled by it. Faded out within NEAR_M of the eye, where a strip would read as paint on the ground and where the
// route's own traffic is drawn as vehicles anyway.
//
// The part's CPU side is valleyCore.js, shared with valley.node.js (plan 01's renderer); this file is the GLSL material.

import * as THREE from 'three';
import { valleyVertex, valleyFragment } from './valley.glsl.js';
import { createValleyPartWith } from './valleyCore.js';

export { NEAR_M, MIN_PX } from './valleyCore.js';

/** @param {object} ctx the part context (parts.js) */
export function createValleyPart(ctx) {
  return createValleyPartWith(ctx, {
    uniform: (value) => ({ value }),
    unit: ctx.env.lighting.units.nit,
    material: (uniforms) => new THREE.ShaderMaterial({
      name: 'valley-ribbons', uniforms, vertexShader: valleyVertex, fragmentShader: valleyFragment,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
      side: THREE.DoubleSide,
    }),
  });
}

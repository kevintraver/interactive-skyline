// Drawing the placed vehicles (plan 02, D6.4) on plan 01's renderer: the sibling of render.js (plan 02, third stretch,
// decision 2), with the same factory and returned object; renderCore.js does the work with material.node.js's
// materials. render.js's header describes it.
//
// What differs from render.js:
//  - the light's scale (decision 6): `lightScale` (a TSL node: photometry.node.js artificialScale, the pre-exposure x
//    the lights-out slider in the shipped look, LIGHTING_UNITS x the slider at the classic display) multiplies the lamp
//    faces' luminance in cd/m^2 (material.node.js).
//  - detail by plan 01's quality level (decision 8): DETAIL_PX, the size on screen above which a body is drawn
//    detailed. With the default 50 mm lens at 1280 x 720 a sedan is detailed to about 120 m on Low, 210 m on High (the
//    classic renderer's LOD0_PX) and 330 m on Ultra.

import * as MATERIALS from './material.node.js';
import { createTrafficRendererWith, LOD0_PX } from './renderCore.js';

export { LOD0_PX, MIN_PX, FADE_PX, LAMP_KIND } from './renderCore.js';

/** Size on screen (px) above which a body is drawn detailed, by plan 01's quality level. */
export const DETAIL_PX = Object.freeze({ low: 24, high: LOD0_PX, ultra: 9 });

/**
 * @param {{ parent: import('three').Object3D, sidecar: object, gltf: object,
 *   lightScale?: number | import('three/webgpu').Node }} opts sidecar: vehicles.json; gltf: the loaded vehicles.glb
 */
export function createTrafficRenderer({ parent, sidecar, gltf, lightScale = 1 }) {
  return createTrafficRendererWith({ parent, sidecar, gltf, materials: MATERIALS, shared: MATERIALS.createTrafficUniforms({ lightScale }) });
}

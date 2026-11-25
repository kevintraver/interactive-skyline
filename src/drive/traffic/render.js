// Drawing the placed vehicles (plan 02, D6.4): one InstancedMesh per body and level of detail (twelve
// draw calls at most) and one for the contact shadows, filled each frame from the fleet's placement and
// the camera. No allocation per frame: instance buffers have fixed capacities (a frame with more
// vehicles than that drops the farthest-listed ones and counts them in stats().dropped).
//
// Level of detail by size on screen. A freeway's vehicles are seen mostly end on, so a body's size is the
// mean of its width and height (1.65 m for a sedan, 3.35 m for a tractor-trailer). A body is drawn
// detailed while that covers at least LOD0_PX pixels, coarse down to MIN_PX, and not at all below; it
// dissolves between MIN_PX and MIN_PX + FADE_PX so the hand-over to nothing (and, at night, to the light
// sprites) never pops. The detailed level (about 600 triangles) is the near one; the coarse (about 60)
// carries the rest. With the default 50 mm lens at 1280 x 720 that is detailed to about 210 m for a sedan
// and coarse to about 1 km; the fleet's range (rangeFor) ends 30% beyond that, where the trucks, still
// 4 to 5 pixels, dissolve over its last 150 m.
//
// Lamp points (for the light sprites, D6.4's next step): lampPoints() lists every lamp of every vehicle
// drawn this frame, from vehicles.json's lamp positions:
//   { count, position: Float32Array(3n) scene metres, facing: Float32Array(3n) unit vector the lens faces,
//     kind: Uint8Array (LAMP_KIND: 0 head, 1 tail, 2 brake, 3 marker), colour: Uint8Array (0 white, 1 red,
//     2 amber), id: Float64Array the vehicle's id, alpha: Float32Array the vehicle's dissolve (0..1),
//     distance: Float32Array metres from the camera }
// Tail lamps are always listed (kind 1); a braking vehicle adds its tail lamps and the high-mounted stop
// lamp again as kind 2. Side markers and the trucks' clearance and identification lamps are kind 3. The
// arrays are reused: read them before the next frame.
//
//
// Light (plan 02, third stretch, decision 6): `lightScale` (a TSL node: photometry.js artificialScale, the
// pre-exposure x the lights-out slider) multiplies the lamp faces' luminance in cd/m^2 (material.js).
// Detail by plan 01's quality level (decision 8): DETAIL_PX, the size on screen above which a body is drawn detailed.
// With the default 50 mm lens at 1280 x 720 a sedan is detailed to about 120 m on Low, 210 m on High and 330 m on
// Ultra. The work is renderCore.js's, given material.js's materials.

import * as MATERIALS from './material.js';
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

// Vehicle lamps as light sprites (plan 02, D6.4) on the classic renderer: one sprite layer (lights/sprites.js) holding
// every lamp of every vehicle out to the sprite range, rewritten each frame. The work is lampCore.js's (read its
// header), shared with lampLayer.node.js (plan 01's renderer). Photometry and switching: lamps.js.

import { createSpriteLayer } from '../lights/sprites.js';
import { createLampLayerWith, CAPACITY } from './lampCore.js';

export { CAPACITY, NEAR_BAND_M, WHITEN } from './lampCore.js';

/**
 * @param {{ parent: THREE.Object3D, sidecar: object }} opts sidecar: vehicles.json
 */
export function createLampLayer({ parent, sidecar, capacity = CAPACITY }) {
  return createLampLayerWith({ parent, sidecar, capacity, createSpriteLayer });
}

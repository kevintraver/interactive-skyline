// Vehicle lamps as light sprites (plan 02, D6.4) on plan 01's renderer: the sibling of lampLayer.js (plan 02, third
// stretch, decision 2), with the same factory and returned object, over lights/sprites.node.js. The work is
// lampCore.js's. Each lamp is a point source in candela: the node layer draws it with the flux rule (E = I / d^2 at the
// eye) in scene-referred light times photometry.node.js's scale (decision 6). Its reflected twins on a wet road are
// the node layer's (`reflect`), driven by the weather part through sprites.node.js setTwins like every reflecting layer.

import { createSpriteLayer } from '../lights/sprites.node.js';
import { createLampLayerWith, CAPACITY } from './lampCore.js';

export { CAPACITY, NEAR_BAND_M, WHITEN } from './lampCore.js';

/**
 * @param {{ parent: import('three').Object3D, sidecar: object, capacity?: number, photometry?: object }} opts
 *   sidecar: vehicles.json; photometry: the light scale's context (lights/photometry.node.js photometryContext)
 */
export function createLampLayer({ parent, sidecar, capacity = CAPACITY, photometry = {} }) {
  return createLampLayerWith({ parent, sidecar, capacity, createSpriteLayer, layerOptions: { photometry } });
}

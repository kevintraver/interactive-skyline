// Vehicle lamps as light sprites (plan 02, D6.4), over lights/sprites.js; the work is lampCore.js's. Each lamp is
// a point source in candela: the layer draws it with the flux rule (E = I / d^2 at the eye) in scene-referred light
// times photometry.js's scale (third stretch, decision 6). Its reflected twins on a wet road are the layer's
// (`reflect`), driven by the weather part through sprites.js setTwins like every reflecting layer.

import { createSpriteLayer } from '../lights/sprites.js';
import { createLampLayerWith, CAPACITY } from './lampCore.js';

export { CAPACITY, NEAR_BAND_M } from './lampCore.js';

/**
 * @param {{ parent: import('three').Object3D, sidecar: object, capacity?: number, photometry?: object }} opts
 *   sidecar: vehicles.json; photometry: the light scale's context (lights/photometry.js photometryContext)
 */
export function createLampLayer({ parent, sidecar, capacity = CAPACITY, photometry = {} }) {
  return createLampLayerWith({ parent, sidecar, capacity, createSpriteLayer, layerOptions: { photometry } });
}

// The roadside's material: a MeshLambertNodeMaterial with no custom shading, made explicitly (not left to three's
// automatic conversion) so the lights part can add its surface terms to it; its `userData.surfaceLight` names the
// kind: 'sign', 'support', 'delineator'.
import { MeshLambertNodeMaterial } from 'three/webgpu';

/**
 * @param {object} params   MeshLambertMaterial parameters
 * @param {string} [surface] the kind of surface, for the lights part
 */
export function lambert(params, surface) {
  const m = new MeshLambertNodeMaterial(params);
  if (surface) m.userData.surfaceLight = surface;
  return m;
}

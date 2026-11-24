// The roadside's stock material on either renderer (plan 02, third stretch, decision 2): a MeshLambertMaterial on the
// classic renderer, a MeshLambertNodeMaterial with the same parameters on plan 01's. Neither has custom shading, so one
// small module picks; the node material is made explicitly (not left to three's automatic conversion) so the lights
// part can add its surface terms to it (its `userData.surfaceLight` names the kind: 'sign', 'support', 'delineator'),
// and a material with an emissive (the night glow of the headlight stand-in) gets it in physical units (glow.node.js).
import { MeshLambertMaterial } from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { standInEmissive } from '../roadnet/glow.node.js';

/**
 * @param {boolean} legacy  true on the classic renderer
 * @param {object} params   MeshLambertMaterial parameters
 * @param {string} [surface] the kind of surface, for the lights part (node materials only)
 */
export function lambert(legacy, params, surface) {
  if (legacy) return new MeshLambertMaterial(params);
  const m = new MeshLambertNodeMaterial(params);
  // a night glow (the headlight stand-in) is light: cd/m2 x the pre-exposure in the shipped look (glow.node.js)
  if (params.emissive !== undefined) m.emissiveNode = standInEmissive();
  if (surface) m.userData.surfaceLight = surface;
  return m;
}

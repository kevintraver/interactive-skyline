// The drive's ground and water materials on either renderer (plan 02, third stretch, decision 2): three's stock Lambert
// and Phong on the classic renderer, the same parameters as node materials on plan 01's. No custom shading, so one
// module picks; the node materials are made explicitly so the drive's lights can add surface terms to the ground
// (src/drive/parts.js eachGround) and plan 01's wet layer can reach it later.
import { MeshLambertMaterial, MeshPhongMaterial } from 'three';
import { MeshLambertNodeMaterial, MeshPhongNodeMaterial } from 'three/webgpu';

/** The ground's material: the aerial photo as albedo. */
export function groundMaterial(map, { legacy = true } = {}) {
  if (legacy) return new MeshLambertMaterial({ map });
  const m = new MeshLambertNodeMaterial({ map });
  m.userData.surfaceLight = 'ground';
  return m;
}

/** Water: plain, slightly glossy, pulled a little toward the camera over the flat ground under it. */
export function waterMaterial(params, { legacy = true } = {}) {
  return legacy ? new MeshPhongMaterial(params) : new MeshPhongNodeMaterial(params);
}

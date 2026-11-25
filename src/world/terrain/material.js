// The drive's ground and water materials: three's Lambert and Phong as node materials, with no custom shading. They are
// made explicitly so the drive's lights can add surface terms to the ground (src/drive/parts.js eachGround).
import { MeshLambertNodeMaterial, MeshPhongNodeMaterial } from 'three/webgpu';

/** The ground's material: the aerial photo as albedo. */
export function groundMaterial(map) {
  const m = new MeshLambertNodeMaterial({ map });
  m.userData.surfaceLight = 'ground';
  return m;
}

/** Water: plain, slightly glossy, pulled a little toward the camera over the flat ground under it. */
export function waterMaterial(params) {
  return new MeshPhongNodeMaterial(params);
}

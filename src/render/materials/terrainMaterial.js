// The ground's material (plan 01, T2.3): the aerial photo as albedo, and the same photo as the emissive map that the
// legacy sky lights with its street glow at night (sky.look: emissive colour and intensity per grid). On the new
// renderer a MeshLambertNodeMaterial with exactly those properties, so the settings panel (photo on or off) and the
// legacy sky drive it unchanged; on the classic renderer the MeshLambertMaterial it always was. Phase 4 gives the
// emission its physical units from the night-lights product (section 7.12, "Terrain").
import { MeshLambertMaterial } from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { active } from '../active.js';

export function createTerrainMaterial(map) {
  return active.legacy ? new MeshLambertMaterial({ map }) : new MeshLambertNodeMaterial({ map });
}

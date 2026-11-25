/**
 * The road ribbon's materials (plan 02, D3.5; third stretch, decisions 6 and 7): asphalt, lane markings, barriers, decks
 * and embankment dirt from one canvas atlas (textures.js), as Lambert node materials lit by the scene's lights; aerial
 * perspective and fog are the pipeline's.
 *
 * Two materials share the textures: `road` for most of the network and `roadNear` for chunks close to the car (the
 * chunk manager's split, chunks.js); they draw the same.
 *
 * Depth (decision 7). With reversed depth on both backends the pavement needs no pull toward the camera: the depth test
 * of the port (2026-11-23, Apple M4, both backends) found that pulling pavement by 0.2 % of its distance changed at most
 * one pixel of a 1280 x 720 frame of the road 15 to 22 km ahead and of the valley from Railroad Pass, and pushing it
 * away by fifty times that about sixty. Seen at grazing angles the ground under the road is kilometres behind it along
 * the ray, and reversed float depth resolves millimetres there.
 *
 * Light (decision 6): both materials carry `userData.surfaceLight = 'road'`; the lights part adds its terms
 * (src/drive/lights/surfaceLight.js) to them through the session's eachSurface(). `nightMap` is the atlas drawn
 * with its night paint: it is not drawn on the road; the headlights part reads its marking mask from it.
 */
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { atlasTexture } from './textures.js';

/**
 * @param {{ anisotropy?: number }} [opts]
 * @returns {{ road: MeshLambertNodeMaterial, roadNear: MeshLambertNodeMaterial, map: object|null, nightMap: object|null,
 *   dispose(): void }}
 */
export function createRoadMaterials({ anisotropy = 1 } = {}) {
  const map = atlasTexture(false, anisotropy);
  const nightMap = atlasTexture(true, anisotropy);
  const make = (name) => {
    const m = new MeshLambertNodeMaterial({ map, color: map ? 0xffffff : 0x55534f });
    m.name = name;
    m.userData.surfaceLight = 'road';
    return m;
  };
  const road = make('road'), roadNear = make('road-near');
  return {
    road, roadNear, map, nightMap,
    dispose() { road.dispose(); roadNear.dispose(); map?.dispose(); nightMap?.dispose(); },
  };
}

// The drive's terrain patches as scene objects: for each patch in terrain.json, its ground mesh draped with its
// image, a skirt from its edge, and its water. The provider (index.js) loads the heights; this loads the image and
// the water and builds the meshes. Drive-only: nothing here is fetched before Drive is entered.

import * as THREE from 'three';
import { buildPatchMesh } from './widemesh.js';
import { buildSkirt } from './skirt.js';
import { buildWaterMesh } from './water.js';

/** Metres a patch's skirt hangs below its edge: the patch eases into the wide heights there, so this only covers rounding. */
export const PATCH_SKIRT = 6;
/** The ground's colour without imagery, as the wide mesh's. */
const PLAIN = 0xbdb9ad;

/** What buildPatches gives for a city without patches, or when they failed to load (the wide grid stands in). */
export const NO_PATCHES = Object.freeze({ grids: [], ground: [], objects: [], setImagery() {} });

/**
 * @param {{ terrain: object, base: number, renderer: THREE.WebGLRenderer,
 *           image: (file: string) => Promise<ImageBitmap|null>, json: (file: string) => Promise<object|null> }} opts
 *   terrain is the provider; image and json fetch a file of the city's data directory (null when it is missing).
 * @returns {Promise<{ grids: object[], ground: Array<[THREE.Mesh, string]>, objects: THREE.Object3D[],
 *           setImagery(on: boolean): void }>}  grids for the wide mesh's cuts; ground as the app's ground list
 *           (mesh, id), for the parts that add terms to ground materials; objects to add to the scene
 */
export async function buildPatches({ terrain, base, renderer, image, json }) {
  const list = await terrain.loadPatches();
  const built = await Promise.all(list.map(async ({ id, grid, info }) => {
    const [bitmap, water] = await Promise.all([
      info.image ? image(info.image).catch(() => null) : null,
      info.water ? json(info.water).catch(() => null) : null,
    ]);
    let map = null;
    if (bitmap) {
      map = new THREE.Texture(bitmap);
      map.flipY = false; // flipped while decoding, as for the wide grid
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = renderer.capabilities.getMaxAnisotropy();
      map.needsUpdate = true;
    }
    const mesh = buildPatchMesh({ patch: grid, id, base, map });
    const skirt = buildSkirt(mesh, grid, PATCH_SKIRT);
    const sheet = water ? buildWaterMesh(water, { base, name: `water-${id}` }) : null;
    return { id, grid, mesh, map, objects: [mesh, skirt, ...(sheet ? [sheet] : [])] };
  }));
  return {
    grids: built.map((b) => b.grid),
    ground: built.map((b) => [b.mesh, b.id]),
    objects: built.flatMap((b) => b.objects),
    setImagery(on) {
      for (const b of built) {
        b.mesh.material.map = on ? b.map : null;
        b.mesh.material.color.set(on ? 0xffffff : PLAIN);
        b.mesh.material.needsUpdate = true;
      }
    },
  };
}

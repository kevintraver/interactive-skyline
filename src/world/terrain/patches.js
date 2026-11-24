// The drive's terrain patches as scene objects: for each patch in terrain.json, its ground mesh draped with its
// image, a skirt from its edge, and its water. The provider (index.js) loads the heights; this loads the image and
// the water and builds the meshes. Drive-only: nothing here is fetched before Drive is entered, and a patch only when a
// route that passes it is chosen (patchesCrossing; session.js).

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

/** How far outside a patch a route may pass and still get it, metres: the finer ground is seen from about there. */
export const PATCH_REACH = 3000;

/**
 * The patches a route needs: those whose extent, grown by `reach`, overlaps the box of the route's outline. Pure.
 * @param {Array<[number, number]>} outline the route's outline (routes.json: local metres, x east, y north)
 * @param {Record<string, { x0: number, y0: number, nx: number, ny: number, step: number }>} patches terrain.json's "patches"
 * @param {number} [reach]
 * @returns {string[]} patch ids, in the manifest's order
 */
export function patchesCrossing(outline, patches, reach = PATCH_REACH) {
  if (!Array.isArray(outline) || !outline.length || !patches) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outline) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return Object.entries(patches).filter(([, p]) => {
    const px1 = p.x0 + (p.nx - 1) * p.step, py1 = p.y0 + (p.ny - 1) * p.step;
    return x1 >= p.x0 - reach && x0 <= px1 + reach && y1 >= p.y0 - reach && y0 <= py1 + reach;
  }).map(([id]) => id);
}

/**
 * @param {{ terrain: object, base: number, renderer: THREE.WebGLRenderer,
 *           image: (file: string) => Promise<ImageBitmap|null>, json: (file: string) => Promise<object|null>, ids?: string[],
 *           legacy?: boolean }} opts  legacy false: node materials (plan 01's renderer)
 *   terrain is the provider; image and json fetch a file of the city's data directory (null when it is missing); ids
 *   the patches to build (default all; patchesCrossing picks a route's).
 * @returns {Promise<{ grids: object[], ground: Array<[THREE.Mesh, string]>, objects: THREE.Object3D[],
 *           setImagery(on: boolean): void }>}  grids for the wide mesh's cuts; ground as the app's ground list
 *           (mesh, id), for the parts that add terms to ground materials; objects to add to the scene
 */
export async function buildPatches({ terrain, base, renderer, image, json, ids, legacy = true }) {
  const list = await terrain.loadPatches(ids);
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
      map.anisotropy = renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : renderer.capabilities.getMaxAnisotropy();
      map.needsUpdate = true;
    }
    const mesh = buildPatchMesh({ patch: grid, id, base, map, legacy });
    const skirt = buildSkirt(mesh, grid, PATCH_SKIRT);
    const sheet = water ? buildWaterMesh(water, { base, name: `water-${id}`, legacy }) : null;
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

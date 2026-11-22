// The mesh for the coarse wide grid that reaches the drive routes. Built the way terrainMesh() in
// main.js builds the far grid under the near one, so the wide ground meets the far ground the
// same way: curvature baked, the cells well inside the far grid cut out, and the posts under the
// far grid's footprint sunk 8 m so the far mesh always wins where both are drawn.
//
// The drive's patches (finer grids inside the wide one) are drawn by buildPatchMesh, the same builder
// with no hole, and the wide mesh leaves out every cell that lies inside a patch (`cuts`). A patch's
// edges lie on wide posts and ease into the wide heights (scripts/build_terrain.py), so the two meshes
// share their edge and need no sink; a skirt from the patch's edge (skirt.js) covers rounding.

import * as THREE from 'three';
import { curveDrop } from '../frame.js';

const SINK = 8;

/**
 * Flags of the cells (i, j) of a grid whose four posts all lie inside one of `cuts` (edges included).
 * @param {{ nx: number, ny: number, x0: number, y0: number, step: number }} g
 * @param {Array<{ nx: number, ny: number, x0: number, y0: number, step: number }>} cuts
 * @returns {(i: number, j: number) => boolean}
 */
export function cellsInside(g, cuts) {
  const spans = cuts.map((c) => {
    const x1 = c.x0 + (c.nx - 1) * c.step, y1 = c.y0 + (c.ny - 1) * c.step;
    const ix = new Uint8Array(g.nx), iy = new Uint8Array(g.ny);
    for (let i = 0; i < g.nx; i++) { const x = g.x0 + i * g.step; ix[i] = x >= c.x0 && x + g.step <= x1 ? 1 : 0; }
    for (let j = 0; j < g.ny; j++) { const y = g.y0 + j * g.step; iy[j] = y >= c.y0 && y + g.step <= y1 ? 1 : 0; }
    return [ix, iy];
  });
  return (i, j) => spans.some(([ix, iy]) => ix[i] && iy[j]);
}

/**
 * @param {{ wide: ReturnType<import('./heightfield.js').heightField>,
 *           hole: ReturnType<import('./heightfield.js').heightField> | null,
 *           cuts?: Array<ReturnType<import('./heightfield.js').heightField>>,
 *           base: number, map: THREE.Texture | null }} opts
 *   hole is the grid drawn on top (the far grid); cuts are patches drawn in place of the cells inside them;
 *   map is ground-wide.jpg as a texture, set up by the caller.
 * @returns {THREE.Mesh} vertices are relative to the grid's centre, which is in mesh.position:
 *   out at 60 km a world-space float32 vertex would be quantised to about 4 mm.
 */
export function buildWideMesh({ wide, hole, cuts = [], base, map }) {
  const { nx, ny, step, x0, y0, scale, raw } = wide;
  // a whole number of posts from the corner, so the offset is exact
  const cx = x0 + Math.floor((nx - 1) / 2) * step, cy = y0 + Math.floor((ny - 1) / 2) * step;
  const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  // the far grid's footprint, as index ranges on this grid
  const inside = (v, lo, hi, inset) => v > lo + inset && v < hi - inset;
  const hx = hole && [hole.x0, hole.x0 + (hole.nx - 1) * hole.step], hy = hole && [hole.y0, hole.y0 + (hole.ny - 1) * hole.step];
  const inX = new Uint8Array(nx), inY = new Uint8Array(ny);
  if (hole) {
    for (let i = 0; i < nx; i++) inX[i] = inside(x0 + i * step, ...hx, 0);
    for (let j = 0; j < ny; j++) inY[j] = inside(y0 + j * step, ...hy, 0);
  }
  const half = 1 / (2 * step);
  for (let j = 0; j < ny; j++) {
    const row = j * nx, up = Math.min(j + 1, ny - 1) * nx, dn = Math.max(j - 1, 0) * nx, y = y0 + j * step, v = j / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const k = (row + i) * 3, x = x0 + i * step;
      const sink = inX[i] && inY[j] ? SINK : 0;
      pos[k] = x - cx; pos[k + 1] = raw[row + i] * scale - base - curveDrop(x, y) - sink; pos[k + 2] = -(y - cy);
      const dx = (raw[row + Math.min(i + 1, nx - 1)] * scale - raw[row + Math.max(i - 1, 0)] * scale) * half;
      const dy = (raw[up + i] * scale - raw[dn + i] * scale) * half;
      const l = Math.hypot(dx, 1, dy);
      nor[k] = -dx / l; nor[k + 1] = 1 / l; nor[k + 2] = dy / l;
      uv[(row + i) * 2] = i / (nx - 1); uv[(row + i) * 2 + 1] = v;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(wideIndex({ wide, hole, cuts }), 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map }));
  mesh.position.set(cx, 0, -cy);
  mesh.receiveShadow = false;
  mesh.name = 'terrain-wide';
  return mesh;
}

/**
 * The wide mesh's triangles: every cell but those well inside `hole` and those inside one of `cuts` (two triangles
 * a, b, d / b, e, d per cell, post (i, j) being vertex j * nx + i).
 * @returns {Uint32Array}
 */
export function wideIndex({ wide, hole, cuts = [] }) {
  const { nx, ny, step, x0, y0 } = wide;
  const inside = (v, lo, hi, inset) => v > lo + inset && v < hi - inset;
  const cutX = new Uint8Array(nx), cutY = new Uint8Array(ny);
  if (hole) {
    const hx = [hole.x0, hole.x0 + (hole.nx - 1) * hole.step], hy = [hole.y0, hole.y0 + (hole.ny - 1) * hole.step];
    for (let i = 0; i < nx; i++) { const x = x0 + i * step; cutX[i] = inside(x, ...hx, step) && inside(x + step, ...hx, step); }
    for (let j = 0; j < ny; j++) { const y = y0 + j * step; cutY[j] = inside(y, ...hy, step) && inside(y + step, ...hy, step); }
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  const patched = cuts.length ? cellsInside(wide, cuts) : null;
  let n = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (cutX[i] && cutY[j]) continue;
      if (patched && patched(i, j)) continue;
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = d; idx[n++] = b; idx[n++] = e; idx[n++] = d;
    }
  }
  return idx.slice(0, n);
}

/**
 * Cut the cells of patches that arrive after the wide mesh was built out of it (a new index over the same vertices).
 * @param {THREE.Mesh} mesh from buildWideMesh  @param {{ wide: object, hole: object|null, cuts: object[] }} grids every cut so far
 */
export function cutWideMesh(mesh, { wide, hole, cuts }) {
  mesh.geometry.setIndex(new THREE.BufferAttribute(wideIndex({ wide, hole, cuts }), 1));
}

/**
 * The mesh for one of the drive's patches: built as the wide grid is (curvature baked, centred), whole.
 * @param {{ patch: ReturnType<import('./heightfield.js').heightField>, id: string, base: number, map: THREE.Texture | null }} opts
 */
export function buildPatchMesh({ patch, id, base, map }) {
  const mesh = buildWideMesh({ wide: patch, hole: null, base, map });
  mesh.name = `terrain-patch-${id}`;
  return mesh;
}

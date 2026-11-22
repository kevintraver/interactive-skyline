// The mesh for the coarse wide grid that reaches the drive routes. Built the way terrainMesh() in
// main.js builds the far grid under the near one, so the wide ground meets the far ground the
// same way: curvature baked, the cells well inside the far grid cut out, and the posts under the
// far grid's footprint sunk 8 m so the far mesh always wins where both are drawn.

import * as THREE from 'three';
import { curveDrop } from '../frame.js';

const SINK = 8;

/**
 * @param {{ wide: ReturnType<import('./heightfield.js').heightField>,
 *           hole: ReturnType<import('./heightfield.js').heightField> | null,
 *           base: number, map: THREE.Texture | null }} opts
 *   hole is the grid drawn on top (the far grid); map is ground-wide.jpg as a texture, set up by the caller.
 * @returns {THREE.Mesh} vertices are relative to the grid's centre, which is in mesh.position:
 *   out at 60 km a world-space float32 vertex would be quantised to about 4 mm.
 */
export function buildWideMesh({ wide, hole, base, map }) {
  const { nx, ny, step, x0, y0, scale, raw } = wide;
  // a whole number of posts from the corner, so the offset is exact
  const cx = x0 + Math.floor((nx - 1) / 2) * step, cy = y0 + Math.floor((ny - 1) / 2) * step;
  const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  // the far grid's footprint, as index ranges on this grid
  const inside = (v, lo, hi, inset) => v > lo + inset && v < hi - inset;
  const hx = hole && [hole.x0, hole.x0 + (hole.nx - 1) * hole.step], hy = hole && [hole.y0, hole.y0 + (hole.ny - 1) * hole.step];
  const inX = new Uint8Array(nx), inY = new Uint8Array(ny), cutX = new Uint8Array(nx), cutY = new Uint8Array(ny);
  if (hole) {
    for (let i = 0; i < nx; i++) { const x = x0 + i * step; inX[i] = inside(x, ...hx, 0); cutX[i] = inside(x, ...hx, step) && inside(x + step, ...hx, step); }
    for (let j = 0; j < ny; j++) { const y = y0 + j * step; inY[j] = inside(y, ...hy, 0); cutY[j] = inside(y, ...hy, step) && inside(y + step, ...hy, step); }
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
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let n = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (cutX[i] && cutY[j]) continue;
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = d; idx[n++] = b; idx[n++] = e; idx[n++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx.slice(0, n), 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map }));
  mesh.position.set(cx, 0, -cy);
  mesh.receiveShadow = false;
  mesh.name = 'terrain-wide';
  return mesh;
}

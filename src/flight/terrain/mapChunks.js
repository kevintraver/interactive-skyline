// The map's near and far ground drawn in chunks while flying (plan 03, sections 7.14 and 9.1; F8.2).
//
// The map draws each of its two ground grids (src/city/terrain.js) as one mesh: 1.4 million triangles for near and
// 1.7 million for far, all of them drawn whenever any part of the grid is in view, which from the air is every frame
// below about 10,000 ft. While flying the same triangles are drawn as chunks of about an eighth of the grid a side, each
// its own Mesh with its own bounds, so three's frustum culling leaves out the chunks the window does not show.
//
// Nothing is copied and nothing drawn changes: each chunk's geometry shares the map mesh's position, normal and uv
// attributes and its index, with its own draw range. For the ranges to be contiguous the map's index is reordered in
// place on show(true), the quads grouped chunk by chunk (each chunk's quads in their old order), and sorted back on
// show(false): the map's quads come in increasing order of their first vertex, so the sort gives the index back bit for
// bit. The map mesh is hidden meanwhile; the chunks have its material, shadows and layers.
//
// The picture (F8.2, measured 25 Nov 2026 against cba1fe2, the same moments flown twice): on WebGL2 0 to 2 pixels of
// 1,024,000 differ, on WebGPU up to 0.07 % of them, by at most 14 levels of 255, single pixels on distant lights and
// terrain. The cause is the chunks' place in three's draw order, not the triangles' order: three sorts opaque objects
// by depth and breaks ties by object id, and the chunks are made after the map's meshes, so where the ground and another
// surface meet a sample at the same depth the other one can win now. Bands of rows that keep the map's own triangle
// order give the same pixels (and cull a third as much), and the chunks switched off give none.

import { Box3, BufferGeometry, Frustum, Group, Matrix4, Mesh, Sphere } from 'three';

/**
 * When the chunks in view hold more than this share of a grid's triangles, the map's own mesh is drawn instead: one draw
 * in place of dozens for little saved (from Orbit's Overhead preset the whole valley is in view: 112 chunk draws for 79 %
 * of the triangles; a frame is bound by three's work per draw on the main thread, F8.2).
 */
export const WHOLE_SHARE = 0.6;
/** Chunks a side the grid is cut into (about), and the fewest cells a chunk has a side. */
export const CHUNKS_A_SIDE = 8;
export const MIN_CELLS = 32;

/** Cells a side of a chunk for a grid of nx x ny posts: about CHUNKS_A_SIDE chunks along its longer side. */
export function planMapChunks({ nx, ny }) {
  return Math.max(MIN_CELLS, Math.ceil(Math.max(nx, ny) / CHUNKS_A_SIDE));
}

/**
 * Whether an index is the map's layout: quads of six (a, a+1, a+nx | a+1, a+nx+1, a+nx), their first vertices
 * increasing (src/city/terrain.js terrainMesh). Only then can restoreQuads give it back exactly.
 */
export function isMapLayout(index, nx) {
  if (!index || index.length === 0 || index.length % 6 !== 0) return false;
  let last = -1;
  for (let k = 0; k < index.length; k += 6) {
    const a = index[k];
    if (a <= last) return false;
    if (index[k + 1] !== a + 1 || index[k + 2] !== a + nx || index[k + 3] !== a + 1 || index[k + 4] !== a + nx + 1 || index[k + 5] !== a + nx) return false;
    last = a;
  }
  return true;
}

/**
 * Group the quads of a map-layout index chunk by chunk, in place (stable: each chunk's quads keep their order).
 * @param {Uint32Array} index  @param {number} nx posts per row  @param {number} cells chunk side in cells
 * @returns {Array<{ ci: number, cj: number, start: number, count: number }>} each chunk's range of the index
 */
export function reorderQuads(index, nx, cells) {
  const n = index.length / 6;
  const cx = Math.ceil(nx / cells);
  const key = new Uint32Array(n);
  let chunks = 0;
  for (let q = 0; q < n; q++) {
    const a = index[6 * q], i = a % nx, j = (a - i) / nx;
    const c = Math.floor(j / cells) * cx + Math.floor(i / cells);
    key[q] = c;
    if (c + 1 > chunks) chunks = c + 1;
  }
  const counts = new Uint32Array(chunks + 1);
  for (let q = 0; q < n; q++) counts[key[q] + 1]++;
  for (let c = 1; c <= chunks; c++) counts[c] += counts[c - 1];
  const starts = counts.slice(0, chunks);
  const out = new Uint32Array(index.length);
  const at = counts.slice(0, chunks);
  for (let q = 0; q < n; q++) {
    const o = 6 * at[key[q]]++;
    for (let k = 0; k < 6; k++) out[o + k] = index[6 * q + k];
  }
  index.set(out);
  const ranges = [];
  for (let c = 0; c < chunks; c++) {
    const count = (c + 1 < chunks ? starts[c + 1] : n) - starts[c];
    if (count > 0) ranges.push({ ci: c % cx, cj: Math.floor(c / cx), start: 6 * starts[c], count: 6 * count });
  }
  return ranges;
}

/** Put a reordered map-layout index back in increasing order of each quad's first vertex, in place (a radix sort). */
export function restoreQuads(index, nx) {
  const n = index.length / 6;
  let order = new Uint32Array(n), next = new Uint32Array(n);
  for (let q = 0; q < n; q++) order[q] = q;
  const counts = new Uint32Array(65537);
  for (const shift of [0, 16]) {
    counts.fill(0);
    for (let q = 0; q < n; q++) counts[((index[6 * order[q]] >>> shift) & 0xffff) + 1]++;
    for (let d = 1; d <= 65536; d++) counts[d] += counts[d - 1];
    for (let q = 0; q < n; q++) next[counts[(index[6 * order[q]] >>> shift) & 0xffff]++] = order[q];
    [order, next] = [next, order];
  }
  const out = new Uint32Array(index.length);
  for (let q = 0; q < n; q++) { const o = 6 * order[q]; for (let k = 0; k < 6; k++) out[6 * q + k] = index[o + k]; }
  index.set(out);
  return index;
}

/**
 * @param {import('three').Mesh} mesh  one of the map's ground meshes (src/city/terrain.js terrainMesh)
 * @param {{ grid: { nx: number, ny: number }, cells?: number }} o  grid: its posts (the provider's grid('near'/'far'))
 * @returns {null | { group: import('three').Group, show(on: boolean): void, update(): void, stats(): object, dispose(): void }}
 *   null when the mesh is not in the map's layout (it is then drawn as it is)
 */
export function createMapGroundChunks(mesh, { grid, cells = null }) {
  const geo = mesh?.geometry, index = geo?.index;
  if (!index || !(index.array instanceof Uint32Array) || !isMapLayout(index.array, grid.nx)) return null;
  const nx = grid.nx;
  const side = cells ?? planMapChunks(grid);
  const group = new Group();
  group.name = `flight map ground chunks (${mesh.name || 'map ground'})`;
  group.visible = false;
  group.matrixAutoUpdate = false;
  let parts = [], shown = false, meshWas = null, whole = false, inViewShare = 0;
  const frustum = new Frustum(), pv = new Matrix4(), centre = new Sphere();

  /** Each chunk's box and sphere from the vertices it draws now (after the airport has moved the ground). */
  function fitBounds() {
    const pos = geo.attributes.position.array, a = index.array;
    for (const p of parts) {
      const { start, count } = p.geometry.drawRange;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = start; k < start + count; k++) {
        const v = 3 * a[k], x = pos[v], y = pos[v + 1], z = pos[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const box = p.geometry.boundingBox ?? (p.geometry.boundingBox = new Box3());
      box.min.set(x0, y0, z0); box.max.set(x1, y1, z1);
      const sphere = p.geometry.boundingSphere ?? (p.geometry.boundingSphere = new Sphere());
      box.getBoundingSphere(sphere);
    }
  }

  function build(ranges) {
    parts = ranges.map((r) => {
      const g = new BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
      g.setIndex(index);
      g.setDrawRange(r.start, r.count);
      const m = new Mesh(g, mesh.material);
      m.name = `${group.name} ${r.ci},${r.cj}`;
      m.receiveShadow = mesh.receiveShadow;
      m.castShadow = mesh.castShadow;
      m.renderOrder = mesh.renderOrder;
      m.layers.mask = mesh.layers.mask;
      m.raycast = () => {}; // picking is for buildings
      m.matrixAutoUpdate = false;
      return m;
    });
    group.add(...parts);
  }

  const api = {
    group,
    /** Draw the chunks in place of the map mesh (true), or give the map mesh and its index back (false). */
    show(on) {
      on = !!on;
      if (on === shown) return;
      shown = on;
      if (on) {
        const ranges = reorderQuads(index.array, nx, side);
        index.needsUpdate = true;
        if (!parts.length) build(ranges);
        else ranges.forEach((r, k) => parts[k].geometry.setDrawRange(r.start, r.count));
        group.matrix.copy(mesh.matrixWorld);
        group.matrixWorldNeedsUpdate = true;
        fitBounds();
        meshWas = mesh.visible;
        whole = false;
        api.update();
        mesh.visible = false;
        group.visible = true;
      } else {
        group.visible = false;
        whole = false;
        restoreQuads(index.array, nx);
        index.needsUpdate = true;
        if (meshWas !== null) mesh.visible = meshWas;
        meshWas = null;
      }
    },
    /**
     * Every frame while shown: the map mesh's material (the night swaps nodes on it; the map may swap it), and, given the
     * camera, whether the chunks or the map's own mesh are drawn (WHOLE_SHARE). Both draw the same triangles.
     * @param {import('three').Camera} [camera]
     */
    update(camera = null) {
      for (const p of parts) if (p.material !== mesh.material) p.material = mesh.material;
      if (!shown || !camera) return;
      camera.updateMatrixWorld();
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      // the four side planes only (near and far depend on the depth convention: reversed on WebGPU)
      let inView = 0, all = 0;
      for (const p of parts) {
        const n = p.geometry.drawRange.count;
        all += n;
        centre.copy(p.geometry.boundingSphere).applyMatrix4(group.matrixWorld);
        let out = false;
        for (let k = 0; k < 4 && !out; k++) out = frustum.planes[k].distanceToPoint(centre.center) < -centre.radius;
        if (!out) inView += n;
      }
      inViewShare = all ? inView / all : 0;
      const next = inViewShare > WHOLE_SHARE;
      if (next !== whole) {
        whole = next;
        mesh.visible = whole && meshWas !== false;
        group.visible = !whole;
      }
    },
    /** Re-fit the chunks' bounds after the ground under them moved (the airport's conforming). */
    refit() { if (shown) fitBounds(); },
    stats: () => ({ chunks: parts.length, cells: side, shown, whole, inViewShare: +inViewShare.toFixed(3) }),
    dispose() {
      api.show(false);
      // the chunks' geometries are not disposed: that would release the map mesh's own buffers, which they share
      for (const p of parts) group.remove(p);
      parts = [];
      group.removeFromParent();
    },
  };
  return api;
}

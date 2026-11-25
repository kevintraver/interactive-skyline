/**
 * Batching bookkeeping for the signs: which signs to show for a car position (nearest first,
 * within a radius, with hysteresis), and packing the built signs into one buffer set per atlas
 * page plus one for the supports, relative to a local origin. Pure, no three.
 */

export const SHOW = 2000; // m: signs within this distance are shown
export const KEEP = 2200; // m: a shown sign stays until it is this far

/**
 * The signs to show, nearest first.
 * @param {{ map: number[] }[]} signs each with its map position [x, y]
 * @param {{ x: number, y: number }} car  @param {Set<number>} shown indices shown now
 * @returns {{ index: number, dist: number }[]}
 */
export function selectVisible(signs, car, shown = new Set(), show = SHOW, keep = KEEP) {
  const out = [];
  signs.forEach((s, i) => {
    const d = Math.hypot(s.map[0] - car.x, s.map[1] - car.y);
    if (d < show || (shown.has(i) && d < keep)) out.push({ index: i, dist: d });
  });
  return out.sort((a, b) => a.dist - b.dist);
}

/**
 * Pack built signs into buffers.
 * @param {{ index: number, built: ReturnType<import('./geometry.js').buildSign> }[]} items
 * @param {number[]} origin scene position subtracted from every vertex (the mesh sits there)
 * @param {number} pages number of atlas pages
 * @returns {{ faces: { position: Float32Array, normal: Float32Array, uv: Float32Array, retro: Uint8Array, retroLegend: Uint8Array, index: Uint32Array,
 *   ranges: Map<number, { start: number, count: number }> }[],
 *   support: { position: Float32Array, normal: Float32Array, color: Float32Array, index: Uint32Array, ranges: Map<number, object> } }}
 *   faces in the order of the signs' indices; ranges give each sign's index range, for tests and debugging
 */
export function packSigns(items, origin, pages) {
  const ordered = [...items].sort((a, b) => a.index - b.index);
  const faces = [];
  for (let p = 0; p < pages; p++) {
    const quads = [];
    for (const it of ordered) for (const q of it.built.faces) if (q.page === p) quads.push({ it, q });
    const n = quads.length;
    const position = new Float32Array(n * 12), normal = new Float32Array(n * 12), uv = new Float32Array(n * 8), index = new Uint32Array(n * 6);
    const retro = new Uint8Array(n * 4), retroLegend = new Uint8Array(n * 4);
    const ranges = new Map();
    quads.forEach(({ it, q }, k) => {
      if (q.retro) { retro.fill(q.retro[0], k * 4, k * 4 + 4); retroLegend.fill(q.retro[1], k * 4, k * 4 + 4); }
      for (let c = 0; c < 4; c++) {
        for (let a = 0; a < 3; a++) {
          position[k * 12 + c * 3 + a] = q.pos[c * 3 + a] - origin[a];
          normal[k * 12 + c * 3 + a] = q.normal[a];
        }
        uv[k * 8 + c * 2] = q.uv[c * 2];
        uv[k * 8 + c * 2 + 1] = q.uv[c * 2 + 1];
      }
      const v = k * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], k * 6);
      const r = ranges.get(it.index);
      if (r) r.count += 6; else ranges.set(it.index, { start: k * 6, count: 6 });
    });
    faces.push({ position, normal, uv, retro, retroLegend, index, ranges });
  }
  let nv = 0, ni = 0;
  for (const it of items) { nv += it.built.support.pos.length / 3; ni += it.built.support.idx.length; }
  const position = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), color = new Float32Array(nv * 3), index = new Uint32Array(ni);
  const ranges = new Map();
  let v = 0, i = 0;
  for (const it of items) {
    const s = it.built.support;
    const count = s.pos.length / 3;
    for (let k = 0; k < count; k++) {
      for (let a = 0; a < 3; a++) position[(v + k) * 3 + a] = s.pos[k * 3 + a] - origin[a];
    }
    normal.set(s.nor, v * 3);
    color.set(s.col, v * 3);
    for (let k = 0; k < s.idx.length; k++) index[i + k] = s.idx[k] + v;
    ranges.set(it.index, { start: i, count: s.idx.length });
    v += count;
    i += s.idx.length;
  }
  return { faces, support: { position, normal, color, index, ranges } };
}

// Faces of one model that lie in one plane, face the same way and overlap: two surfaces at exactly the same depth,
// which the depth buffer cannot order, so they flicker as the camera moves (z-fighting). When a city's models load
// (data.js), the earlier of two such faces is moved a little behind the later one. Finding them takes about 90 ms
// for Las Vegas' 183,000 triangles in a page's first pass, so the answer for the models as they are is kept in
// public/models/coplanar.json (`node tools/stability/model-faces.mjs --write`, checked by
// tests/unit/city/modelFaces.test.js), and only a model that is not in it, or has changed, is worked out at load.

/** How far a face that loses a coplanar overlap is moved behind the one that wins (the skill's rule: 5 cm). */
export const SEPARATION = 0.05;

/** The faces to move for every model, worked out from the GLB files ahead of time (see above). */
export const TABLE = '/models/coplanar.json';

/** The table's entries for one city, by building id; an empty object when it cannot be read. */
export async function loadSeparationTable(cityId) {
  try {
    const r = await fetch(TABLE);
    // a dev server answers a missing file with the app's own page, so check that this really is JSON
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return {};
    return (await r.json())[cityId] || {};
  } catch {
    return {};
  }
}

/**
 * Move apart the coplanar faces of every model of a city (a Map from loadCustomModels), from the table where its
 * entry still fits the model (same triangle count and position checksum), else worked out here.
 * @template {Map<string, any>} M
 * @param {M} models
 * @param {Record<string, {tris: number, check: number, moved: number[][]}>} [table]
 * @returns {M}
 */
export function separateModels(models, table = {}) {
  const t0 = performance.now();
  for (const [id, model] of models) {
    const entry = table[id];
    const fits = entry && entry.tris === Math.floor(model.pos.length / 9) && entry.check === checksum(model.pos);
    moveFaces(model, fits ? entry.moved : planSeparation(model));
  }
  performance.measure?.('skyline: separate coplanar faces', { start: t0 });
  return models;
}

/**
 * Which faces of one model to move, and how far: the faces that lie in one plane, face the same way, overlap and
 * look different (colour, night glow, windows or LED). The later face in the file wins: models list the main
 * volume first and the details laid on it after (a roof cap on a glass box, a plinth over the wall, a band over
 * the glass), so each losing face moves `step` back along its normal; in a stack of three or more, each face
 * moves back by its depth in the stack times the step over the stack's depth, so none moves further than `step`.
 * Faces that look the same draw the same pixels and are left alone.
 * @param {{pos: number[], col: number[], glow: number[], win: number[], led: number[]}} model from customModels.flatten
 * @returns {number[][]} [triangle, metres] by triangle
 */
export function planSeparation(model, { step = SEPARATION } = {}) {
  const pairs = coplanarFaces(model);
  if (!pairs.length) return [];
  // the later faces each face loses to; then how deep each face sits in its stack, latest first
  const over = new Map();
  for (const { a, b } of pairs) { if (!over.has(a)) over.set(a, []); over.get(a).push(b); }
  const depth = new Map();
  for (const a of [...over.keys()].sort((x, y) => y - x)) {
    let d = 0;
    for (const b of over.get(a)) d = Math.max(d, (depth.get(b) || 0) + 1);
    depth.set(a, d);
  }
  // the deepest face of each stack (faces joined by overlaps)
  const root = new Map(), find = (t) => { let r = t; while (root.has(r) && root.get(r) !== r) r = root.get(r); return r; };
  for (const { a, b } of pairs) { const ra = find(a), rb = find(b); root.set(ra, ra); root.set(rb, rb); if (ra !== rb) root.set(ra, rb); }
  const deepest = new Map();
  for (const [t, d] of depth) { const r = find(t); deepest.set(r, Math.max(deepest.get(r) || 1, d)); }
  return [...depth].sort((x, y) => x[0] - y[0]).map(([t, d]) => [t, Math.round((d / deepest.get(find(t))) * step * 1e5) / 1e5]);
}

/**
 * Move each listed face of a model back along its normal, in place. The faces' positions as modelled are kept in
 * `model.outline` ({tris, pos}) for the edge lines (outlinePositions).
 * @param {{pos: number[]}} model
 * @param {number[][]} plan [triangle, metres]
 */
export function moveFaces(model, plan) {
  if (!plan.length) return;
  const { pos } = model, orig = new Float64Array(plan.length * 9), tris = new Int32Array(plan.length);
  plan.forEach(([t, k], i) => {
    const o = t * 9;
    tris[i] = t;
    for (let v = 0; v < 9; v++) orig[i * 9 + v] = pos[o + v];
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const wx = pos[o + 6] - pos[o], wy = pos[o + 7] - pos[o + 1], wz = pos[o + 8] - pos[o + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    for (let v = 0; v < 9; v += 3) { pos[o + v] -= (nx / l) * k; pos[o + v + 1] -= (ny / l) * k; pos[o + v + 2] -= (nz / l) * k; }
  });
  model.outline = { tris, pos: orig };
}

/** planSeparation and moveFaces for one model; returns the number of faces moved. */
export function separateCoplanarFaces(model, options) {
  const plan = planSeparation(model, options);
  moveFaces(model, plan);
  return plan.length;
}

/**
 * A model's placed positions (from placeModel) with its moved faces back where they were modelled: what its edge
 * lines are drawn from, so a moved face does not outline itself (lines 5 cm apart draw as one).
 * @param {{pos: number[], outline: {tris: Int32Array, pos: Float64Array}}} model
 * @param {Float32Array} placed
 */
export function outlinePositions(model, placed) {
  const out = placed.slice(), { tris, pos } = model.outline;
  // placeModel only adds the same offset to every vertex
  const shift = [placed[0] - model.pos[0], placed[1] - model.pos[1], placed[2] - model.pos[2]];
  for (let i = 0; i < tris.length; i++) for (let v = 0; v < 9; v++) out[tris[i] * 9 + v] = pos[i * 9 + v] + shift[v % 3];
  return out;
}

/** A table entry for every model of a city (a Map of flattened models): what TABLE holds. */
export function separationTable(models) {
  const out = {};
  for (const [id, model] of [...models].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out[id] = { tris: Math.floor(model.pos.length / 9), check: checksum(model.pos), moved: planSeparation(model) };
  }
  return out;
}

/** A 32-bit hash of every 37th position number and the count: tells a changed model from its table entry. */
export function checksum(pos) {
  let h = Math.imul(0x811c9dc5 ^ pos.length, 16777619);
  for (let i = 0; i < pos.length; i += 37) { f32[0] = pos[i]; h = Math.imul(h ^ u32[0], 16777619); }
  return h >>> 0;
}

/**
 * The pairs separateCoplanarFaces would move apart: faces of a flattened model in one plane, facing the same way,
 * overlapping, drawn differently, not buried (coplanarOverlaps, with a triangle's look as its part).
 */
export function coplanarFaces(model) {
  return coplanarOverlaps(model.pos, appearance(model, Math.floor(model.pos.length / 9)));
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/**
 * A 32-bit hash per triangle of every vertex attribute but position: equal for triangles that draw alike. (Two
 * different looks sharing a hash would only leave their fight alone; with a few hundred looks a model, that is
 * about one model in ten thousand.)
 */
function appearance({ col, glow, win, led }, n) {
  const out = new Int32Array(n);
  for (let t = 0, prev = 0; t < n; t++) {
    let h = 0x811c9dc5, v = t * 3;
    // a triangle drawn like the one before it (most of a mesh) skips the hash
    if (t > 0 && same(col, glow, win, led, v)) { out[t] = prev; continue; }
    for (let k = 0; k < 3; k++, v++) {
      for (let c = 0; c < 3; c++) { f32[0] = col[v * 3 + c]; h = Math.imul(h ^ u32[0], 16777619); f32[0] = glow[v * 3 + c]; h = Math.imul(h ^ u32[0], 16777619); }
      f32[0] = win[v]; h = Math.imul(h ^ u32[0], 16777619);
      f32[0] = led[v]; h = Math.imul(h ^ u32[0], 16777619);
    }
    out[t] = prev = h;
  }
  return out;
}

/** Whether the triangle starting at vertex v draws like the one before it. */
function same(col, glow, win, led, v) {
  for (let i = v * 3, j = i - 9; i < v * 3 + 9; i++, j++) if (col[i] !== col[j] || glow[i] !== glow[j]) return false;
  for (let i = v, j = v - 3; i < v + 3; i++, j++) if (win[i] !== win[j] || led[i] !== led[j]) return false;
  return true;
}

/**
 * Pairs of triangles that lie in one plane (within `tolerance` metres), face the same way and overlap by more
 * than `minArea` square metres. `pos` holds loose triangles (9 numbers each); `part[t]` says which mesh (or look)
 * triangle t belongs to, and with `acrossOnly` (the default) only pairs of different parts count. Without
 * `buried`, faces that face down at or below the model's ground (y 0) are left out: models sink their base about
 * 2 m and no camera looks up at those from below.
 * @param {ArrayLike<number>} pos
 * @param {ArrayLike<number>} part
 * @returns {{a: number, b: number, area: number, normal: number[], d: number}[]} a < b, triangle indices
 */
export function coplanarOverlaps(pos, part, { tolerance = 0.01, minArea = 0.01, acrossOnly = true, buried = false } = {}) {
  const n = Math.floor(pos.length / 9), step = Math.max(2 * tolerance, 0.02);
  const plane = new Float64Array(n * 4), link = new Int32Array(n);
  // bins of rounded normal and plane distance in an open-addressed table; each bin a linked list of triangles
  let size = 16;
  while (size < n * 2) size *= 2;
  const slotN = new Int32Array(size).fill(-1), slotD = new Int32Array(size), head = new Int32Array(size).fill(-1);
  const count = new Int32Array(size), mixed = new Uint8Array(size), mask = size - 1;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const wx = pos[o + 6] - pos[o], wy = pos[o + 7] - pos[o + 1], wz = pos[o + 8] - pos[o + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-6) continue;
    nx /= l; ny /= l; nz /= l;
    const d = nx * pos[o] + ny * pos[o + 1] + nz * pos[o + 2];
    if (!buried && ny < -0.99 && d >= 0) continue; // faces down from y <= 0
    plane[t * 4] = nx; plane[t * 4 + 1] = ny; plane[t * 4 + 2] = nz; plane[t * 4 + 3] = d;
    // the normal rounded to hundredths (each part 0..200), the distance in steps
    const kn = (((nx * 100 + 100.5) | 0) * 201 + ((ny * 100 + 100.5) | 0)) * 201 + ((nz * 100 + 100.5) | 0), kd = Math.floor(d / step);
    let s = (Math.imul(kn, 0x9e3779b1) ^ Math.imul(kd, 0x85ebca6b)) & mask;
    while (slotN[s] !== -1 && (slotN[s] !== kn || slotD[s] !== kd)) s = (s + 1) & mask;
    if (slotN[s] === -1) { slotN[s] = kn; slotD[s] = kd; }
    else if (part[t] !== part[head[s]]) mixed[s] = 1;
    link[t] = head[s]; head[s] = t; count[s]++;
  }
  const job = { pos, part, plane, box: new Float64Array(n * 4), out: [], tolerance, minArea, acrossOnly, all: [], active: [] };
  for (let s = 0; s < size; s++) {
    if (slotN[s] === -1) continue;
    // two faces within the tolerance may fall either side of the edge between this bin and the next
    const kn = slotN[s], kd = slotD[s] + 1;
    let ns = (Math.imul(kn, 0x9e3779b1) ^ Math.imul(kd, 0x85ebca6b)) & mask;
    while (slotN[ns] !== -1 && (slotN[ns] !== kn || slotD[ns] !== kd)) ns = (ns + 1) & mask;
    if (slotN[ns] === -1) ns = -1;
    const withNext = ns >= 0 && (!acrossOnly || mixed[s] || mixed[ns] || part[head[s]] !== part[head[ns]]);
    if (!withNext && !(count[s] > 1 && (!acrossOnly || mixed[s]))) continue;
    const all = job.all;
    all.length = 0;
    for (let t = head[s]; t >= 0; t = link[t]) all.push(t);
    const own = all.length;
    if (withNext) for (let t = head[ns]; t >= 0; t = link[t]) all.push(t);
    sweep(job, own);
  }
  return job.out;
}

// two faces whose bounds overlap by less than this along either axis of their plane are only touching
const TOUCH = 0.01;

/**
 * The pairs among `job.all` (one bin's triangles, the first `own` of them, then the next bin's) whose bounds
 * overlap, swept along whichever axis of their plane the bounds spread least in, so a plane of many triangles
 * stays near linear; pairs within the next bin are its own sweep's.
 */
function sweep(job, own) {
  const { pos, plane, box, all } = job, t0 = all[0];
  const x = Math.abs(plane[t0 * 4]), y = Math.abs(plane[t0 * 4 + 1]), z = Math.abs(plane[t0 * 4 + 2]);
  let ai = 0, aj = 1, scale = z; // the plane's two axes kept by the projection, and |n| along the one dropped
  if (x >= y && x >= z) { ai = 1; aj = 2; scale = x; } else if (y >= z) { ai = 0; aj = 2; scale = y; }
  let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity, ext0 = 0, ext1 = 0;
  for (let k = 0; k < all.length; k++) {
    const t = all[k], o = t * 9, b = t * 4;
    const p = pos[o + ai], q = pos[o + 3 + ai], r = pos[o + 6 + ai], u = pos[o + aj], v = pos[o + 3 + aj], w = pos[o + 6 + aj];
    box[b] = p < q ? (p < r ? p : r) : (q < r ? q : r); box[b + 1] = p > q ? (p > r ? p : r) : (q > r ? q : r);
    box[b + 2] = u < v ? (u < w ? u : w) : (v < w ? v : w); box[b + 3] = u > v ? (u > w ? u : w) : (v > w ? v : w);
    if (box[b] < lo0) lo0 = box[b]; if (box[b + 1] > hi0) hi0 = box[b + 1]; if (box[b + 2] < lo1) lo1 = box[b + 2]; if (box[b + 3] > hi1) hi1 = box[b + 3];
    ext0 += box[b + 1] - box[b]; ext1 += box[b + 3] - box[b + 2];
  }
  const m = all.length;
  if (m <= 16 || m >= 65536) { // a few, or (never yet) more than the sort below can number
    for (let i = 0; i < own; i++) {
      const a = all[i] * 4;
      for (let j = i + 1; j < m; j++) {
        const b = all[j] * 4;
        if (box[a + 1] - box[b] > TOUCH && box[b + 1] - box[a] > TOUCH && box[a + 3] - box[b + 2] > TOUCH && box[b + 3] - box[a + 2] > TOUCH) test(job, all[i], all[j], ai, aj, scale);
      }
    }
    return;
  }
  const s = ext0 / (hi0 - lo0 || 1) <= ext1 / (hi1 - lo1 || 1) ? 0 : 2, r = 2 - s; // sweep slot, other slot
  // in order of where they start: millimetres from the lowest start and the index, packed in one number, sorted
  // natively (a comparator costs more than the rest of the sweep)
  const lo = s ? lo1 : lo0, order = new Float64Array(m);
  for (let i = 0; i < m; i++) order[i] = Math.round((box[all[i] * 4 + s] - lo) * 1000) * 65536 + i;
  order.sort();
  const active = job.active;
  active.length = 0;
  for (let k = 0; k < m; k++) {
    const i = order[k] % 65536, e = all[i], eb = e * 4;
    let w = 0;
    for (let q = 0; q < active.length; q++) {
      const j = active[q], a = all[j], ab = a * 4;
      if (box[ab + s + 1] - box[eb + s] <= TOUCH - 0.002) continue; // ends before this one starts: drop it
      active[w++] = j;
      if ((i >= own && j >= own) || box[ab + r + 1] - box[eb + r] <= TOUCH || box[eb + r + 1] - box[ab + r] <= TOUCH) continue;
      test(job, a, e, ai, aj, scale);
    }
    active.length = w;
    active.push(i);
  }
}

/** Record triangles a and b if they are of different parts, in one plane, facing the same way and overlapping. */
function test(job, a, b, ai, aj, scale) {
  if (a > b) { const c = a; a = b; b = c; }
  const { part, plane } = job;
  if (job.acrossOnly && part[a] === part[b]) return;
  if (Math.abs(plane[a * 4 + 3] - plane[b * 4 + 3]) > job.tolerance) return;
  if (plane[a * 4] * plane[b * 4] + plane[a * 4 + 1] * plane[b * 4 + 1] + plane[a * 4 + 2] * plane[b * 4 + 2] < 0.9998) return;
  // the projection onto the plane's two kept axes scales area by |n| along the dropped one
  const area = clipArea(job.pos, a, b, ai, aj) / scale;
  if (area > job.minArea) job.out.push({ a, b, area, normal: [plane[a * 4], plane[a * 4 + 1], plane[a * 4 + 2]], d: plane[a * 4 + 3] });
}


// two buffers of up to 9 clipped vertices (x, y), swapped between the clipping edges
const polyA = new Float64Array(18), polyB = new Float64Array(18), tri = new Float64Array(6);

/**
 * Area of the overlap of triangles a and b of `pos` projected onto axes i and j (Sutherland–Hodgman: clip a by
 * each edge of b, both wound counter-clockwise). Allocates nothing; it runs for every pair whose bounds overlap.
 */
function clipArea(pos, a, b, i, j) {
  let src = polyA, dst = polyB, m = 3;
  const oa = a * 9, ob = b * 9;
  for (let k = 0; k < 3; k++) { src[k * 2] = pos[oa + k * 3 + i]; src[k * 2 + 1] = pos[oa + k * 3 + j]; tri[k * 2] = pos[ob + k * 3 + i]; tri[k * 2 + 1] = pos[ob + k * 3 + j]; }
  if (cross(src) < 0) swapLast(src);
  if (cross(tri) < 0) swapLast(tri);
  for (let e = 0; e < 3 && m > 0; e++) {
    const ax = tri[e * 2], ay = tri[e * 2 + 1], bx = tri[((e + 1) % 3) * 2], by = tri[((e + 1) % 3) * 2 + 1];
    let w = 0;
    for (let k = 0; k < m; k++) {
      const px = src[k * 2], py = src[k * 2 + 1], q = (k + 1) % m, qx = src[q * 2], qy = src[q * 2 + 1];
      const sp = (bx - ax) * (py - ay) - (by - ay) * (px - ax), sq = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      if (sp >= 0) { dst[w * 2] = px; dst[w * 2 + 1] = py; w++; }
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); dst[w * 2] = px + (qx - px) * t; dst[w * 2 + 1] = py + (qy - py) * t; w++; }
    }
    const tmp = src; src = dst; dst = tmp; m = w;
  }
  let area = 0;
  for (let k = 0; k < m; k++) { const q = (k + 1) % m; area += src[k * 2] * src[q * 2 + 1] - src[q * 2] * src[k * 2 + 1]; }
  return Math.abs(area) / 2;
}

const cross = (T) => (T[2] - T[0]) * (T[5] - T[1]) - (T[3] - T[1]) * (T[4] - T[0]);
const swapLast = (T) => { let x = T[2]; T[2] = T[4]; T[4] = x; x = T[3]; T[3] = T[5]; T[5] = x; };

/** Area of the overlap of two triangles given as [[x, y] x 3] in one plane. */
export function overlapArea(P, Q) {
  return clipArea([...P[0], 0, ...P[1], 0, ...P[2], 0, ...Q[0], 0, ...Q[1], 0, ...Q[2], 0], 0, 1, 0, 1);
}

/**
 * A loaded glTF scene's triangles in the model's frame, loose (9 numbers each), with the index of the mesh each came
 * from (in traversal order, the order the file lists them) and those meshes' names and material names.
 * @param {import('three').Object3D} root
 */
export function modelTriangles(root) {
  const pos = [], part = [], meshes = [];
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, p = g.attributes.position, idx = g.index, e = o.matrixWorld.elements, k = meshes.length;
    const material = Array.isArray(o.material) ? o.material[0] : o.material;
    meshes.push({ name: o.name, material: material?.name || '' });
    const count = idx ? idx.count : p.count;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let j = 0; j < 3; j++) {
        const v = idx ? idx.getX(i + j) : i + j, x = p.getX(v), y = p.getY(v), z = p.getZ(v);
        pos.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      part.push(k);
    }
  });
  return { pos, part, meshes };
}

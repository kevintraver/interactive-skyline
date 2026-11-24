// Faces of one model that lie in one plane, face the same way and overlap: two surfaces at exactly the same depth,
// which the depth buffer cannot order, so they flicker as the camera moves (z-fighting). `separateCoplanarFaces`
// moves them apart when a city's models load (data.js); `coplanarOverlaps` finds them, also for the model test
// (tests/unit/city/modelFaces.test.js) and tools/stability/model-faces.mjs. Pure arithmetic on loose triangles.

/** How far a face that loses a coplanar overlap is moved behind the one that wins, per face stacked over it. */
export const SEPARATION = 0.05;

/**
 * separateCoplanarFaces for every model of a city (a Map from loadCustomModels). A model with faces moved keeps
 * its positions as they were in `outline`, for its edge lines (buildings.js), so they stay where they were drawn.
 * @template {Map<string, any>} M
 * @param {M} models
 * @returns {M}
 */
export function separateModels(models) {
  const t0 = performance.now();
  for (const model of models.values()) {
    const before = model.pos.slice();
    if (separateCoplanarFaces(model)) model.outline = before;
  }
  separateModels.ms = performance.now() - t0;
  return models;
}

/**
 * Move apart the faces of one model that lie in one plane, face the same way, overlap and look different (colour,
 * night glow, windows or LED), so one of them wins on every backend and depth buffer. The later face in the file
 * wins: models list the main volume first and the details laid on it after (a roof cap on a glass box, a plinth
 * over the wall, a band over the glass), so each losing face moves SEPARATION metres back along its normal for
 * each later face stacked over it (5 cm, the landmark skill's own rule for touching faces; a stack of three or
 * more shares those 5 cm, so no face moves further). Faces that look the same draw the same pixels and are left
 * alone. Works in place on a model from customModels.flatten (loose triangles, one entry per vertex). Returns the
 * number of faces moved.
 * @param {{pos: number[], col: number[], glow: number[], win: number[], led: number[]}} model
 */
export function separateCoplanarFaces(model, { step = SEPARATION } = {}) {
  const { pos } = model, n = Math.floor(pos.length / 9);
  const pairs = coplanarOverlaps(pos, appearance(model, n));
  if (!pairs.length) return 0;
  // the later faces each face loses to; then how deep each face sits in its stack, latest first
  const over = new Map();
  for (const { a, b } of pairs) { if (!over.has(a)) over.set(a, []); over.get(a).push(b); }
  const depth = new Map();
  for (const a of [...over.keys()].sort((x, y) => y - x)) {
    let d = 0;
    for (const b of over.get(a)) d = Math.max(d, (depth.get(b) || 0) + 1);
    depth.set(a, d);
  }
  // a stack of more than two (faces joined by overlaps) shares the step, so no face moves more than `step`
  const root = new Map(), find = (t) => { let r = t; while (root.has(r) && root.get(r) !== r) r = root.get(r); return r; };
  for (const { a, b } of pairs) { const ra = find(a), rb = find(b); root.set(ra, ra); root.set(rb, rb); if (ra !== rb) root.set(ra, rb); }
  const deepest = new Map();
  for (const [t, d] of depth) { const r = find(t); deepest.set(r, Math.max(deepest.get(r) || 1, d)); }
  for (const [t, d] of depth) {
    const o = t * 9, k = (d / deepest.get(find(t))) * step;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const wx = pos[o + 6] - pos[o], wy = pos[o + 7] - pos[o + 1], wz = pos[o + 8] - pos[o + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    for (let v = 0; v < 9; v += 3) { pos[o + v] -= (nx / l) * k; pos[o + v + 1] -= (ny / l) * k; pos[o + v + 2] -= (nz / l) * k; }
  }
  return depth.size;
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
  const plane = new Float64Array(n * 4);
  // bins of rounded normal and plane distance in an open-addressed table; each bin a linked list of triangles
  let size = 16;
  while (size < n * 2) size *= 2;
  const slotN = new Int32Array(size).fill(-1), slotD = new Int32Array(size), head = new Int32Array(size).fill(-1);
  const count = new Int32Array(size), mixed = new Uint8Array(size), link = new Int32Array(n);
  const slot = (kn, kd) => {
    let s = (Math.imul(kn, 0x9e3779b1) ^ Math.imul(kd, 0x85ebca6b)) & (size - 1);
    while (slotN[s] !== -1 && (slotN[s] !== kn || slotD[s] !== kd)) s = (s + 1) & (size - 1);
    return s;
  };
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
    const s = slot(kn, kd);
    if (slotN[s] === -1) { slotN[s] = kn; slotD[s] = kd; }
    else if (part[t] !== part[head[s]]) mixed[s] = 1;
    link[t] = head[s]; head[s] = t; count[s]++;
  }

  const out = [], box = new Float64Array(n * 4);
  let ai = 0, aj = 1, scale = 1; // the plane's two axes kept by the projection, and |n| along the one dropped
  const test = (a, b) => {
    if (a > b) { const c = a; a = b; b = c; }
    if (acrossOnly && part[a] === part[b]) return;
    if (Math.abs(plane[a * 4 + 3] - plane[b * 4 + 3]) > tolerance) return;
    if (plane[a * 4] * plane[b * 4] + plane[a * 4 + 1] * plane[b * 4 + 1] + plane[a * 4 + 2] * plane[b * 4 + 2] < 0.9998) return;
    const area = clipArea(pos, a, b, ai, aj) / scale;
    if (area > minArea) out.push({ a, b, area, normal: [plane[a * 4], plane[a * 4 + 1], plane[a * 4 + 2]], d: plane[a * 4 + 3] });
  };
  // the triangles of one bin (`own` of them) and of the next one, swept along whichever axis their bounds spread
  // least in, so a plane of many triangles stays near linear; pairs within the next bin are its own sweep's
  const all = [];
  const sweep = (own) => {
    const t0 = all[0], x = Math.abs(plane[t0 * 4]), y = Math.abs(plane[t0 * 4 + 1]), z = Math.abs(plane[t0 * 4 + 2]);
    if (x >= y && x >= z) { ai = 1; aj = 2; scale = x; } else if (y >= z) { ai = 0; aj = 2; scale = y; } else { ai = 0; aj = 1; scale = z; }
    let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity, ext0 = 0, ext1 = 0;
    for (const t of all) {
      const o = t * 9, b = t * 4;
      box[b] = Math.min(pos[o + ai], pos[o + 3 + ai], pos[o + 6 + ai]); box[b + 1] = Math.max(pos[o + ai], pos[o + 3 + ai], pos[o + 6 + ai]);
      box[b + 2] = Math.min(pos[o + aj], pos[o + 3 + aj], pos[o + 6 + aj]); box[b + 3] = Math.max(pos[o + aj], pos[o + 3 + aj], pos[o + 6 + aj]);
      lo0 = Math.min(lo0, box[b]); hi0 = Math.max(hi0, box[b + 1]); lo1 = Math.min(lo1, box[b + 2]); hi1 = Math.max(hi1, box[b + 3]);
      ext0 += box[b + 1] - box[b]; ext1 += box[b + 3] - box[b + 2];
    }
    const overlaps = (a, b) => box[a * 4 + 1] > box[b * 4] && box[b * 4 + 1] > box[a * 4] && box[a * 4 + 3] > box[b * 4 + 2] && box[b * 4 + 3] > box[a * 4 + 2];
    if (all.length <= 16) {
      for (let i = 0; i < own; i++) for (let j = i + 1; j < all.length; j++) if (overlaps(all[i], all[j])) test(all[i], all[j]);
      return;
    }
    const s = ext0 / (hi0 - lo0 || 1) <= ext1 / (hi1 - lo1 || 1) ? 0 : 2, r = 2 - s; // sweep slot, other slot
    const order = all.map((t, i) => i).sort((i, j) => box[all[i] * 4 + s] - box[all[j] * 4 + s]);
    const active = [];
    for (const i of order) {
      const e = all[i], eb = e * 4;
      let w = 0;
      for (const j of active) {
        const a = all[j], ab = a * 4;
        if (box[ab + s + 1] <= box[eb + s]) continue; // ended before this one starts: drop it
        active[w++] = j;
        if ((i >= own && j >= own) || box[ab + r + 1] <= box[eb + r] || box[eb + r + 1] <= box[ab + r]) continue;
        test(a, e);
      }
      active.length = w;
      active.push(i);
    }
  };
  for (let s = 0; s < size; s++) {
    if (slotN[s] === -1) continue;
    // two faces within the tolerance may fall either side of the edge between this bin and the next
    let ns = slot(slotN[s], slotD[s] + 1);
    if (slotN[ns] === -1) ns = -1;
    const withNext = ns >= 0 && (!acrossOnly || mixed[s] || mixed[ns] || part[head[s]] !== part[head[ns]]);
    if (!withNext && !(count[s] > 1 && (!acrossOnly || mixed[s]))) continue;
    all.length = 0;
    for (let t = head[s]; t >= 0; t = link[t]) all.push(t);
    const own = all.length;
    if (withNext) for (let t = head[ns]; t >= 0; t = link[t]) all.push(t);
    sweep(own);
  }
  return out;
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

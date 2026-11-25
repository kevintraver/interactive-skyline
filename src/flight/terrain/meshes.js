// The drawn nested terrain (plan 03, sections 7.9, 7.14 and 9.1; F4.7): each grid cut into chunks of 128 x 128 cells,
// each chunk drawn at a stride of 1, 2, 4, 8 or 16 posts chosen so that a cell is about four pixels on screen, with a
// skirt hanging from every edge it draws, the datum's curve baked into its posts and its normals, and the grid's
// WebP draped on it. Beyond region, a plain ground in region's edge colour continues to the horizon.
//
// Where a finer grid covers a coarser one the coarser one is not drawn: its cells there are left out. The cut follows
// the finer grid's edge exactly at every stride, because the edges of every finer grid are forced lines of the coarser
// grid's cells (`breaks`): a stride-4 chunk that a hole edge crosses draws thinner cells up to that line, never a cell
// across it. approaches and valley sit on their parents' posts and were stitched to them when built, so they share
// their edge with the parent at stride 1; at coarser strides the two edges differ by what the stride leaves out, and the
// skirts close that. far (the map's 80 m grid, drawn by the map) does not sit on valley's posts: as with the map's own
// far mesh over near (src/city/terrain.js) and the drive's wide mesh under far (src/world/terrain/widemesh.js), valley
// leaves out the cells wholly inside far and sinks its posts inside far by SINK, so the ring of cells that straddle far's
// edge lies under the far mesh. Nothing overlaps but the skirts and that ring, so nothing z-fights on either backend.
//
// Vertices are relative to the grid's centre (the mesh's position): a float32 vertex 524 km out is quantised to 3 cm,
// fixed, which nothing on screen can show; the model-view product is done in double precision on the CPU.
//
// The pure parts (planning, indices, skirts, stride choice) are exported for tests; the three.js parts build on them.

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, Box3, Sphere, Vector3, Frustum, Matrix4, SRGBColorSpace, Texture, LinearMipmapLinearFilter, LinearFilter } from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { positionLocal, positionWorld, texture as tslTexture, vec2, vec4, uniform, output } from 'three/tsl';
import { curveDrop, horizonDistance, EFFECTIVE_RADIUS } from '../../core/earth.js';
import { groundMaterial } from '../../world/terrain/material.js';

/** Posts per chunk side, minus one: 128 cells (section 7.9). */
export const CHUNK = 128;
/** The strides a chunk can be drawn at. */
export const STRIDES = [1, 2, 4, 8, 16];
/** How far valley's posts inside far are sunk under the map's far mesh: the map's and the drive's 8 m. */
export const SINK = 8;
/** The least skirt, metres: more than valley and far ever disagree at far's edge (26 m). */
export const MIN_SKIRT = 30;
/** The curtain hung from far's edge: the sink and the largest disagreement of valley and far there, with room. */
export const CURTAIN = 50;
/** A cell this many pixels across is what the stride aims for (section 7.9). */
export const TARGET_PX = 4;
/** Triangles in view (section 9.1): the whole nested set on High and Ultra, and on Low. */
export const BUDGET = { low: 800000, high: 1500000, ultra: 1500000 };
/** The plain ground beyond region: rings this far (metres) beyond region's edge. */
export const OUTER_RINGS = [0, 4000, 16000, 40000, 80000, 140000, 220000, 330000, 480000, 700000, 1000000];
/** The plain ground's first ring is tucked this far under region's edge. */
const OUTER_TUCK = 20;
const EPS = 1e-6;

// --- planning (pure) ---------------------------------------------------------------------------------------------

/**
 * Post-index lines of a grid that every stride keeps: the edges of every hole, as the posts either side of each edge
 * (one post where the edge lies on a post).
 * @param {{ nx: number, ny: number, x0: number, y0: number, step: number }} g
 * @param {Array<{ x0: number, x1: number, y0: number, y1: number }>} holes in map metres
 * @returns {{ bx: number[], by: number[] }} sorted, unique
 */
export function holeBreaks(g, holes) {
  const bx = new Set(), by = new Set();
  const add = (set, v, n) => {
    const f = Math.abs(v - Math.round(v)) < EPS ? Math.round(v) : v;
    for (const k of [Math.floor(f), Math.ceil(f)]) if (k > 0 && k < n - 1) set.add(k);
  };
  for (const h of holes) {
    add(bx, (h.x0 - g.x0) / g.step, g.nx); add(bx, (h.x1 - g.x0) / g.step, g.nx);
    add(by, (h.y0 - g.y0) / g.step, g.ny); add(by, (h.y1 - g.y0) / g.step, g.ny);
  }
  return { bx: [...bx].sort((a, b) => a - b), by: [...by].sort((a, b) => a - b) };
}

/**
 * The post lines a chunk spanning posts lo..hi draws at stride s: every multiple of s (counted from the grid's first
 * post, so that neighbouring chunks agree), every break between, and both ends.
 */
export function axisLines(lo, hi, s, breaks = []) {
  const out = new Set([lo, hi]);
  for (let k = Math.ceil(lo / s) * s; k < hi; k += s) out.add(k);
  for (const b of breaks) if (b > lo && b < hi) out.add(b);
  return [...out].sort((a, b) => a - b);
}

/** Whether the rectangle of posts [ia, ib] x [ja, jb] lies wholly inside one of the holes (edges included). */
function cellInHole(g, ia, ib, ja, jb, holes) {
  const xa = g.x0 + ia * g.step, xb = g.x0 + ib * g.step, ya = g.y0 + ja * g.step, yb = g.y0 + jb * g.step;
  for (const h of holes) if (xa >= h.x0 - EPS && xb <= h.x1 + EPS && ya >= h.y0 - EPS && yb <= h.y1 + EPS) return true;
  return false;
}

/** Whether post (i, j) lies strictly inside a hole that sinks its posts (far). Returns the sink in metres. */
function postSink(g, i, j, holes) {
  const x = g.x0 + i * g.step, y = g.y0 + j * g.step;
  for (const h of holes) if (h.sink && x > h.x0 + EPS && x < h.x1 - EPS && y > h.y0 + EPS && y < h.y1 - EPS) return h.sink;
  return 0;
}

/**
 * The chunks of a grid: 128-cell squares from its south-west post (the last row and column smaller), each with its
 * post ranges; a chunk wholly inside a hole is left out.
 * @returns {Array<{ ci: number, cj: number, i0: number, i1: number, j0: number, j1: number }>}
 */
export function planChunks(g, holes = [], chunk = CHUNK) {
  const out = [];
  for (let j0 = 0, cj = 0; j0 < g.ny - 1; j0 += chunk, cj++) {
    for (let i0 = 0, ci = 0; i0 < g.nx - 1; i0 += chunk, ci++) {
      const i1 = Math.min(i0 + chunk, g.nx - 1), j1 = Math.min(j0 + chunk, g.ny - 1);
      if (cellInHole(g, i0, i1, j0, j1, holes)) continue;
      out.push({ ci, cj, i0, i1, j0, j1 });
    }
  }
  return out;
}

/**
 * The triangles of one chunk at every stride: the surface cells not inside a hole, and a skirt quad on every side of a
 * drawn cell that is the chunk's edge or borders a cell left out. Vertex k < (ni + 1)(nj + 1) is post
 * (i0 + k % (ni + 1), j0 + floor(k / (ni + 1))); the rest are the skirt's bottom copies of the posts listed in `bottoms`.
 * Per stride, its surface and then its skirt are one range of the index buffer, drawn by one call.
 * @returns {{ index: Uint16Array | Uint32Array, ranges: Array<{ start: number, count: number, surface: number }>,
 *   bottoms: number[], key: string }}
 */
export function chunkIndices(g, c, holes = [], breaks = { bx: [], by: [] }, strides = STRIDES) {
  const ni = c.i1 - c.i0, nj = c.j1 - c.j0, row = ni + 1, posts = row * (nj + 1);
  const bottomOf = new Map(), bottoms = [];
  const bottom = (v) => {
    let b = bottomOf.get(v);
    if (b === undefined) { b = posts + bottoms.length; bottomOf.set(v, b); bottoms.push(v); }
    return b;
  };
  const lists = [], ranges = [];
  let total = 0;
  for (const s of strides) {
    const xs = axisLines(c.i0, c.i1, s, breaks.bx), ys = axisLines(c.j0, c.j1, s, breaks.by);
    const W = xs.length - 1, H = ys.length - 1;
    const kept = new Uint8Array(W * H);
    for (let b = 0; b < H; b++) for (let a = 0; a < W; a++) kept[b * W + a] = cellInHole(g, xs[a], xs[a + 1], ys[b], ys[b + 1], holes) ? 0 : 1;
    const surf = [], skirt = [];
    const vid = (i, j) => (j - c.j0) * row + (i - c.i0);
    const wall = (p, q) => { const pb = bottom(p), qb = bottom(q); skirt.push(p, pb, q, q, pb, qb); };
    for (let b = 0; b < H; b++) {
      for (let a = 0; a < W; a++) {
        if (!kept[b * W + a]) continue;
        const sw = vid(xs[a], ys[b]), se = vid(xs[a + 1], ys[b]), nw = vid(xs[a], ys[b + 1]), ne = vid(xs[a + 1], ys[b + 1]);
        surf.push(sw, se, nw, se, ne, nw);
        // counter-clockwise round the cell seen from above, so each wall faces away from it
        if (b === 0 || !kept[(b - 1) * W + a]) wall(sw, se);
        if (a === W - 1 || !kept[b * W + a + 1]) wall(se, ne);
        if (b === H - 1 || !kept[(b + 1) * W + a]) wall(ne, nw);
        if (a === 0 || !kept[b * W + a - 1]) wall(nw, sw);
      }
    }
    ranges.push({ stride: s, start: total, count: surf.length + skirt.length, surface: surf.length / 3, skirt: skirt.length / 3 });
    lists.push(surf, skirt);
    total += surf.length + skirt.length;
  }
  const verts = posts + bottoms.length;
  const index = verts <= 65536 ? new Uint16Array(total) : new Uint32Array(total);
  let o = 0;
  for (const l of lists) { index.set(l, o); o += l.length; }
  const rel = (list, lo, hi) => list.filter((b) => b > lo && b < hi).map((b) => b - lo).join(',');
  // the holes that reach into this chunk: chunks of one shape with the same holes in the same places share an index
  const xa = g.x0 + c.i0 * g.step, xb = g.x0 + c.i1 * g.step, ya = g.y0 + c.j0 * g.step, yb = g.y0 + c.j1 * g.step;
  const inside = holes.filter((h) => h.x0 < xb - EPS && h.x1 > xa + EPS && h.y0 < yb - EPS && h.y1 > ya + EPS);
  const holeKey = inside.map((h) => [(h.x0 - g.x0) / g.step - c.i0, (h.x1 - g.x0) / g.step - c.i0, (h.y0 - g.y0) / g.step - c.j0, (h.y1 - g.y0) / g.step - c.j0]
    .map((v) => Math.max(-1, Math.min(v, CHUNK + 1)).toFixed(3)).join(',')).join(';');
  const key = `${ni}x${nj}|${rel(breaks.bx, c.i0, c.i1)}|${rel(breaks.by, c.j0, c.j1)}|${holeKey}|${strides.join(',')}|${c.i0 % 16},${c.j0 % 16}`;
  return { index, ranges, bottoms, key };
}

/**
 * The largest vertical gap the coarsest stride opens along a chunk's edges and the hole edges in it: how far its
 * piecewise-linear edge at that stride strays from the posts. The skirts hang deep enough to close a gap between two
 * such edges (meshes.js skirtDepth).
 */
export function edgeDeviation(g, c, breaks = { bx: [], by: [] }, stride = STRIDES[STRIDES.length - 1]) {
  const h = (i, j) => g.at(i, j);
  let dev = 0;
  const along = (fixed, lo, hi, isRow, lines) => {
    for (let k = 0; k < lines.length - 1; k++) {
      const a = lines[k], b = lines[k + 1];
      const ha = isRow ? h(a, fixed) : h(fixed, a), hb = isRow ? h(b, fixed) : h(fixed, b);
      for (let m = a + 1; m < b; m++) {
        const t = (m - a) / (b - a), v = isRow ? h(m, fixed) : h(fixed, m);
        dev = Math.max(dev, Math.abs(v - (ha + t * (hb - ha))));
      }
    }
  };
  const xs = axisLines(c.i0, c.i1, stride, breaks.bx), ys = axisLines(c.j0, c.j1, stride, breaks.by);
  for (const j of [c.j0, c.j1, ...breaks.by.filter((b) => b > c.j0 && b < c.j1)]) along(j, c.i0, c.i1, true, xs);
  for (const i of [c.i0, c.i1, ...breaks.bx.filter((b) => b > c.i0 && b < c.i1)]) along(i, c.j0, c.j1, false, ys);
  return dev;
}

/**
 * The positions (relative to the grid's centre cx, cy) and normals of a chunk's posts and skirt bottoms: heights in
 * scene units with the datum's curve, posts inside a sinking hole sunk, normals from the heights' slopes with the
 * curve's slope added, so they lean with the datum (localUp) as the ground does.
 */
export function chunkVertices(g, c, { base, cx, cy, holes = [], bottoms = [], skirt = MIN_SKIRT }) {
  const ni = c.i1 - c.i0, nj = c.j1 - c.j0, row = ni + 1, posts = row * (nj + 1), n = posts + bottoms.length;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const half = 1 / (2 * g.step), R = EFFECTIVE_RADIUS;
  let ymin = Infinity, ymax = -Infinity, hmax = -Infinity;
  for (let j = c.j0; j <= c.j1; j++) {
    const y = g.y0 + j * g.step, jn = Math.min(j + 1, g.ny - 1), js = Math.max(j - 1, 0);
    for (let i = c.i0; i <= c.i1; i++) {
      const x = g.x0 + i * g.step, k = ((j - c.j0) * row + (i - c.i0)) * 3, h = g.at(i, j);
      const Y = h - base - curveDrop(x, y) - postSink(g, i, j, holes);
      pos[k] = x - cx; pos[k + 1] = Y; pos[k + 2] = -(y - cy);
      // the slope of h - curveDrop: east and north
      const dx = (g.at(Math.min(i + 1, g.nx - 1), j) - g.at(Math.max(i - 1, 0), j)) * half * (i > 0 && i < g.nx - 1 ? 1 : 2) - x / R;
      const dy = (g.at(i, jn) - g.at(i, js)) * half * (j > 0 && j < g.ny - 1 ? 1 : 2) - y / R;
      const l = Math.hypot(dx, 1, dy);
      nor[k] = -dx / l; nor[k + 1] = 1 / l; nor[k + 2] = dy / l;
      if (Y < ymin) ymin = Y;
      if (Y > ymax) ymax = Y;
      if (h > hmax) hmax = h;
    }
  }
  bottoms.forEach((v, m) => {
    const k = (posts + m) * 3;
    pos[k] = pos[v * 3]; pos[k + 1] = pos[v * 3 + 1] - skirt; pos[k + 2] = pos[v * 3 + 2];
    nor[k] = nor[v * 3]; nor[k + 1] = nor[v * 3 + 1]; nor[k + 2] = nor[v * 3 + 2];
  });
  // the chunk's box in scene coordinates (the skirt included)
  const xa = g.x0 + c.i0 * g.step, xb = g.x0 + c.i1 * g.step, ya = g.y0 + c.j0 * g.step, yb = g.y0 + c.j1 * g.step;
  const box = { min: [xa, ymin - (bottoms.length ? skirt : 0), -yb], max: [xb, ymax, -ya] };
  return { position: pos, normal: nor, box, hmax };
}

/**
 * A curtain hanging `depth` metres from the edge of another grid's mesh (the map's far grid), as positions relative to
 * (cx, cy) and triangles facing away from that grid. Its top follows the grid's edge posts exactly as the map builds its
 * mesh (src/city/terrain.js terrainMesh: the height, base removed, curveDrop). Valley is sunk under far and its ring
 * of cells along far's edge lies lower than far's edge in places: seen from outside, the gap under far's edge showed
 * the sky in a dotted line. This closes it (src/world/terrain/skirt.js does the same for the drive's patches).
 * @param {{ nx: number, ny: number, x0: number, y0: number, step: number, at: (i: number, j: number) => number }} g
 */
export function perimeterSkirt(g, { base, cx, cy, depth }) {
  const ring = [];
  for (let i = 0; i < g.nx - 1; i++) ring.push([i, 0]);
  for (let j = 0; j < g.ny - 1; j++) ring.push([g.nx - 1, j]);
  for (let i = g.nx - 1; i > 0; i--) ring.push([i, g.ny - 1]);
  for (let j = g.ny - 1; j > 0; j--) ring.push([0, j]);
  const P = ring.length, pos = new Float32Array(P * 6), nor = new Float32Array(P * 6);
  ring.forEach(([i, j], k) => {
    const x = g.x0 + i * g.step, y = g.y0 + j * g.step, Y = g.at(i, j) - base - curveDrop(x, y);
    pos.set([x - cx, Y, -(y - cy), x - cx, Y - depth, -(y - cy)], k * 6);
    const l = Math.hypot(x, EFFECTIVE_RADIUS, y);
    nor.set([x / l, EFFECTIVE_RADIUS / l, -y / l, x / l, EFFECTIVE_RADIUS / l, -y / l], k * 6);
  });
  const index = new Uint32Array(P * 6);
  for (let k = 0; k < P; k++) {
    const p = 2 * k, q = 2 * ((k + 1) % P);
    index.set([p, p + 1, q, q, p + 1, q + 1], k * 6);
  }
  return { position: pos, normal: nor, index };
}

// --- choosing strides (pure) -------------------------------------------------------------------------------------

/** Distance from a point to an axis-aligned box ({ min: [x, y, z], max: [x, y, z] }). */
export function boxDistance(p, box) {
  let d = 0;
  for (let k = 0; k < 3; k++) {
    const v = p[k] < box.min[k] ? box.min[k] - p[k] : p[k] > box.max[k] ? p[k] - box.max[k] : 0;
    d += v * v;
  }
  return Math.sqrt(d);
}

/**
 * Whether a chunk is beyond the horizon: further from the point below the eye than the horizon of the eye's altitude
 * and of the chunk's highest post together (both above sea level, on the app's datum).
 */
export function beyondHorizon(eye, altitude, chunk) {
  const b = chunk.box;
  const dx = Math.max(b.min[0] - eye[0], 0, eye[0] - b.max[0]), dz = Math.max(b.min[2] - eye[2], 0, eye[2] - b.max[2]);
  return Math.hypot(dx, dz) > horizonDistance(Math.max(altitude, 2)) + horizonDistance(Math.max(chunk.hmax, 0));
}

/**
 * A stride for every chunk in view: the one whose cell is nearest TARGET_PX pixels at the chunk's nearest point,
 * coarser everywhere (the target raised by a quarter at a time) until the triangles fit the budget.
 * @param {Array<{ step: number, box: object, ranges: Array<{ stride: number, surface: number, skirt: number }> }>} chunks
 * @param {{ eye: number[], focalPx: number, budget: number, targetPx?: number, visible?: boolean[] }} o
 * @returns {{ strides: number[], triangles: number, targetPx: number }} strides[k] = 0 for a chunk not drawn
 */
export function chooseStrides(chunks, { eye, focalPx, budget, targetPx = TARGET_PX, visible = null }) {
  const d = chunks.map((c) => Math.max(boxDistance(eye, c.box), 1));
  let target = targetPx, strides = [], tris = 0;
  for (let round = 0; round < 24; round++) {
    tris = 0;
    strides = chunks.map((c, k) => {
      if (visible && !visible[k]) return 0;
      // the cell at stride s spans step * s / d * focalPx pixels: nearest the target on a log scale
      const want = Math.log2((target * d[k]) / (c.step * focalPx));
      let best = c.ranges[0];
      for (const r of c.ranges) if (Math.abs(Math.log2(r.stride) - want) < Math.abs(Math.log2(best.stride) - want) - 1e-9) best = r;
      tris += best.surface + best.skirt;
      return best.stride;
    });
    if (tris <= budget) break;
    target *= 1.25;
  }
  return { strides, triangles: tris, targetPx: target };
}

// --- three.js ----------------------------------------------------------------------------------------------------

/** The flight's plain ground colour without imagery: the map's untextured ground (src/flight/world.js). */
const PLAIN = 0xbdb9ad;

/**
 * The material of one grid: plan 02's ground material (src/world/terrain/material.js groundMaterial, a
 * MeshLambertNodeMaterial, so the same lighting model as the map's and the drive's ground and the drive's surface
 * lights' tag), the grid's image as its colour with uv from the vertex position (every chunk shares the grid's centre,
 * so one material serves the grid), the scene's fog as every surface has it, and the environment's aerial perspective.
 */
export function gridMaterial({ map, extent, cx, cy, nodes = null }) {
  const m = groundMaterial(null, { legacy: false });
  m.name = 'flight-terrain';
  const W = extent.x1 - extent.x0, H = extent.y1 - extent.y0;
  const uvNode = vec2(positionLocal.x.mul(1 / W).add((cx - extent.x0) / W), positionLocal.z.mul(-1 / H).add((cy - extent.y0) / H));
  const plain = uniform(new Color(PLAIN));
  m.userData.photo = map ? tslTexture(map, uvNode) : null;
  m.userData.plain = plain;
  m.colorNode = m.userData.photo ?? plain;
  if (nodes?.aerialPerspective) {
    const ap = nodes.aerialPerspective(positionWorld);
    m.outputNode = vec4(output.rgb.mul(ap.a).add(ap.rgb), output.a);
  }
  return m;
}

/** Turn a grid material's photo on or off (the map's imagery setting). */
export function setPhoto(m, on) {
  const want = on && m.userData.photo ? m.userData.photo : m.userData.plain;
  if (m.colorNode !== want) { m.colorNode = want; m.needsUpdate = true; }
}

/**
 * An ImageBitmap (decoded flipped, as the map decodes its photos) as the grid's texture: sRGB, mipmapped, anisotropic.
 */
export function gridTexture(bitmap, anisotropy = 8) {
  const t = new Texture(bitmap);
  t.flipY = false;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * The meshes of one grid.
 * @param {{ name: string, grid: ReturnType<import('./nested.js').gridField>, base: number, map: Texture | null,
 *           holes?: Array<{ x0: number, x1: number, y0: number, y1: number, sink?: number, curtain?: object }>, nodes?: object }} o
 *   holes: the finer grids drawn over this one (their extents); far with sink: SINK and curtain: far's heightField, from
 *   whose edge a curtain is hung (perimeterSkirt)
 */
export function createGridMeshes({ name, grid, base, map, holes = [], nodes = null }) {
  const g = grid;
  const extent = { x0: g.x0, y0: g.y0, x1: g.x0 + (g.nx - 1) * g.step, y1: g.y0 + (g.ny - 1) * g.step };
  // the centre on a post, so the offsets are exact
  const cx = g.x0 + Math.floor((g.nx - 1) / 2) * g.step, cy = g.y0 + Math.floor((g.ny - 1) / 2) * g.step;
  const material = gridMaterial({ map, extent, cx, cy, nodes });
  const group = new Group();
  group.name = `flight-terrain-${name}`;
  /** key -> BufferAttribute shared by every chunk of that shape */
  const indexCache = new Map();
  let chunks = [];
  let currentHoles = null;

  let curtains = [];
  function build(nextHoles) {
    currentHoles = nextHoles;
    for (const c of chunks) { group.remove(c.mesh); c.mesh.geometry.dispose(); }
    for (const m of curtains) { group.remove(m); m.geometry.dispose(); }
    // a curtain from the edge of each grid drawn by someone else over a hole in this one (the map's far grid)
    curtains = nextHoles.filter((h) => h.curtain).map((h) => {
      const a = perimeterSkirt(h.curtain, { base, cx, cy, depth: CURTAIN });
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(a.position, 3));
      geo.setAttribute('normal', new BufferAttribute(a.normal, 3));
      geo.setIndex(new BufferAttribute(a.index, 1));
      geo.computeBoundingSphere();
      const mesh = new Mesh(geo, material);
      mesh.name = `${group.name}-curtain`;
      mesh.position.set(cx, 0, -cy);
      mesh.raycast = () => {};
      mesh.castShadow = mesh.receiveShadow = false;
      group.add(mesh);
      return mesh;
    });
    for (const a of indexCache.values()) a.users = 0;
    const breaks = holeBreaks(g, nextHoles);
    const plan = planChunks(g, nextHoles);
    const devs = new Map(plan.map((c) => [`${c.ci},${c.cj}`, edgeDeviation(g, c, breaks)]));
    chunks = plan.map((c) => {
      const ix = chunkIndices(g, c, nextHoles, breaks);
      // deep enough for the worst gap between this chunk's edge and a neighbour's, each at its coarsest stride
      let dev = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) dev = Math.max(dev, devs.get(`${c.ci + di},${c.cj + dj}`) ?? 0);
      const skirt = Math.max(MIN_SKIRT, 2 * dev + 10);
      const v = chunkVertices(g, c, { base, cx, cy, holes: nextHoles, bottoms: ix.bottoms, skirt });
      let index = indexCache.get(ix.key);
      if (!index) { index = new BufferAttribute(ix.index, 1); indexCache.set(ix.key, index); }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(v.position, 3));
      geo.setAttribute('normal', new BufferAttribute(v.normal, 3));
      geo.setIndex(index);
      geo.boundingBox = new Box3(new Vector3(v.box.min[0] - cx, v.box.min[1], v.box.min[2] + cy), new Vector3(v.box.max[0] - cx, v.box.max[1], v.box.max[2] + cy));
      geo.boundingSphere = geo.boundingBox.getBoundingSphere(new Sphere());
      const mesh = new Mesh(geo, material);
      mesh.name = `${group.name}-${c.ci}-${c.cj}`;
      mesh.position.set(cx, 0, -cy);
      mesh.frustumCulled = false; // culled here, against the frustum and the horizon
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.raycast = () => {}; // picking is for buildings
      mesh.castShadow = mesh.receiveShadow = false;
      group.add(mesh);
      return { ...c, mesh, box: v.box, hmax: v.hmax, ranges: ix.ranges, step: g.step, skirt, stride: 0 };
    });
  }
  build(holes);

  return {
    name, group, material, grid: g, extent,
    get chunks() { return chunks; },
    /** The curtains hung from the grids drawn over this one's holes (one draw each when in view). */
    get curtains() { return curtains; },
    get holes() { return currentHoles; },
    /** Rebuild with another set of holes (a finer grid arrived or left). */
    setHoles(next) { build(next); },
    /** Draw each chunk at its stride (0 hides it). */
    apply(strides) {
      chunks.forEach((c, k) => {
        const s = strides[k];
        c.stride = s;
        c.mesh.visible = s > 0;
        if (s > 0) {
          const r = c.ranges.find((x) => x.stride === s);
          c.mesh.geometry.setDrawRange(r.start, r.count);
        }
      });
    },
    dispose() {
      for (const c of chunks) c.mesh.geometry.dispose();
      for (const m of curtains) m.geometry.dispose();
      material.dispose();
      map?.dispose();
      chunks = [];
    },
  };
}

/**
 * The plain ground beyond region: square rings from region's edge (tucked under it) out to a million metres beyond,
 * falling with the datum's curve, in region's edge colour (terrain.json edgeColor.linear). Its first ring follows
 * region's edge heights; the rest ease to their mean.
 */
export function outerGroundArrays(region, base, { rings = OUTER_RINGS, per = 128 } = {}) {
  const e = { x0: region.x0, y0: region.y0, x1: region.x0 + (region.nx - 1) * region.step, y1: region.y0 + (region.ny - 1) * region.step };
  const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
  // the perimeter, counter-clockwise from the south-west corner, `per` segments a side, as unit-square directions
  const ring0 = [];
  for (let s = 0; s < 4; s++) {
    for (let k = 0; k < per; k++) {
      const t = k / per;
      ring0.push(s === 0 ? [e.x0 + t * (e.x1 - e.x0), e.y0] : s === 1 ? [e.x1, e.y0 + t * (e.y1 - e.y0)] : s === 2 ? [e.x1 - t * (e.x1 - e.x0), e.y1] : [e.x0, e.y1 - t * (e.y1 - e.y0)]);
    }
  }
  const P = ring0.length, edgeH = ring0.map(([x, y]) => region.sample(x, y));
  const mean = edgeH.reduce((a, b) => a + b, 0) / P;
  const pos = new Float32Array(P * rings.length * 3), nor = new Float32Array(P * rings.length * 3);
  rings.forEach((d, r) => {
    const w = Math.min(1, d / 40000); // the edge's heights eased to the mean over 40 km
    ring0.forEach(([x0, y0], k) => {
      // out from the square's edge, corners along the diagonal
      const ox = Math.sign(Math.round(x0 - cx)) * (Math.abs(x0 - cx) >= (e.x1 - e.x0) / 2 - 1 ? 1 : 0);
      const oy = Math.sign(Math.round(y0 - cy)) * (Math.abs(y0 - cy) >= (e.y1 - e.y0) / 2 - 1 ? 1 : 0);
      const x = x0 + ox * d, y = y0 + oy * d;
      const h = (1 - w) * edgeH[k] + w * mean - (r === 0 ? OUTER_TUCK : 0);
      const o = (r * P + k) * 3;
      pos[o] = x - cx; pos[o + 1] = h - base - curveDrop(x, y); pos[o + 2] = -(y - cy);
      const l = Math.hypot(x, EFFECTIVE_RADIUS, y);
      nor[o] = x / l; nor[o + 1] = EFFECTIVE_RADIUS / l; nor[o + 2] = -y / l;
    });
  });
  const idx = new Uint32Array((rings.length - 1) * P * 6);
  let n = 0;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < P; k++) {
      const a = r * P + k, b = r * P + ((k + 1) % P), c = a + P, d = b + P;
      // the inner ring runs counter-clockwise seen from above, the outer one beyond it: (a, b, c) faces up
      idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
  }
  return { position: pos, normal: nor, index: idx, cx, cy, mean };
}

/** The plain ground beyond region as a mesh. */
export function createOuterGround({ region, base, color, nodes = null }) {
  const a = outerGroundArrays(region, base);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(a.position, 3));
  geo.setAttribute('normal', new BufferAttribute(a.normal, 3));
  geo.setIndex(new BufferAttribute(a.index, 1));
  geo.computeBoundingSphere();
  const m = new MeshLambertNodeMaterial({ color: new Color(...color) });
  m.name = 'flight-terrain-outer';
  if (nodes?.aerialPerspective) {
    const ap = nodes.aerialPerspective(positionWorld);
    m.outputNode = vec4(output.rgb.mul(ap.a).add(ap.rgb), output.a);
  }
  const mesh = new Mesh(geo, m);
  mesh.name = 'flight-terrain-outer';
  mesh.position.set(a.cx, 0, -a.cy);
  mesh.frustumCulled = false; // it surrounds the camera
  mesh.raycast = () => {};
  mesh.castShadow = mesh.receiveShadow = false;
  return mesh;
}

/** The frustum of a camera, for culling chunks (their boxes are in scene coordinates). */
export function cameraFrustum(camera, out = new Frustum()) {
  return out.setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
}

const _box = new Box3();
/** Whether a chunk's scene box meets a frustum. */
export function boxInFrustum(frustum, box) {
  _box.min.set(box.min[0], box.min[1], box.min[2]);
  _box.max.set(box.max[0], box.max[1], box.max[2]);
  return frustum.intersectsBox(_box);
}

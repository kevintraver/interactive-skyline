/**
 * Overhead sign structures (plan 02, D3.7): a cantilever or a full span, built procedurally as a
 * simple box truss of square steel members with no walkway, on round-ish (square) columns that
 * stand outside the shoulders or in the median (signs.json `structures`, from
 * scripts/lib/roadside_overhead.py). Pure, no three: geometry comes out as plain arrays in scene
 * coordinates, in the format of geometry.js's supports, so it merges into the signs' support mesh.
 *
 * The truss hangs behind its panels: its bottom chord TRUSS.below metres above the lowest panel's
 * bottom, TRUSS.depth deep and TRUSS.along deep along the road, running across the road from d1 to
 * d0 (offsets from the reference line, positive left). Columns go from below the embankment surface
 * to just over the top chord. Built in the frame of its first sign (localUp, level), so it is true
 * vertical wherever it stands.
 */
import { signFrame, embankmentDrop, POST_COLOUR } from './geometry.js';

export const TRUSS = { below: 0.35, depth: 1.3, along: 1.0, chord: 0.14, web: 0.07, panel: 1.6, gap: 0.12 };
export const COLUMN = { w: 0.45, bury: 0.8, over: 0.25 };
export const STEEL = [0.6, 0.62, 0.63];

const add = (o, a, k) => [o[0] + a[0] * k, o[1] + a[1] * k, o[2] + a[2] * k];
const neg = (a) => [-a[0], -a[1], -a[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * A square member between two points in the structure's frame (x across to the right, y up, z
 * towards the driver), `w` thick, its sides squared to `side` (a unit vector across the member).
 */
function member(at, sup, a, b, w, sideHint) {
  const A = at(...a), B = at(...b);
  const dir = norm(sub(B, A));
  let s1 = norm(cross(dir, sideHint));
  if (!Number.isFinite(s1[0]) || Math.hypot(...cross(dir, sideHint)) < 1e-6) s1 = norm(cross(dir, [0, 0, 1]));
  const s2 = norm(cross(dir, s1));
  const h = w / 2;
  const c = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => [add(add(A, s1, u), s2, v), add(add(B, s1, u), s2, v)]);
  // four sides, no caps (members meet chords and columns)
  for (let k = 0; k < 4; k++) {
    const [a0, b0] = c[k], [a1, b1] = c[(k + 1) % 4];
    const mid = [(a0[0] + a1[0]) / 2 - A[0], (a0[1] + a1[1]) / 2 - A[1], (a0[2] + a1[2]) / 2 - A[2]];
    quad(sup, a0, a1, b1, b0, norm(mid));
  }
  return 8;
}

/** A quad wound to face n. */
function quad(sup, a, b, c, d, n) {
  const i0 = sup.pos.length / 3;
  const pts = [a, b, c, d];
  for (const p of pts) { sup.pos.push(...p); sup.nor.push(...n); sup.col.push(...STEEL); }
  const g = cross(sub(b, a), sub(c, a));
  if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] >= 0) sup.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  else sup.idx.push(i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
}

/** A column: a box from yFoot to yTop at x, its faces squared to the frame. */
function column(at, sup, f, x, z, w, yFoot, yTop) {
  const h = w / 2;
  const P = (dx, y, dz) => at(x + dx, y, z + dz);
  quad(sup, P(-h, yFoot, h), P(h, yFoot, h), P(h, yTop, h), P(-h, yTop, h), f.face);
  quad(sup, P(h, yFoot, -h), P(-h, yFoot, -h), P(-h, yTop, -h), P(h, yTop, -h), neg(f.face));
  quad(sup, P(h, yFoot, h), P(h, yFoot, -h), P(h, yTop, -h), P(h, yTop, h), f.right);
  quad(sup, P(-h, yFoot, -h), P(-h, yFoot, h), P(-h, yTop, h), P(-h, yTop, -h), neg(f.right));
  quad(sup, P(-h, yTop, h), P(h, yTop, h), P(h, yTop, -h), P(-h, yTop, -h), f.up);
  return 10;
}

/**
 * Build one structure.
 * @param {{ kind: string, s: number, cols: number[], d0: number, d1: number, signs: number[] }} st
 * @param {object[]} recs the road's sign records (st.signs index them)
 * @param {object} road as for signFrame
 * @param {number} [thick] how far behind the panel face the truss begins (the panel's thickness)
 * @returns {{ support: { pos: number[], nor: number[], col: number[], idx: number[] }, map: number[], triangles: number, columns: object[] }}
 */
export function buildStructure(st, recs, road, thick = 0.06) {
  const signs = st.signs.map((i) => recs[i]);
  const first = signs[0];
  const f = signFrame({ ...first, s: st.s }, road);
  // x across to the viewer's right (towards the road's right, d decreasing), measured from the first sign's centre
  const xOf = (d) => f.d - d;
  const at = (x, y, z) => add(add(add(f.base, f.right, x), f.up, y), f.face, z);
  const sup = { pos: [], nor: [], col: [], idx: [] };
  let tris = 0;
  const bottom = Math.min(...signs.map((r) => r.mount + f.p.crossfall * ((r.d ?? f.d) - f.d))) + TRUSS.below;
  const maxH = Math.max(...signs.map((r) => r.h));
  const depth = Math.max(0.8, Math.min(TRUSS.depth, maxH - TRUSS.below - 0.25));
  const top = bottom + depth;
  const z0 = -thick - TRUSS.gap - TRUSS.chord / 2, z1 = z0 - TRUSS.along;
  const xa = xOf(st.d0), xb = xOf(st.d1); // xa < xb
  const X = [0, 0, 1];
  // chords
  for (const y of [bottom, top]) for (const z of [z0, z1]) tris += member(at, sup, [xa, y, z], [xb, y, z], TRUSS.chord, [0, 1, 0]);
  // verticals and diagonals in the front and back planes, verticals and struts across top and bottom
  const n = Math.max(1, Math.round((xb - xa) / TRUSS.panel));
  const step = (xb - xa) / n;
  for (let k = 0; k <= n; k++) {
    const x = xa + k * step;
    for (const z of [z0, z1]) tris += member(at, sup, [x, bottom, z], [x, top, z], TRUSS.web, X);
    tris += member(at, sup, [x, top, z0], [x, top, z1], TRUSS.web, [1, 0, 0]);
    tris += member(at, sup, [x, bottom, z0], [x, bottom, z1], TRUSS.web, [1, 0, 0]);
    if (k < n) {
      const x2 = x + step;
      const up = k % 2 === 0;
      for (const z of [z0, z1]) tris += member(at, sup, [x, up ? bottom : top, z], [x2, up ? top : bottom, z], TRUSS.web, X);
    }
  }
  // columns: from below the ground beside the road to over the top chord, behind the truss
  const columns = [];
  const e = f.edges;
  for (const d of st.cols) {
    const x = xOf(d);
    const out = d < e.right ? e.right - d : d > e.left ? d - e.left : 0;
    const dEdge = d < e.right ? e.right : d > e.left ? e.left : d;
    const yFoot = f.p.crossfall * (dEdge - f.d) - embankmentDrop(out) - COLUMN.bury;
    const zc = (z0 + z1) / 2;
    tris += column(at, sup, f, x, zc, COLUMN.w, yFoot, top + COLUMN.over);
    columns.push({ d, out, foot: at(x, yFoot, zc), top: at(x, top + COLUMN.over, zc) });
  }
  return { support: sup, map: f.map, triangles: tris, columns, frame: f, bottom, top };
}

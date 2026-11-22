/**
 * One corridor cell into one merged mesh: walls and flat roofs, coloured like the app's low buildings
 * (src/city/buildings.js: GRAY with a small per-building variation; roofs shaded 0.86 as in extrude.js).
 * Pure, no three.js, so it runs in the worker and under Node.
 *
 * Heights: each building stands from `groundMin - SINK` (a metre below the lowest ground under its
 * outline, so nothing floats) to `groundMean + height` (a flat roof over the mean ground). Both are
 * metres above sea level, sampled by the caller from the terrain the drive draws; every vertex then
 * gets the scene's curvature (y = h - base - curveDrop(x, y)).
 *
 * Canopies (fuel-station roofs, carports) are a slab of CANOPY_M under their height, with nothing below.
 *
 * Windows at night: each wall carries `winLit` (0..1, read by ./material.js), the share of the app's lit windows lit
 * on it, by the building's type (windowShare): none on canopies and sheds, on walls under WINDOW_MIN_M or on a
 * building that low, and none on a share of the walls of warehouses, stores and big untyped boxes (blank walls, by a
 * hash of the wall); fewer lit in warehouses and stores than in hotels and apartments.
 */
import { decodeCell, TYPE, TYPES } from './format.js';
import { triangulate } from './earcut.js';

export const SINK = 1;
export const CANOPY_M = 0.8;
// src/city/buildings.js GRAY, written out so the worker needs no three.js
export const GRAY = [0.80, 0.775, 0.74];
const ROOF_SHADE = 0.86;
/** No windows on a wall lower than this (a canopy's edge, a low wall). */
export const WINDOW_MIN_M = 3;
// per type (format.js TYPES): the share of the app's lit windows that are lit, and the share of walls left blank
const LIT = { other: 0.6, house: 0.5, apartments: 1, retail: 0.3, warehouse: 0.15, hotel: 1, office: 0.8, civic: 0.5, canopy: 0, shed: 0 };
const BLANK = { other: 0.15, house: 0.2, apartments: 0.05, retail: 0.5, warehouse: 0.7, hotel: 0.05, office: 0.1, civic: 0.3, canopy: 1, shed: 1 };
const BIG_BOX_M2 = 2500; // an untyped low building this large is a store or a warehouse: lit and blank as a store
const BIG_BOX_H = 14;
const TOWER_M = 20;

/**
 * The window share of one wall (0 = no windows): `type` a format.js TYPES name, `height` the building's height above
 * the ground and `wallH` this wall's (both metres), `area` the footprint's m^2, `h` a hash in [0, 1) of the wall.
 */
export function windowShare(type, height, wallH, area, h) {
  if (wallH < WINDOW_MIN_M || height < WINDOW_MIN_M) return 0;
  const t = type === 'other' && area >= BIG_BOX_M2 && height < BIG_BOX_H ? 'retail' : type;
  // a tower's faces all have windows (only a warehouse that tall keeps blank walls)
  if (h < (height >= TOWER_M && t !== 'warehouse' ? 0 : BLANK[t] ?? BLANK.other)) return 0;
  return LIT[t] ?? LIT.other;
}

/** A hash in [0, 1) of a map position: the same one buildings.js uses for its per-building variation. */
export const hash01 = (x, y) => {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
};

const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * @param {{ buf: ArrayBuffer, groundMin: Float32Array, groundMean: Float32Array, base: number, earthR: number,
 *   origin?: [number, number], only?: number }} opts  origin: map metres the vertices are relative to (default the
 *   cell's); only: mesh just the first `only` buildings
 * @returns {{ positions: Float32Array, normals: Float32Array, colors: Float32Array, winLit: Uint8Array, indices: Uint32Array,
 *   origin: [number, number, number], sphere: [number, number, number, number], buildings: number, triangles: number }}
 *   origin is the scene position of the vertices' zero; sphere is in the mesh's own coordinates.
 */
export function meshCell({ buf, groundMin, groundMean, base, earthR, origin, only }) {
  const cell = decodeCell(buf);
  const [cx, cy] = cell.origin, unit = cell.unit, P = cell.points;
  const [ox, oy] = origin || cell.origin;
  const B = Math.min(cell.count, only ?? cell.count);
  // exact sizes first: walls 4 vertices and 6 indices per edge; roofs one vertex per point, 3 (n - 2 + 2 holes) indices
  let nv = 0, ni = 0;
  for (let k = 0; k < B; k++) {
    const canopy = cell.type[k] === TYPE.canopy;
    for (let r = cell.ringStart[k]; r < cell.ringStart[k + 1]; r++) {
      const n = cell.ringPoints[r];
      nv += 4 * n + n * (canopy ? 2 : 1); ni += 6 * n;
    }
    const pts = cell.pointStart[cell.ringStart[k + 1]] - cell.pointStart[cell.ringStart[k]];
    const holes = cell.ringCount[k] - 1;
    ni += 3 * (pts + 2 * holes) * (canopy ? 2 : 1);
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const win = new Uint8Array(nv); // winLit * 255 (a normalised attribute); roofs and undersides 0
  let idx = new Uint32Array(ni);
  let v = 0, t = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const drop = (x, y) => (x * x + y * y) / (2 * earthR);
  const put = (mx, my, h, nx, ny, nz, r, g, b) => {
    const k = v * 3;
    const sx = mx - ox, sy = h - base - drop(mx, my), sz = -(my - oy);
    pos[k] = sx; pos[k + 1] = sy; pos[k + 2] = sz;
    nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
    col[k] = r; col[k + 1] = g; col[k + 2] = b;
    if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    if (sz < minZ) minZ = sz; if (sz > maxZ) maxZ = sz;
    return v++;
  };
  const flat = [];
  for (let k = 0; k < B; k++) {
    const r0 = cell.ringStart[k], r1 = cell.ringStart[k + 1];
    const p0 = cell.pointStart[r0];
    const fx = cx + P[2 * p0] / unit, fy = cy + P[2 * p0 + 1] / unit;
    const top = groundMean[k] + cell.height[k] / 10;
    const canopy = cell.type[k] === TYPE.canopy;
    const bot = canopy ? top - CANOPY_M : groundMin[k] - SINK;
    // the app's per-building variation, and on big flat roofs a wider one with a slight warm or cool cast,
    // so a field of warehouses does not read as one grey sheet
    const hA = hash01(fx, fy), hB = hash01(fy * 0.37 + 11.1, fx * 0.71 - 3.3);
    const kw = 0.93 + 0.07 * hA;
    const wall = [GRAY[0] * kw, GRAY[1] * kw, GRAY[2] * kw];
    // footprint area, for the roof tone
    let area = 0;
    for (let p = p0, e = cell.pointStart[r0 + 1], q = e - 1; p < e; q = p++) {
      area += (P[2 * q] - P[2 * p]) * (P[2 * q + 1] + P[2 * p + 1]);
    }
    area = Math.abs(area) / 2 / (unit * unit);
    const big = smooth(600, 6000, area);
    const kr = ROOF_SHADE * (kw + big * (0.16 * hB - 0.1));
    const cast = big * (hash01(fx + 5.5, fy - 7.7) - 0.5) * 0.08; // + warm, - cool
    const roof = [GRAY[0] * kr * (1 + cast), GRAY[1] * kr, GRAY[2] * kr * (1 - cast)];
    // walls
    for (let r = r0; r < r1; r++) {
      const a = cell.pointStart[r], e = cell.pointStart[r + 1], n = e - a;
      // signed area: outer rings counter-clockwise, holes clockwise; turn a ring the other way round if it is not
      let s2 = 0;
      for (let p = a, q = e - 1; p < e; q = p++) s2 += (P[2 * q] - P[2 * p]) * (P[2 * q + 1] + P[2 * p + 1]);
      const flip = (r === r0) !== (s2 > 0);
      for (let i = 0; i < n; i++) {
        const pi = a + (flip ? n - 1 - i : i), qi = a + (flip ? (2 * n - 2 - i) % n : (i + 1) % n);
        const px = cx + P[2 * pi] / unit, py = cy + P[2 * pi + 1] / unit;
        const qx = cx + P[2 * qi] / unit, qy = cy + P[2 * qi + 1] / unit;
        const dx = qx - px, dy = qy - py, l = Math.hypot(dx, dy) || 1;
        const nx = dy / l, nz = dx / l;
        const i0 = put(px, py, bot, nx, 0, nz, ...wall), i1 = put(qx, qy, bot, nx, 0, nz, ...wall);
        const i2 = put(qx, qy, top, nx, 0, nz, ...wall), i3 = put(px, py, top, nx, 0, nz, ...wall);
        // the wall's height as drawn above the lowest ground under the building (its base is sunk SINK below that)
        const lit = windowShare(TYPES[cell.type[k]], cell.height[k] / 10, top - bot - SINK, area, hash01((px + qx) / 2 + 0.5, (py + qy) / 2 - 0.5));
        win[i0] = win[i1] = win[i2] = win[i3] = Math.round(lit * 255);
        idx[t++] = i0; idx[t++] = i1; idx[t++] = i2; idx[t++] = i0; idx[t++] = i2; idx[t++] = i3;
      }
    }
    // roof (and a canopy's underside)
    flat.length = 0;
    const holes = [];
    for (let r = r0; r < r1; r++) {
      if (r > r0) holes.push(flat.length / 2);
      for (let p = cell.pointStart[r]; p < cell.pointStart[r + 1]; p++) flat.push(P[2 * p], P[2 * p + 1]);
    }
    const first = v;
    for (let i = 0; i < flat.length; i += 2) put(cx + flat[i] / unit, cy + flat[i + 1] / unit, top, 0, 1, 0, ...roof);
    const tris = triangulate(flat, holes);
    for (let i = 0; i < tris.length; i += 3) {
      // counter-clockwise in map axes, so facing up in the scene
      const a = flat[2 * tris[i]], b = flat[2 * tris[i] + 1], c = flat[2 * tris[i + 1]], d = flat[2 * tris[i + 1] + 1];
      const e = flat[2 * tris[i + 2]], f = flat[2 * tris[i + 2] + 1];
      const ccw = (c - a) * (f - b) - (d - b) * (e - a) > 0;
      if (t + 3 > idx.length) idx = grow(idx);
      idx[t++] = first + tris[i]; idx[t++] = first + tris[ccw ? i + 1 : i + 2]; idx[t++] = first + tris[ccw ? i + 2 : i + 1];
    }
    if (canopy) {
      const under = v, shade = 0.6;
      for (let i = 0; i < flat.length; i += 2) put(cx + flat[i] / unit, cy + flat[i + 1] / unit, bot, 0, -1, 0, wall[0] * shade, wall[1] * shade, wall[2] * shade);
      for (let i = 0; i < tris.length; i += 3) {
        const a = flat[2 * tris[i]], b = flat[2 * tris[i] + 1], c = flat[2 * tris[i + 1]], d = flat[2 * tris[i + 1] + 1];
        const e = flat[2 * tris[i + 2]], f = flat[2 * tris[i + 2] + 1];
        const ccw = (c - a) * (f - b) - (d - b) * (e - a) > 0;
        if (t + 3 > idx.length) idx = grow(idx);
        idx[t++] = under + tris[i]; idx[t++] = under + tris[ccw ? i + 2 : i + 1]; idx[t++] = under + tris[ccw ? i + 1 : i + 2];
      }
    }
  }
  const indices = t === idx.length ? idx : idx.slice(0, t);
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2, mz = (minZ + maxZ) / 2;
  const radius = v ? Math.hypot(maxX - mx, maxY - my, maxZ - mz) : 0;
  return {
    positions: pos.subarray(0, v * 3), normals: nor.subarray(0, v * 3), colors: col.subarray(0, v * 3), winLit: win.subarray(0, v), indices,
    origin: [ox, 0, -oy], sphere: [v ? mx : 0, v ? my : 0, v ? mz : 0, radius], buildings: B, triangles: t / 3,
  };
}

function grow(a) {
  const b = new Uint32Array(Math.ceil(a.length * 1.5) + 3);
  b.set(a);
  return b;
}

/** The buffers of a meshCell result, to transfer from the worker. */
export const transferablesOf = (m) => [m.positions.buffer, m.normals.buffer, m.colors.buffer, m.winLit.buffer, m.indices.buffer];

/**
 * The ground under each building, from a height function: the lowest height at its outer ring's points and the
 * middles of its sides, and the mean at its points (metres above sea level). Runs on the main thread, where the terrain lives.
 * @param {ReturnType<typeof decodeCell>} cell  @param {(x: number, y: number) => number} heightAt
 */
export function groundUnder(cell, heightAt, only = cell.count) {
  const n = Math.min(cell.count, only);
  const groundMin = new Float32Array(n), groundMean = new Float32Array(n);
  const [cx, cy] = cell.origin, u = cell.unit, P = cell.points;
  for (let k = 0; k < n; k++) {
    const r = cell.ringStart[k], a = cell.pointStart[r], e = cell.pointStart[r + 1];
    let lo = Infinity, sum = 0;
    for (let p = a; p < e; p++) {
      const x = cx + P[2 * p] / u, y = cy + P[2 * p + 1] / u;
      const h = heightAt(x, y);
      if (h < lo) lo = h;
      sum += h;
      // the drawn ground is triangles: between two corners it can dip below both, so the side's middle counts too
      const q = p + 1 < e ? p + 1 : a;
      const hm = heightAt((x + cx + P[2 * q] / u) / 2, (y + cy + P[2 * q + 1] / u) / 2);
      if (hm < lo) lo = hm;
    }
    groundMin[k] = lo; groundMean[k] = sum / (e - a);
  }
  return { groundMin, groundMean };
}

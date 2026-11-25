// Thinning far lamps with their light kept, and without popping (plan 03, sections 7.11 and 7.14). Pure: no three.js.
//
// The plan merges lamps into 250 m and 1 km clusters for distance. Seen from a window those clusters are a regular
// lattice of dots 10 to 30 px apart between 15 and 60 km, which no photograph of a city shows; so instead every lamp
// keeps its own position and a far cell draws a share of its lamps, each carrying the light of those left out:
//   - within a cell the lamps are in a fixed random order (hashOrder; the sprite layer's texels follow it), so the
//     first f of them are a fair sample spread over the cell;
//   - a cell draws f = min(count, max(MIN_PER_CELL, area x density)) lamps, area being the cell's size on screen in
//     pixels: no more than `density` lamps a pixel (the drive's rule, src/drive/lights/index.js SCREEN_DENSITY);
//   - f is real: the first floor(f) lamps carry count / f each and the next one the fraction left, so the cell's
//     light is exactly its count at every f, and as f changes with distance a lamp fades in or out instead of
//     appearing (writeDrawList).
// Brightness per square kilometre is the same at every distance by construction, which is what the plan's three
// levels were for.

import { lampHash } from '../../drive/lights/switching.js';

/** A cell is never thinned below this many lamps (the drive's MIN_PER_CELL). */
export const MIN_PER_CELL = 24;

/**
 * The texel order: for each cell's run cellStart[c] .. cellStart[c + 1] - 1, the pack's indices sorted by
 * lampHash(index). order[t] is the pack index drawn at texel t (texels keep the cells' runs).
 * @param {Uint32Array} cellStart  nCells + 1 run starts
 * @param {number} nCells
 */
export function hashOrder(cellStart, nCells, hash = lampHash) {
  const n = cellStart[nCells];
  const order = new Uint32Array(n);
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) { order[i] = i; keys[i] = hash(i, 0x51ed270b); }
  for (let c = 0; c < nCells; c++) {
    const a = cellStart[c], b = cellStart[c + 1];
    if (b - a < 2) continue;
    const run = Array.from(order.subarray(a, b)).sort((x, y) => keys[x] - keys[y] || x - y);
    order.set(run, a);
  }
  return order;
}

/**
 * A cell's size on screen, pixels: its width (2 r over the distance, in pixels, plus one) squared, foreshortened by
 * the sine of the elevation it is seen at.
 */
export const cellScreenArea = ({ d, r, sinEl, pixelAngle }) => {
  const w = (2 * r) / Math.max(d, 1) / pixelAngle + 1;
  return w * w * sinEl;
};

/**
 * How many lamps of each visible cell to draw (real numbers; see the header).
 * @param {{ counts: Float64Array, areas: Float64Array, n: number, density: number, budget: number, minPerCell?: number,
 *   out?: Float64Array }} o
 * @returns {{ f: Float64Array, scale: number, total: number }} total: sprites drawn (the sum of ceil(f))
 */
export function drawShares({ counts, areas, n, density, budget, minPerCell = MIN_PER_CELL, out = null }) {
  const f = out && out.length >= n ? out : new Float64Array(n);
  const at = (s) => {
    let t = 0;
    for (let k = 0; k < n; k++) {
      const c = counts[k];
      const v = Math.min(c, Math.max(Math.min(minPerCell, c) * Math.min(1, s), areas[k] * density * s));
      f[k] = v;
      t += Math.ceil(v - 1e-9);
    }
    return t;
  };
  let total = at(1), scale = 1;
  if (total > budget) {
    let lo = 0, hi = 1;
    for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (at(mid) > budget) hi = mid; else lo = mid; }
    scale = lo;
    total = at(lo);
  }
  return { f, scale, total };
}

/**
 * Write (texel, weight) pairs into `out` for the visible cells: cell k's first ceil(f[k]) texels from firsts[k],
 * weights counts[k] / f[k], the last one the fraction of a lamp f[k] - floor(f[k]) holds.
 * @returns {number} pairs written (at most budget)
 */
export function writeDrawList(out, { firsts, counts, f, n, budget }) {
  let w = 0;
  const cap = Math.min(budget, out.length >> 1);
  for (let k = 0; k < n && w < cap; k++) {
    const c = counts[k], fk = f[k];
    if (!(fk > 0)) continue;
    const per = c / fk;
    const whole = Math.floor(fk + 1e-9), frac = fk - whole;
    const first = firsts[k];
    for (let j = 0; j < whole && w < cap; j++) { out[2 * w] = first + j; out[2 * w + 1] = per; w++; }
    if (frac > 1e-9 && whole < c && w < cap) { out[2 * w] = first + whole; out[2 * w + 1] = per * frac; w++; }
  }
  return w;
}

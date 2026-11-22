// The valley's ribbons as vertex arrays (plan 02, D6.6). Pure: no three.js; valley.js puts the arrays in a
// BufferGeometry. The attributes are those valley.glsl.js reads (see its header).
//
// Each piece of road (valleyFormat.js) gives one ribbon per direction that carries traffic: forward along its
// vertices and, on a two-way piece, backward. A one-way piece is a carriageway of its own and is drawn on its line;
// a two-way piece's two ribbons sit to the right of their direction of travel, half a carriageway plus half the
// median out. Points are added so that no step is longer than STEP_M, for the ground's shape between them.

/** Longest step between ribbon points, metres: the ground is followed at this spacing. */
export const STEP_M = 120;
/** Lane width and half the median of a two-way road, metres (ASSUMED). */
export const LANE_M = 3.6;
export const HALF_MEDIAN_M = 1;
/** Height of the ribbon's centre line above the ground, metres, before the shader's own lift. */
export const LIFT_M = 1.2;

/**
 * @param {ReturnType<import('./valleyFormat.js').decodeValley>} v
 * @param {{ heightAt: (x: number, y: number) => number, base: number, curveDrop: (x: number, y: number) => number,
 *   keep?: (i: number) => boolean }} o  keep(i) leaves out piece i when false
 * @returns {{ position: Float32Array, dir: Float32Array, along: Float32Array, traffic: Float32Array,
 *   index: Uint32Array, pieceIndex: Uint32Array, ribbons: number, points: number, bounds: number[] }}
 *   bounds: x0, y0, x1, y1 in map metres of everything drawn; pieceIndex[i] .. pieceIndex[i + 1] is the run of
 *   `index` that draws piece i (pieces are written in order), so a run of pieces can be left out (indexWithout)
 */
export function buildValleyGeometry(v, { heightAt, base, curveDrop, keep = () => true }) {
  // first pass: count
  let points = 0, segs = 0;
  const nOut = new Uint32Array(v.count);
  for (let i = 0; i < v.count; i++) {
    if (!keep(i)) continue;
    const s = v.start[i], n = v.n[i];
    let m = 1;
    for (let k = 1; k < n; k++) {
      const dx = v.coords[2 * (s + k)] - v.coords[2 * (s + k - 1)], dy = v.coords[2 * (s + k) + 1] - v.coords[2 * (s + k - 1) + 1];
      m += Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP_M));
    }
    nOut[i] = m;
    const dirs = (v.fwd[i] > 0 ? 1 : 0) + (!v.oneway[i] && v.bwd[i] > 0 ? 1 : 0);
    points += m * dirs;
    segs += (m - 1) * dirs;
  }
  const position = new Float32Array(points * 2 * 3), dir = new Float32Array(points * 2 * 3);
  const along = new Float32Array(points * 2 * 2), traffic = new Float32Array(points * 2 * 4);
  const index = new Uint32Array(segs * 6);
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  let p = 0, q = 0, ribbons = 0;
  let px = new Float64Array(64), py = new Float64Array(64);
  const pieceIndex = new Uint32Array(v.count + 1);

  for (let i = 0; i < v.count; i++) {
    pieceIndex[i] = q;
    const m = nOut[i];
    if (!m) continue;
    if (px.length < m) { px = new Float64Array(2 * m); py = new Float64Array(2 * m); }
    // the piece's line, densified
    const s = v.start[i], n = v.n[i];
    let c = 0;
    px[c] = v.coords[2 * s]; py[c] = v.coords[2 * s + 1]; c++;
    for (let k = 1; k < n; k++) {
      const x0 = v.coords[2 * (s + k - 1)], y0 = v.coords[2 * (s + k - 1) + 1];
      const x1 = v.coords[2 * (s + k)], y1 = v.coords[2 * (s + k) + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP_M));
      for (let j = 1; j <= steps; j++) { px[c] = x0 + ((x1 - x0) * j) / steps; py[c] = y0 + ((y1 - y0) * j) / steps; c++; }
    }
    const width = Math.max(1, v.lanes[i]) * LANE_M;
    const runs = [];
    if (v.fwd[i] > 0) runs.push([v.fwd[i], v.shapeF[i], 1]);
    if (!v.oneway[i] && v.bwd[i] > 0) runs.push([v.bwd[i], v.shapeB[i], -1]);
    for (const [volume, shape, sense] of runs) {
      const offset = v.oneway[i] ? 0 : 0.5 * width + HALF_MEDIAN_M;
      const p0 = p;
      let u = ((i * 7919 + (sense > 0 ? 0 : 3571)) % 64) * 60; // a per-ribbon phase of the drift pattern
      for (let j = 0; j < m; j++) {
        const k = sense > 0 ? j : m - 1 - j;
        // direction of travel at the point (map axes), from its neighbours along the travel
        const ka = Math.max(0, k - 1), kb = Math.min(m - 1, k + 1);
        let dx = (px[kb] - px[ka]) * sense, dy = (py[kb] - py[ka]) * sense;
        const L = Math.hypot(dx, dy) || 1;
        dx /= L; dy /= L;
        const x = px[k] + dy * offset, y = py[k] - dx * offset; // right of travel: (dy, -dx)
        if (j > 0) {
          const kp = sense > 0 ? k - 1 : k + 1;
          u += Math.hypot(px[k] - px[kp], py[k] - py[kp]);
        }
        const h = heightAt(x, y) - base - curveDrop(x, y) + LIFT_M;
        if (x < bounds[0]) bounds[0] = x;
        if (y < bounds[1]) bounds[1] = y;
        if (x > bounds[2]) bounds[2] = x;
        if (y > bounds[3]) bounds[3] = y;
        for (let side = 0; side < 2; side++) {
          const o = p * 2 + side;
          position[3 * o] = x; position[3 * o + 1] = h; position[3 * o + 2] = -y;
          dir[3 * o] = dx; dir[3 * o + 1] = 0; dir[3 * o + 2] = -dy;
          along[2 * o] = u; along[2 * o + 1] = side ? 1 : -1;
          traffic[4 * o] = volume; traffic[4 * o + 1] = shape; traffic[4 * o + 2] = v.speed[i]; traffic[4 * o + 3] = width;
        }
        p++;
      }
      for (let j = 0; j + 1 < m; j++) {
        const a = (p0 + j) * 2, b = (p0 + j + 1) * 2;
        index[q++] = a; index[q++] = a + 1; index[q++] = b;
        index[q++] = a + 1; index[q++] = b + 1; index[q++] = b;
      }
      ribbons++;
    }
  }
  pieceIndex[v.count] = q;
  return { position, dir, along, traffic, index, pieceIndex, ribbons, points, bounds };
}

/**
 * The geometry's index without the pieces of some runs (the valley's groups: { first, count }), as a new array;
 * the whole index when there are none.
 */
export function indexWithout(g, runs) {
  if (!runs.length) return g.index;
  const cut = runs.map((r) => [g.pieceIndex[r.first], g.pieceIndex[r.first + r.count]]).sort((a, b) => a[0] - b[0]);
  let n = g.index.length;
  for (const [a, b] of cut) n -= b - a;
  const out = new Uint32Array(n);
  let o = 0, from = 0;
  for (const [a, b] of cut) {
    out.set(g.index.subarray(from, a), o);
    o += a - from;
    from = Math.max(from, b);
  }
  out.set(g.index.subarray(from), o);
  return out;
}

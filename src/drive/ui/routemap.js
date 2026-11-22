// The small line map on a route card: the road's stations, decimated, drawn north up in a square
// SVG with the city's origin (the Strip) inside the frame. Pure, so the path can be unit-tested.

/** Squared distance from p to the segment ab. */
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let u = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ex = ax + u * dx - px, ey = ay + u * dy - py;
  return ex * ex + ey * ey;
}

/**
 * Ramer-Douglas-Peucker on a polyline, iterative so a long road cannot overflow the stack.
 * @param {number[][]} pts [[x, y], ...]  @param {number} tol
 * @returns {number[][]} the kept points, first and last always among them
 */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, k = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > worst) { worst = d; k = i; }
    }
    if (worst > tol2) { keep[k] = 1; stack.push([a, k], [k, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * @param {{ x: ArrayLike<number>, y: ArrayLike<number>, spacing: number }} road  map metres, x east, y north
 * @param {{ s0?: number, s1?: number, size?: number, pad?: number, tol?: number, include?: number[][] }} [opts]
 *   size is the viewBox's side; include lists extra map points kept in frame (default the origin)
 * @returns {{ d: string, size: number, at: (s: number) => [number, number], points: number, mark: (x: number, y: number) => [number, number] }}
 */
export function routeShape(road, { s0 = 0, s1, size = 64, pad = 5, tol = 0.35, include = [[0, 0]] } = {}) {
  const n = road.x.length;
  const end = Math.min(n - 1, Math.round((s1 ?? (n - 1) * road.spacing) / road.spacing));
  const start = Math.max(0, Math.min(end, Math.round(s0 / road.spacing)));
  // bounds of the route and the points it must show
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (let i = start; i <= end; i++) grow(road.x[i], road.y[i]);
  for (const [x, y] of include) grow(x, y);
  const scale = (size - 2 * pad) / Math.max(1, maxX - minX, maxY - minY);
  const ox = pad + ((size - 2 * pad) - (maxX - minX) * scale) / 2;
  const oy = pad + ((size - 2 * pad) - (maxY - minY) * scale) / 2;
  /** map metres -> SVG units, north up */
  const mark = (x, y) => [ox + (x - minX) * scale, size - (oy + (y - minY) * scale)];

  // a point every few hundred metres is plenty at this size; then drop what the eye cannot see
  const stride = Math.max(1, Math.floor((end - start) / 600));
  const raw = [];
  for (let i = start; i < end; i += stride) raw.push(mark(road.x[i], road.y[i]));
  raw.push(mark(road.x[end], road.y[end]));
  const kept = simplify(raw, tol);
  const r1 = (v) => Math.round(v * 10) / 10;
  const d = kept.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join('');

  const at = (s) => {
    const f = Math.min(end, Math.max(start, s / road.spacing));
    const i = Math.min(end - 1, Math.floor(f)), u = f - i;
    if (end === start) return mark(road.x[start], road.y[start]);
    return mark(road.x[i] + (road.x[i + 1] - road.x[i]) * u, road.y[i] + (road.y[i + 1] - road.y[i]) * u);
  };
  return { d, size, at, mark, points: kept.length };
}

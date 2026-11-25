// The airport's shared geometry (plan 03, section 7.10; F4.2 to F4.4), pure and without three.js: runway frames from
// the FAA's surveyed ends, the FAA's pavement polygons as a point-in-pavement index, and the height model everything
// at the airport stands on.
//
// Coordinates are the airport file's: map metres x east and y north of the city origin, elevations in metres above sea
// level. A runway end's frame measures s along its landing direction from its landing threshold (negative behind it,
// in the displaced area and beyond the pavement end) and t to the right of the landing direction.
//
// Heights. airport.json gives elevations only for the runway ends and thresholds. On a runway the height is its
// published profile (linear between the ends and any displaced thresholds, section 7.10: all four Las Vegas runways
// slope about 1 %). Away from the runways it is the terrain. Between the two it eases over EASE_M, as a graded field
// does, so taxiways meet the runway without a step.

export const FT = 0.3048;
/** Distance over which the height eases from a runway's profile to the terrain, beyond its edges and ends. ESTIMATED:
 * the graded strip either side of a 150 ft runway is 250 ft wide in FAA design (AC 150/5300-13B, runway safety area),
 * and the ease is set to about half of that. */
export const EASE_M = 60;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Elevation at `s` metres along a runway from its first end, by its profile ([[s, z], ...]). */
export function profileZ(profile, s) {
  if (s <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    const [s0, z0] = profile[i - 1], [s1, z1] = profile[i];
    if (s <= s1) return s1 > s0 ? z0 + ((z1 - z0) * (s - s0)) / (s1 - s0) : z1;
  }
  return profile[profile.length - 1][1];
}

/**
 * The runways and their ends as frames.
 * runways[]: { id, ends: [a, b], a: [x, y] (first end), u: [ux, uy] (unit, first to second end), length (surveyed, m),
 *   width, zAt(s) (from the first end), local(x, y) -> { s, t } (t to the right of u), data (the file's runway) }
 * ends{name}: { id, runway, data (the file's end), L (unit landing direction), R (unit right of it), thr [x, y, z],
 *   displaced (m), width, toOpposite (m from this threshold to the opposite threshold), toFarEnd (m to the far
 *   pavement end), opposite (the other end's name), toMap(s, t) -> [x, y], zAt(s), local(x, y) -> { s, t } }
 * @param {object} data airport.json
 */
export function runwayFrames(data) {
  const runways = [], ends = {};
  for (const r of data.runways) {
    const [na, nb] = r.ends;
    const ea = data.ends[na], eb = data.ends[nb];
    const a = [ea.end[0], ea.end[1]], b = [eb.end[0], eb.end[1]];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const rw = {
      id: r.id, ends: [na, nb], a, u, length, width: r.width, data: r,
      zAt: (s) => profileZ(r.profile, s),
      local(x, y) {
        const dx = x - a[0], dy = y - a[1];
        return { s: dx * u[0] + dy * u[1], t: dx * u[1] - dy * u[0] };
      },
    };
    runways.push(rw);
    for (const [name, sign] of [[na, 1], [nb, -1]]) {
      const e = data.ends[name];
      const L = [u[0] * sign, u[1] * sign];
      const R = [L[1], -L[0]];
      const thr = e.threshold.slice();
      // s of this threshold measured from the runway's first end
      const sThr = (thr[0] - a[0]) * u[0] + (thr[1] - a[1]) * u[1];
      const displaced = sign > 0 ? sThr : length - sThr;
      const other = data.ends[sign > 0 ? nb : na];
      const sOpp = (other.threshold[0] - a[0]) * u[0] + (other.threshold[1] - a[1]) * u[1];
      const fromFirst = (s) => sThr + s * sign;
      ends[name] = {
        id: name, runway: rw, data: e, L, R, thr, displaced, width: r.width,
        opposite: sign > 0 ? nb : na,
        toOpposite: Math.abs(sOpp - sThr),
        toFarEnd: sign > 0 ? length - sThr : sThr,
        // along the runway's centre line from the threshold, t to the right; on the line through the surveyed ends
        toMap(s, t = 0) {
          const f = fromFirst(s);
          return [a[0] + u[0] * f + R[0] * t, a[1] + u[1] * f + R[1] * t];
        },
        zAt: (s) => rw.zAt(fromFirst(s)),
        local(x, y) {
          const q = rw.local(x, y);
          return { s: (q.s - sThr) * sign, t: q.t * sign };
        },
      };
    }
  }
  runways.sort((p, q) => (p.id < q.id ? -1 : 1));
  return { runways, ends };
}

/** Even-odd point in ring ([x0, y0, x1, y1, ...]). */
export function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a ring's edges. */
function ringDistance(ring, x, y) {
  let best = Infinity;
  for (let i = 0, n = ring.length, j = n - 2; i < n; j = i, i += 2) {
    const ax = ring[j], ay = ring[j + 1], bx = ring[i], by = ring[i + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * k - x, ay + dy * k - y));
  }
  return best;
}

const bbox = (ring) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]);
    y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]);
  }
  return [x0, y0, x1, y1];
};

/**
 * The FAA's pavement polygons behind a bucket grid: which class of pavement a point is on (runway before taxiway before
 * apron), and whether it is on any within a tolerance.
 * @param {object} data airport.json
 * @param {{ cell?: number }} [o]
 */
export function createPavementIndex(data, { cell = 100 } = {}) {
  const polys = [];
  const counts = {};
  for (const cls of ['runway', 'taxiway', 'apron']) {
    const list = data.pavement?.[cls] || [];
    counts[cls] = list.length;
    for (const p of list) polys.push({ cls, ring: p.ring, holes: p.holes || [], box: bbox(p.ring), name: p.name ?? p.id ?? null });
  }
  const buckets = new Map();
  const key = (i, j) => `${i},${j}`;
  polys.forEach((p, k) => {
    for (let i = Math.floor(p.box[0] / cell); i <= Math.floor(p.box[2] / cell); i++) {
      for (let j = Math.floor(p.box[1] / cell); j <= Math.floor(p.box[3] / cell); j++) {
        const kk = key(i, j);
        if (!buckets.has(kk)) buckets.set(kk, []);
        buckets.get(kk).push(k);
      }
    }
  });
  const near = (x, y) => buckets.get(key(Math.floor(x / cell), Math.floor(y / cell))) || [];
  const inside = (p, x, y) => x >= p.box[0] && x <= p.box[2] && y >= p.box[1] && y <= p.box[3]
    && inRing(p.ring, x, y) && !p.holes.some((h) => inRing(h, x, y));
  const RANK = { runway: 0, taxiway: 1, apron: 2 };
  return {
    polys,
    counts,
    /** 'runway', 'taxiway', 'apron' or null. */
    classAt(x, y) {
      let best = null;
      for (const k of near(x, y)) {
        const p = polys[k];
        if ((best === null || RANK[p.cls] < RANK[best]) && inside(p, x, y)) best = p.cls;
      }
      return best;
    },
    /** On pavement, or within `tol` metres of it. */
    on(x, y, tol = 0) {
      const cand = tol > 0 ? new Set([...near(x - tol, y - tol), ...near(x + tol, y - tol), ...near(x - tol, y + tol), ...near(x + tol, y + tol)]) : near(x, y);
      for (const k of cand) {
        const p = polys[k];
        if (inside(p, x, y)) return true;
        if (tol > 0 && x >= p.box[0] - tol && x <= p.box[2] + tol && y >= p.box[1] - tol && y <= p.box[3] + tol && ringDistance(p.ring, x, y) <= tol) return true;
      }
      return false;
    },
    /** Polygons whose box meets [x0, y0, x1, y1]. */
    within(x0, y0, x1, y1) {
      return polys.filter((p) => p.box[2] >= x0 && p.box[0] <= x1 && p.box[3] >= y0 && p.box[1] <= y1);
    },
  };
}

/**
 * The height everything at the airport stands on, metres above sea level: on a runway its profile; beyond its edges and
 * ends eased over EASE_M to the terrain. Where runways cross, the longer one's profile holds (it is the one whose
 * markings continue through the intersection).
 * @param {object} data airport.json
 * @param {(x: number, y: number) => number} terrainZ  the terrain's height (m above sea level)
 */
export function createHeightModel(data, terrainZ) {
  const { runways } = runwayFrames(data);
  const order = runways.slice().sort((p, q) => q.length - p.length);
  return (x, y) => {
    let best = null, bestW = 1;
    for (const r of order) {
      const { s, t } = r.local(x, y);
      const ds = s < 0 ? -s : s > r.length ? s - r.length : 0;
      const dt = Math.max(0, Math.abs(t) - r.width / 2);
      if (ds > EASE_M || dt > EASE_M) continue;
      const w = smooth(0, EASE_M, Math.hypot(ds, dt));
      if (w < bestW) { bestW = w; best = r.zAt(Math.min(r.length, Math.max(0, s))); }
      if (w === 0) break;
    }
    if (best === null) return terrainZ(x, y);
    return bestW === 0 ? best : best + (terrainZ(x, y) - best) * bestW;
  };
}

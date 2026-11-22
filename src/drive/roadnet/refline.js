/**
 * The reference line of a decoded road, at any chainage s.
 *
 * Plan position: cubic Hermite through consecutive stations with the stored heading as tangent,
 * scaled to the station spacing, so position and tangent are continuous and the parameter
 * tracks arc length to a few micrometres per station on any road curve. Height: cubic Hermite
 * with grades from central differences, so grade is continuous too. Curvature and crossfall
 * are interpolated linearly. Pure; no three.
 */

/** Grade at each station from central differences of h (one-sided at the ends). */
function stationGrades(h, spacing) {
  const n = h.length;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    g[i] = (h[b] - h[a]) / ((b - a) * spacing);
  }
  return g;
}

/**
 * @param {object} road a road from decodeRoadNet (spacing, count, x, y, h, heading, curvature, crossfall)
 * @returns {{ length: number, spacing: number, at: (s: number, out?: object) => object }}
 *   `at` fills and returns `out` with { s, x, y, h, heading, curvature, grade, crossfall }:
 *   map metres, heading in radians from +x counter-clockwise, curvature 1/m (positive left),
 *   grade dh/ds, crossfall dh/dd (positive: left edge higher). s is clamped to [0, length].
 */
export function createRefline(road) {
  const { spacing, x, y, h, heading, curvature, crossfall } = road;
  const n = x.length;
  const length = (n - 1) * spacing;
  const cx = new Float64Array(n), cy = new Float64Array(n);
  for (let i = 0; i < n; i++) { cx[i] = Math.cos(heading[i]); cy[i] = Math.sin(heading[i]); }
  const grade = stationGrades(h, spacing);

  function at(s, out = {}) {
    s = s < 0 ? 0 : s > length ? length : s;
    let i = Math.floor(s / spacing);
    if (i >= n - 1) i = n - 2;
    const t = s / spacing - i;
    const j = i + 1;
    // Hermite basis and its derivative
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    const d00 = 6 * t2 - 6 * t, d10 = 3 * t2 - 4 * t + 1, d01 = -6 * t2 + 6 * t, d11 = 3 * t2 - 2 * t;
    const L = spacing;
    out.s = s;
    out.x = h00 * x[i] + h10 * L * cx[i] + h01 * x[j] + h11 * L * cx[j];
    out.y = h00 * y[i] + h10 * L * cy[i] + h01 * y[j] + h11 * L * cy[j];
    const dx = d00 * x[i] + d10 * L * cx[i] + d01 * x[j] + d11 * L * cx[j];
    const dy = d00 * y[i] + d10 * L * cy[i] + d01 * y[j] + d11 * L * cy[j];
    out.heading = t === 0 ? heading[i] : Math.atan2(dy, dx);
    out.h = h00 * h[i] + h10 * L * grade[i] + h01 * h[j] + h11 * L * grade[j];
    out.grade = (d00 * h[i] + d10 * L * grade[i] + d01 * h[j] + d11 * L * grade[j]) / L;
    out.curvature = curvature[i] + t * (curvature[j] - curvature[i]);
    out.crossfall = crossfall[i] + t * (crossfall[j] - crossfall[i]);
    return out;
  }

  return { length, spacing, at };
}

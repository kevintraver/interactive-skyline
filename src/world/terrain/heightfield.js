// One terrain height grid: the same maths as heightField() in main.js, without three.js,
// so the provider runs under Node. Keep the arithmetic in the same order as main.js:
// groundY must match it bit for bit, and scripts/lib/heights.py matches this.

// THREE.MathUtils.clamp and lerp, written out
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (x, y, t) => (1 - t) * x + t * y;

/**
 * @param {ArrayBuffer} buf  uint16 heights, row 0 = south
 * @param {{ nx: number, ny: number, x0: number, y0: number, step: number, scale: number }} g  an entry of terrain.json's grids
 */
export function heightField(buf, g) {
  const raw = new Uint16Array(buf);
  const at = (i, j) => raw[j * g.nx + i] * g.scale;
  return {
    ...g, raw, at,
    /** Bilinear height above sea level at map (x, y); clamped to the grid's edge outside it. */
    sample(x, y) {
      const fx = clamp((x - g.x0) / g.step, 0, g.nx - 1.001);
      const fy = clamp((y - g.y0) / g.step, 0, g.ny - 1.001);
      const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j;
      return lerp(lerp(at(i, j), at(i + 1, j), ax), lerp(at(i, j + 1), at(i + 1, j + 1), ax), ay);
    },
    /** Strictly inside the grid, at least `inset` metres from its edge. */
    contains(x, y, inset = 0) {
      return x > g.x0 + inset && x < g.x0 + (g.nx - 1) * g.step - inset
        && y > g.y0 + inset && y < g.y0 + (g.ny - 1) * g.step - inset;
    },
  };
}

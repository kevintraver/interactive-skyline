// The ground as the drive DRAWS it, for everything the drive stands on the ground. Pure, no three.js.
//
// A grid's height query (heightfield.js `sample`) interpolates each cell bilinearly, but the mesh on screen
// draws each cell as two triangles split along its (i+1, j)-(i, j+1) diagonal (widemesh.js, patches.js, and
// terrainMesh in src/city/terrain.js), and in a twisted cell the two surfaces differ by up to a quarter of
// |h00 + h11 - h01 - h10|: metres, on 160 m posts in the mountains. A coarser mesh is also still drawn, 8 m
// sunk, under a finer one, and the ring of its cells along the finer grid's edge is only partly sunk. So the
// ground that is seen at a point is the highest of the triangles of every mesh drawn there: this.
//
// What is drawn where (the drive's scene): near whole; far with the cells well inside near cut out and its
// posts inside near sunk; wide with the cells well inside far cut out, its posts inside far sunk, and every
// cell inside a loaded patch cut out; each patch whole. scripts/lib/ground.py (`drawn_surface`) is the
// Python twin; tests hold the two together.

const SINK = 8; // widemesh.js SINK, and terrainMesh in src/city/terrain.js

/** The (lo, hi) extent of a grid along x and y. */
const spanOf = (g) => [g.x0, g.x0 + (g.nx - 1) * g.step, g.y0, g.y0 + (g.ny - 1) * g.step];

/**
 * One mesh as drawn: its triangles, its posts sunk under `hole`, its cells well inside `hole` and inside any of
 * `cuts()` left out. sample(x, y) is -Infinity where this mesh draws nothing.
 * @param {ReturnType<import('./heightfield.js').heightField>} g
 * @param {ReturnType<import('./heightfield.js').heightField> | null} hole  the finer grid drawn over it
 * @param {() => Array<{ nx: number, ny: number, x0: number, y0: number, step: number }>} [cuts]  patches cut out of it
 */
export function drawnGrid(g, hole, cuts = () => []) {
  const { nx, ny, step, x0, y0, scale, raw } = g;
  const [hx0, hx1, hy0, hy1] = hole ? spanOf(hole) : [0, 0, 0, 0];
  // as the meshes compute them: a post is sunk strictly inside the hole; a cell is cut when both of its posts
  // along each axis lie more than one step inside it
  const sunk = (v, lo, hi) => v > lo && v < hi;
  const cutAxis = (v, lo, hi) => v > lo + step && v < hi - step && v + step > lo + step && v + step < hi - step;
  const post = (i, j) => {
    const h = raw[j * nx + i] * scale;
    return hole && sunk(x0 + i * step, hx0, hx1) && sunk(y0 + j * step, hy0, hy1) ? h - SINK : h;
  };
  return {
    grid: g,
    sample(x, y) {
      const fx = (x - x0) / step, fy = (y - y0) / step;
      if (!(fx >= 0 && fx <= nx - 1 && fy >= 0 && fy <= ny - 1)) return -Infinity;
      const i = Math.min(Math.floor(fx), nx - 2), j = Math.min(Math.floor(fy), ny - 2);
      const cx = x0 + i * step, cy = y0 + j * step;
      if (hole && cutAxis(cx, hx0, hx1) && cutAxis(cy, hy0, hy1)) return -Infinity;
      for (const c of cuts()) {
        const [px0, px1, py0, py1] = spanOf(c);
        if (cx >= px0 && cx + step <= px1 && cy >= py0 && cy + step <= py1) return -Infinity;
      }
      const ax = fx - i, ay = fy - j;
      const a = post(i, j), b = post(i + 1, j), d = post(i, j + 1), e = post(i + 1, j + 1);
      return ax + ay <= 1 ? a + ax * (b - a) + ay * (d - a) : e + (1 - ax) * (d - e) + (1 - ay) * (b - e);
    },
  };
}

/**
 * The drawn ground over a set of meshes: the highest of them at the point, or `fallback` where none draws.
 * @param {Array<ReturnType<typeof drawnGrid>>} meshes  @param {(x: number, y: number) => number} fallback
 */
export function drawnSurface(meshes, fallback) {
  return (x, y) => {
    let top = -Infinity;
    for (let k = 0; k < meshes.length; k++) {
      const h = meshes[k].sample(x, y);
      if (h > top) top = h;
    }
    return top === -Infinity ? fallback(x, y) : top;
  };
}

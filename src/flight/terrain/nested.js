// One height function over the nested grids (plan 03, sections 7.1, 7.9 and 7.14; F4.7). Pure, no three.js.
//
// Finest first: the map's near and far grids where they reach (the app's provider, src/world/terrain), then valley,
// approaches and region as they are loaded; outside them all, region's clamped edge (or the provider's, before any
// is loaded). Each is bilinear in its own posts, as heightfield.js is. Along the edges of approaches and valley the
// finer grid was stitched to its parent when built (scripts/lib/grids.py stitch_to_parent), so the height is
// continuous there to the encodings' rounding; along far's edge valley was bent to far (conform_to_child) and the two
// agree to a median 0.18 m, at most 26 m in the mountains.
//
// Heights are metres above sea level; groundY and surfaceY are scene Y, the curve of the app's datum applied
// (src/core/earth.js curveDrop: the 7/6 refraction radius).

import { curveDrop, horizonDistance } from '../../core/earth.js';

/** The nested grids of terrain.json this module serves, coarsest first (their `priority`). */
export const NESTED_ORDER = ['region', 'approaches', 'valley'];
/** The highest ground in the region (Mount Whitney, 4,421 m): how far beyond the horizon a summit can still show. */
export const HIGHEST = 4421;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (x, y, t) => (1 - t) * x + t * y;

/**
 * A decoded grid (decode.js decodeGrid) as a surface in metres.
 * @param {{ nx: number, ny: number, x0: number, y0: number, step: number, scale: number, offset: number, q: Uint16Array }} g
 */
export function gridField(g) {
  const { nx, ny, x0, y0, step, scale, offset, q } = g;
  const at = (i, j) => q[j * nx + i] * scale + offset;
  const x1 = x0 + (nx - 1) * step, y1 = y0 + (ny - 1) * step;
  return {
    ...g, at, x1, y1,
    /** Bilinear height above sea level at map (x, y); clamped to the grid's edge outside it (heightfield.js's rule). */
    sample(x, y) {
      const fx = clamp((x - x0) / step, 0, nx - 1.001), fy = clamp((y - y0) / step, 0, ny - 1.001);
      const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j;
      return lerp(lerp(at(i, j), at(i + 1, j), ax), lerp(at(i, j + 1), at(i + 1, j + 1), ax), ay);
    },
    /**
     * The height of the grid's triangles at stride 1, as meshes.js draws each cell: split along its (i+1, j)-(i, j+1)
     * diagonal. Clamped to the edge outside the grid.
     */
    triangles(x, y) {
      const fx = clamp((x - x0) / step, 0, nx - 1), fy = clamp((y - y0) / step, 0, ny - 1);
      const i = Math.min(Math.floor(fx), nx - 2), j = Math.min(Math.floor(fy), ny - 2), ax = fx - i, ay = fy - j;
      const a = at(i, j), b = at(i + 1, j), d = at(i, j + 1), e = at(i + 1, j + 1);
      return ax + ay <= 1 ? a + ax * (b - a) + ay * (d - a) : e + (1 - ax) * (d - e) + (1 - ay) * (b - e);
    },
    /** Strictly inside the grid, at least `inset` metres from its edge. */
    contains(x, y, inset = 0) {
      return x > x0 + inset && x < x1 - inset && y > y0 + inset && y < y1 - inset;
    },
  };
}

/** The extent of a grid as { x0, x1, y0, y1 }. */
export const extentOf = (g) => ({ x0: g.x0, y0: g.y0, x1: g.x0 + (g.nx - 1) * g.step, y1: g.y0 + (g.ny - 1) * g.step });

/** Distance from (x, y) to the nearest point of an extent (0 inside). */
const distToBox = (x, y, e) => Math.hypot(Math.max(e.x0 - x, 0, x - e.x1), Math.max(e.y0 - y, 0, y - e.y1));
/** Whether the disc of radius r about (x, y) lies wholly inside an extent. */
const discInside = (x, y, r, e) => x - r >= e.x0 && x + r <= e.x1 && y - r >= e.y0 && y + r <= e.y1;

/**
 * @param {{ terrain: { grid: (name: string) => object | null, surfaceAt?: (x: number, y: number) => number,
 *           heightAt: (x: number, y: number) => number },
 *           base: number, extents?: Record<string, { x0: number, x1: number, y0: number, y1: number }> }} o
 *   terrain is the app's provider (src/world/terrain/index.js createTerrain): its near and far grids answer first.
 *   extents are the nested grids' extents from terrain.json, so needed() can answer before they are loaded.
 */
export function createNested({ terrain, base, extents = {} }) {
  const near = terrain.grid('near'), far = terrain.grid('far');
  /** name -> gridField, once added */
  const grids = new Map();
  const known = { ...extents };
  /** finest first: the loaded nested grids (valley, approaches, region) */
  let order = [];
  const inFlight = new Set();

  const relayer = () => { order = [...NESTED_ORDER].reverse().filter((n) => grids.has(n)).map((n) => [n, grids.get(n)]); };

  /** The name of the grid that answers at (x, y). */
  function sourceAt(x, y) {
    if (near && near.contains(x, y)) return 'near';
    if (far && far.contains(x, y)) return 'far';
    for (const [n, g] of order) if (g.contains(x, y)) return n;
    return order.length ? order[order.length - 1][0] : 'far';
  }

  function heightAt(x, y) {
    if (near && near.contains(x, y)) return near.sample(x, y);
    if (far && far.contains(x, y)) return far.sample(x, y);
    for (let k = 0; k < order.length; k++) if (order[k][1].contains(x, y)) return order[k][1].sample(x, y);
    if (order.length) return order[order.length - 1][1].sample(x, y);
    return terrain.heightAt(x, y);
  }

  /** The drawn surface: the map's own (provider surfaceAt) inside far, a nested grid's stride-1 triangles beyond. */
  function surfaceAt(x, y) {
    if (far && far.contains(x, y) && terrain.surfaceAt) return terrain.surfaceAt(x, y);
    if (near && near.contains(x, y)) return near.sample(x, y);
    if (far && far.contains(x, y)) return far.sample(x, y);
    for (let k = 0; k < order.length; k++) if (order[k][1].contains(x, y)) return order[k][1].triangles(x, y);
    if (order.length) return order[order.length - 1][1].triangles(x, y);
    return terrain.heightAt(x, y);
  }

  return {
    heightAt,
    sourceAt,
    surfaceAt,
    /** Scene Y of heightAt: the bilinear query, base removed, the datum's curve applied. */
    groundY: (x, y) => heightAt(x, y) - base - curveDrop(x, y),
    /** Scene Y of the drawn ground (surfaceAt). */
    surfaceY: (x, y) => surfaceAt(x, y) - base - curveDrop(x, y),
    /** Add a decoded grid (decode.js decodeGrid) by its terrain.json name; heightAt answers from it at once. */
    add(name, decoded) {
      const g = gridField(decoded);
      grids.set(name, g);
      known[name] = extentOf(g);
      relayer();
      return g;
    },
    /** Drop a grid from the height function (meshes.js keeps its own reference while it draws it). */
    remove(name) { grids.delete(name); relayer(); },
    has: (name) => grids.has(name),
    /** A grid by name: 'near' and 'far' from the provider, or a nested grid once added; null otherwise. */
    grid: (name) => (name === 'near' ? near : name === 'far' ? far : grids.get(name) ?? null),
    /**
     * Which nested grids a camera needs, coarsest first (section 7.14, by geometry rather than by height band): a
     * grid is needed when the ground the eye can see reaches it and is not all inside the next finer grid. What the
     * eye can see is a disc about the point below it, as far as the horizon and a summit beyond it
     * (horizonDistance(altitude) + horizonDistance(HIGHEST)), and no further than the far plane.
     * @param {{ x: number, y: number, altitude: number, far?: number }} o  map metres, metres above sea level, the far
     *   plane in metres
     * @returns {string[]}
     */
    needed({ x, y, altitude, far: farPlane = Infinity }) {
      const r = Math.min(horizonDistance(Math.max(altitude, 2)) + horizonDistance(HIGHEST), farPlane);
      const out = [];
      for (let k = 0; k < NESTED_ORDER.length; k++) {
        const name = NESTED_ORDER[k], e = known[name];
        if (!e) continue;
        if (distToBox(x, y, e) > r) continue;
        const finer = NESTED_ORDER.slice(k + 1).map((n) => known[n]).filter(Boolean);
        if (finer.length && discInside(x, y, r, finer[0])) continue;
        out.push(name);
      }
      return out;
    },
    /** Follow a load (any promise) so whenSettled() waits for it; failures are swallowed here (the caller sees them). */
    track(name, promise) {
      const p = Promise.resolve(promise);
      inFlight.add(p);
      const done = () => inFlight.delete(p);
      p.then(done, done);
      return p;
    },
    /** Resolves once nothing tracked is loading. */
    async whenSettled() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    get loading() { return inFlight.size; },
    /** The loaded nested grids, coarsest first. */
    get names() { return NESTED_ORDER.filter((n) => grids.has(n)); },
  };
}

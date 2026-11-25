// The map's ground made to agree with the airport while flying (plan 03, sections 7.9 and 7.10; F4.8 done in the app).
//
// The airport's pavement (src/flight/airport) lies on its own height model: each runway on its published profile, the
// taxiways and aprons on the terrain, eased between over 60 m. The map's near (12 m posts) and far (80 m posts) ground
// meshes do not know that model: on a runway the ground can stand a metre above the profile (it pokes through the
// pavement) or a metre below it (the pavement floats, and the wheels, which the bake puts on the profile, float with
// it). Until an `airport` inset grid with the pavement burnt in exists (F4.8's data), the flight moves the vertices of
// the map's two meshes around the airport onto the height model while it flies, and puts them back exactly on leaving:
//
//   within ONE_CELL of pavement   the height model minus SINK, so the ground lies under the pavement everywhere (the
//                                 pavement mesh is cut on 25 m cells and lifted 4 to 12 cm; a ground triangle has all
//                                 three vertices sunk when any part of it lies under pavement)
//   elsewhere near the airport    the height model, which beyond the 60 m ease is the ground's own height again, so
//                                 nothing moves there
//
// Pure apart from the BufferAttribute it is handed: no scene, no renderer.
import { curveDrop } from '../../core/earth.js';

/** How far under the pavement's height model the ground is put (m). Paint and pavement lie 4 to 15 cm above the
 * model, so the ground is 0.29 to 0.40 m under what is drawn: deep enough to cover the difference between the 25 m
 * pavement cells and the ground's triangles, shallow enough that the dip along a runway's edge does not show. */
export const SINK = 0.25;
/** A vertex this many cells (of its own grid) from pavement is sunk: every triangle touching pavement then is. */
export const ONE_CELL = 1.5;

/**
 * Work out the conformed heights of one ground mesh, without changing it.
 * @param {{ positions: { array: Float32Array }, grid: { nx: number, ny: number, x0: number, y0: number, step: number },
 *   base: number, hole?: { x0: number, x1: number, y0: number, y1: number } | null,
 *   heightModel: (x: number, y: number) => number, onPavement: (x: number, y: number, tol: number) => boolean,
 *   box: [number, number, number, number], sink?: number }} o
 *   positions: the mesh's position attribute (vertex k is post (k % nx, k / nx), as src/city/terrain.js lays them out);
 *   hole: the finer grid's extent for the coarse mesh (vertices strictly inside it are the map's own sunk ones and are
 *   left alone); heightModel: metres above sea level (airport heightAt); onPavement(x, y, tol): on or within tol of
 *   pavement; box: [x0, y0, x1, y1] map metres to work in; under: an inset's extent (buildInset): the vertices strictly
 *   inside it go INSET_SINK under both their own height and the model, out of the inset's way, and the others are left
 * @returns {{ index: Uint32Array, conformed: Float32Array, original: Float32Array, first: number, count: number,
 *   moved: { up: number, down: number, max: number } }} index: the vertices that move; first and count: the span of
 *   the attribute's floats they lie in (for an update range)
 */
export function conformGround({ positions, grid, base, hole = null, heightModel, onPavement, box: box0, sink = SINK, under = null }) {
  const { nx, ny, x0, y0, step } = grid;
  const box = under ? [under.x0, under.y0, under.x1, under.y1] : box0;
  const pos = positions.array;
  const i0 = Math.max(0, Math.floor((box[0] - x0) / step)), i1 = Math.min(nx - 1, Math.ceil((box[2] - x0) / step));
  const j0 = Math.max(0, Math.floor((box[1] - y0) / step)), j1 = Math.min(ny - 1, Math.ceil((box[3] - y0) / step));
  const idx = [], up = [], was = [];
  let movedUp = 0, movedDown = 0, max = 0;
  const strictly = (v, a, b) => v > a && v < b;
  for (let j = j0; j <= j1; j++) {
    const y = y0 + j * step;
    for (let i = i0; i <= i1; i++) {
      const x = x0 + i * step;
      if (hole && strictly(x, hole.x0, hole.x1) && strictly(y, hole.y0, hole.y1)) continue;
      const k = j * nx + i;
      const old = pos[k * 3 + 1];
      let target;
      if (under) {
        // strictly inside the inset's box (near's own vertices, which the map already sinks, are skipped above)
        if (!(strictly(x, under.x0, under.x1) && strictly(y, under.y0, under.y1))) continue;
        target = Math.fround(Math.min(old, heightModel(x, y) - base - curveDrop(x, y)) - INSET_SINK);
      } else {
        const z = heightModel(x, y) - (onPavement(x, y, ONE_CELL * step) ? sink : 0);
        target = Math.fround(z - base - curveDrop(x, y));
      }
      if (Math.abs(target - old) < 1e-3) continue;
      idx.push(k); up.push(target); was.push(old);
      if (target > old) movedUp++; else movedDown++;
      max = Math.max(max, Math.abs(target - old));
    }
  }
  const index = Uint32Array.from(idx);
  const first = index.length ? index[0] * 3 + 1 : 0;
  const count = index.length ? index[index.length - 1] * 3 + 2 - first : 0;
  return { index, conformed: Float32Array.from(up), original: Float32Array.from(was), first, count, moved: { up: movedUp, down: movedDown, max } };
}

/**
 * Put conformed (on) or original (off) heights into a position attribute and mark the span for upload.
 * @param {import('three').BufferAttribute} attribute  @param {ReturnType<typeof conformGround>} c  @param {boolean} on
 */
export function applyConformed(attribute, c, on) {
  const pos = attribute.array, src = on ? c.conformed : c.original;
  for (let n = 0; n < c.index.length; n++) pos[c.index[n] * 3 + 1] = src[n];
  if (!c.index.length) return;
  attribute.clearUpdateRanges?.();
  attribute.addUpdateRange?.(c.first, c.count);
  attribute.needsUpdate = true;
}

/** The box ([x0, y0, x1, y1], map metres) around every pavement polygon of airport.json, grown by `margin`. */
export function pavementBox(data, margin = 0) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const list of Object.values(data.pavement || {})) {
    for (const p of list) {
      const r = p.ring;
      for (let k = 0; k < r.length; k += 2) {
        b[0] = Math.min(b[0], r[k]); b[2] = Math.max(b[2], r[k]);
        b[1] = Math.min(b[1], r[k + 1]); b[3] = Math.max(b[3], r[k + 1]);
      }
    }
  }
  return [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin];
}

/** Posts of the inset (m): the near grid's. */
export const INSET_STEP = 12;
/** How far the coarse grid's vertices under the inset are put below their own height (m). */
export const INSET_SINK = 4;

/** Width of the band outside the near grid over which the airport's ground passes from near's edge to far (m). */
export const NEAR_BLEND = 60;

/**
 * The ground the airport is laid on (createAirport's `terrain`): the map's drawn ground (the provider's surfaceAt),
 * except that outside the near grid it passes from near's edge height to the far grid's over NEAR_BLEND metres. The
 * map's own ground steps by up to a metre at near's edge (two grids, two samplings); the pavement must not.
 * @param {{ surfaceAt: (x: number, y: number) => number }} provider  @param {{ sample: Function, x0: number, y0: number, nx: number, ny: number, step: number }} near
 */
export function airportTerrain(provider, near) {
  const x1 = near.x0 + (near.nx - 1) * near.step, y1 = near.y0 + (near.ny - 1) * near.step;
  const smooth = (t) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
  return {
    surfaceAt(x, y) {
      const d = Math.hypot(Math.max(near.x0 - x, 0, x - x1), Math.max(near.y0 - y, 0, y - y1));
      const inside = x > near.x0 && x < x1 && y > near.y0 && y < y1;
      if (inside || d >= NEAR_BLEND) return provider.surfaceAt(x, y);
      if (d <= 0) return near.sample(x, y); // on near's edge: its mesh's edge (linear between posts, as bilinear is there)
      const w = smooth(d / NEAR_BLEND);
      return (1 - w) * near.sample(x, y) + w * provider.surfaceAt(x, y); // near.sample clamps to its edge
    },
  };
}

/**
 * The inset: a 12 m ground mesh for the part of the airport the near grid does not cover (at Las Vegas the 26L/26R
 * side to the south and the runway ends to the east lie on the far grid's 80 m posts, which cannot follow a runway's
 * 60 m ease to the ground). Built at run time from the heights the app already has, onto the airport's height model as
 * the near grid's vertices are; cells inside near are left out. Its posts are near's; its outer edges lie on far posts
 * (every 240 m) and take the far grid's triangles; its edges against near take near's conformed edge. Returns null when
 * the airport lies inside near.
 * @param {{ far: { nx: number, ny: number, x0: number, y0: number, step: number }, farY: (x: number, y: number) => number,
 *   nearY: (x: number, y: number) => number, near: { x0: number, x1: number, y0: number, y1: number },
 *   box: [number, number, number, number], base: number, heightModel: (x: number, y: number) => number,
 *   onPavement: (x: number, y: number, tol: number) => boolean, sink?: number }} o
 *   farY: scene Y of the far mesh's triangles as the map draws them (before any change); nearY: scene Y of the near
 *   mesh as it is drawn while flying (conformed). Along an outer edge the inset's 12 m posts cut the corners of the far
 *   grid's 80 m polyline by up to 5 cm; no crack can open there, since the far mesh slopes down under the inset.
 * @returns {null | { nx: number, ny: number, x0: number, y0: number, x1: number, y1: number, step: number, near: object,
 *   position: Float32Array, normal: Float32Array, uv: Float32Array, index: Uint32Array }}
 */
export function buildInset({ far, farY, nearY, near, box, base, heightModel, onPavement, sink = SINK }) {
  const s = INSET_STEP, lattice = 240; // lcm of 12 and 80: near's posts and far's
  const snapDown = (v, o) => o + Math.floor((v - o) / lattice) * lattice, snapUp = (v, o) => o + Math.ceil((v - o) / lattice) * lattice;
  if (box[0] >= near.x0 && box[2] <= near.x1 && box[1] >= near.y0 && box[3] <= near.y1) return null;
  const x0 = snapDown(box[0], near.x0), x1 = snapUp(box[2], near.x0), y0 = snapDown(box[1], near.y0), y1 = snapUp(box[3], near.y0);
  const nx = Math.round((x1 - x0) / s) + 1, ny = Math.round((y1 - y0) / s) + 1;
  const position = new Float32Array(nx * ny * 3), normal = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  const fw = (far.nx - 1) * far.step, fh = (far.ny - 1) * far.step;
  const eps = 1e-6;
  const insideNear = (x, y) => x > near.x0 + eps && x < near.x1 - eps && y > near.y0 + eps && y < near.y1 - eps;
  const onNear = (x, y) => !insideNear(x, y) && x >= near.x0 - eps && x <= near.x1 + eps && y >= near.y0 - eps && y <= near.y1 + eps;
  const hy = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * s;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * s, k = j * nx + i;
      let h;
      if (onNear(x, y) || insideNear(x, y)) h = nearY(x, y);
      else if (i === 0 || i === nx - 1 || j === 0 || j === ny - 1) h = farY(x, y);
      else h = heightModel(x, y) - (onPavement(x, y, ONE_CELL * s) ? sink : 0) - base - curveDrop(x, y);
      hy[k] = h;
      position[k * 3] = x; position[k * 3 + 1] = h; position[k * 3 + 2] = -y;
      uv[k * 2] = (x - far.x0) / fw; uv[k * 2 + 1] = (y - far.y0) / fh;
    }
  }
  const half = 1 / (2 * s);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const dx = (hy[j * nx + Math.min(i + 1, nx - 1)] - hy[j * nx + Math.max(i - 1, 0)]) * half;
      const dy = (hy[Math.min(j + 1, ny - 1) * nx + i] - hy[Math.max(j - 1, 0) * nx + i]) * half;
      const l = Math.hypot(dx, 1, dy);
      normal[k * 3] = -dx / l; normal[k * 3 + 1] = 1 / l; normal[k * 3 + 2] = dy / l;
    }
  }
  // the cells split as src/city/terrain.js splits them, along the (i+1, j)-(i, j+1) diagonal; none inside near
  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (insideNear(x0 + (i + 0.5) * s, y0 + (j + 0.5) * s)) continue;
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  return { nx, ny, x0, y0, x1, y1, step: s, near, position, normal, uv, index: Uint32Array.from(idx) };
}

/** Whether map (x, y) is on the inset's drawn cells (inside its box, outside near). */
export function onInset(inset, x, y) {
  const n = inset.near;
  return x >= inset.x0 && x <= inset.x1 && y >= inset.y0 && y <= inset.y1 && !(x > n.x0 && x < n.x1 && y > n.y0 && y < n.y1);
}

/** Scene Y of an inset's triangles at map (x, y) (inside it). */
export function insetY(inset, x, y) {
  const { nx, ny, x0, y0, step, position: p } = inset;
  const fx = Math.min(Math.max((x - x0) / step, 0), nx - 1), fy = Math.min(Math.max((y - y0) / step, 0), ny - 1);
  const i = Math.min(Math.floor(fx), nx - 2), j = Math.min(Math.floor(fy), ny - 2), ax = fx - i, ay = fy - j;
  const at = (ii, jj) => p[(jj * nx + ii) * 3 + 1];
  const a = at(i, j), b = at(i + 1, j), d = at(i, j + 1), e = at(i + 1, j + 1);
  return ax + ay <= 1 ? a + ax * (b - a) + ay * (d - a) : e + (1 - ax) * (d - e) + (1 - ay) * (b - e);
}

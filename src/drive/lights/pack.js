// The drive's served lamp product, public/data/<city>/lamps-drive.{json,bin} (scripts/pack_lamps.py; plan 02, D5.4),
// and culling its cells against a view. Pure: no three.js, no DOM; usable in a worker.
//
// Lamps are sorted into square cells (about 1 km) in row-major order; cellStart gives each cell's run of lamps,
// so "the lamps of these cells" is a list of index ranges. The layout is in the packer's header.

export const PACK_VERSION = 1;
const TYPED = { uint32: Uint32Array, uint16: Uint16Array, uint8: Uint8Array };

/**
 * @param {object} meta  lamps-drive.json
 * @param {ArrayBuffer} buffer  lamps-drive.bin
 * @returns {LampPack}
 * @typedef {Object} LampPack
 * @property {number} count  @property {number} cell  @property {number} x0  @property {number} y0
 * @property {number} nx  @property {number} ny
 * @property {Uint32Array} cellStart   nx * ny + 1
 * @property {Float64Array} x  @property {Float64Array} y   local metres, x east, y north
 * @property {Float32Array} mount      metres above the ground (a deck's lift included)
 * @property {Float32Array} lift       metres: the structure (a crossing road's deck) the pole stands on, above the ground
 * @property {Uint8Array} type  @property {Uint8Array} enclosed  @property {Uint8Array} rule
 * @property {Float32Array} lumens
 * @property {Float32Array} aim        degrees counter-clockwise from +x, NaN when unknown
 * @property {object} lampTypes        data/lamp_types.json as embedded
 */
export function decodeLampPack(meta, buffer) {
  if (meta?.version !== PACK_VERSION) throw new Error(`lamps-drive version ${meta?.version} is not supported`);
  if (buffer.byteLength !== meta.bytes) throw new Error(`lamps-drive.bin is ${buffer.byteLength} bytes, the index says ${meta.bytes}`);
  const a = {};
  for (const d of meta.arrays) a[d.name] = new TYPED[d.type](buffer, d.offset, d.length);
  const n = meta.count, { cell, q, mountQ, nx } = meta;
  const bits = meta.bits;
  const lift = new Float32Array(n);
  const x = new Float64Array(n), y = new Float64Array(n), mount = new Float32Array(n), lumens = new Float32Array(n), aim = new Float32Array(n);
  const type = new Uint8Array(n), enclosed = new Uint8Array(n), rule = new Uint8Array(n);
  const start = a.cellStart;
  for (let c = 0; c < nx * meta.ny; c++) {
    const i0 = start[c], i1 = start[c + 1];
    if (i0 === i1) continue;
    const ox = meta.x0 + (c % nx) * cell, oy = meta.y0 + Math.floor(c / nx) * cell;
    for (let i = i0; i < i1; i++) {
      x[i] = ox + a.qx[i] / q;
      y[i] = oy + a.qy[i] / q;
    }
  }
  for (let i = 0; i < n; i++) {
    const k = a.kind[i];
    lift[i] = a.lift ? a.lift[i] / mountQ : 0; // packs before the clearing have no lift
    mount[i] = a.mount[i] / mountQ + lift[i];
    type[i] = k & bits.type;
    enclosed[i] = k & bits.enclosed ? 1 : 0;
    rule[i] = k & bits.rule ? 1 : 0;
    lumens[i] = a.flux[i] * 10;
    aim[i] = k & bits.aimKnown ? (a.aim[i] * 360) / 256 : NaN;
  }
  return { count: n, cell, x0: meta.x0, y0: meta.y0, nx, ny: meta.ny, cellStart: start, x, y, mount, lift, type, enclosed, rule, lumens, aim, lampTypes: meta.lampTypes };
}

/** Index of the cell holding map point (x, y), or -1 outside the grid. */
export function cellAt(pack, x, y) {
  const cx = Math.floor((x - pack.x0) / pack.cell), cy = Math.floor((y - pack.y0) / pack.cell);
  return cx < 0 || cy < 0 || cx >= pack.nx || cy >= pack.ny ? -1 : cy * pack.nx + cx;
}

/** The non-empty cells, with their centre and a bounding sphere once heights are known (see cellBounds). */
export function nonEmptyCells(pack) {
  const out = [];
  for (let c = 0; c < pack.nx * pack.ny; c++) {
    if (pack.cellStart[c + 1] > pack.cellStart[c]) out.push(c);
  }
  return out;
}

/** Numbers per cell in the array cellBounds returns. */
export const BOUND_STRIDE = 10;

/**
 * Bounds of each non-empty cell from per-lamp heights.
 * @param {LampPack} pack  @param {Float32Array} headY scene Y of each lamp head  @param {Float32Array} headAlt the same
 *   without the curve drop (height above the city base), for the horizon  @param {number[]} cells
 * @returns {Float64Array} BOUND_STRIDE per cell: cx, cz (scene x, z of the centre), r (horizontal half-diagonal of the
 *   lamps' box), yMin, yMax (scene Y of the heads), count, first lamp, cell id, altMin, altMax
 */
export function cellBounds(pack, headY, headAlt, cells) {
  const out = new Float64Array(cells.length * BOUND_STRIDE);
  cells.forEach((c, k) => {
    const i0 = pack.cellStart[c], i1 = pack.cellStart[c + 1];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, h0 = Infinity, h1 = -Infinity, a0 = Infinity, a1 = -Infinity;
    for (let i = i0; i < i1; i++) {
      const x = pack.x[i], y = pack.y[i], h = headY[i], a = headAlt[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (h < h0) h0 = h; if (h > h1) h1 = h;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
    }
    const o = k * BOUND_STRIDE;
    out[o] = (x0 + x1) / 2; out[o + 1] = -(y0 + y1) / 2; out[o + 2] = Math.hypot(x1 - x0, y1 - y0) / 2;
    out[o + 3] = h0; out[o + 4] = h1; out[o + 5] = i1 - i0; out[o + 6] = i0; out[o + 7] = c; out[o + 8] = a0; out[o + 9] = a1;
  });
  return out;
}

/**
 * Which cells to draw: inside the view frustum (planes as [nx, ny, nz, d], inside where n.p + d >= 0, three's
 * Frustum convention), nearer than maxDistance, and above the horizon.
 * The horizon: over a sphere of radius R, a point hp above a reference surface is seen from an eye he above it out
 * to sqrt(2 R he) + sqrt(2 R hp). Heights are true altitudes (no curve drop) above `floorAlt`, which should lie
 * below any ground between the eye and the lamps (the lowest lamp less a margin), so the test is conservative; the
 * depth test against the terrain does the exact occlusion on the GPU.
 * @param {Float64Array} bounds  from cellBounds
 * @param {{ eye: {x:number,y:number,z:number}, eyeAlt: number, planes: number[][], maxDistance: number,
 *   earthR: number, floorAlt?: number, out?: Int32Array, pad?: number[] }} view
 *   pad: [metres, share of distance] added to each cell's radius in the frustum test (for a cull kept a few frames)
 * @returns {{ cells: Int32Array, count: number, lamps: number }} positions k in bounds, not cell ids
 */
export function cullCells(bounds, { eye, eyeAlt, planes, maxDistance, earthR, floorAlt, out, pad = [0, 0] }) {
  const n = bounds.length / BOUND_STRIDE;
  const res = out && out.length >= n ? out : new Int32Array(n);
  let count = 0, lamps = 0;
  const horizon = Number.isFinite(floorAlt) && Number.isFinite(eyeAlt);
  const eyeReach = horizon ? Math.sqrt(2 * earthR * Math.max(0, eyeAlt - floorAlt)) : 0;
  for (let k = 0; k < n; k++) {
    const o = k * BOUND_STRIDE;
    const cx = bounds[o], cz = bounds[o + 1], r = bounds[o + 2], y0 = bounds[o + 3], y1 = bounds[o + 4];
    const dh = Math.hypot(cx - eye.x, cz - eye.z) - r;
    if (dh > maxDistance) continue;
    if (horizon && dh > 0 && dh > eyeReach + Math.sqrt(2 * earthR * Math.max(0, bounds[o + 9] - floorAlt))) continue;
    const cy = (y0 + y1) / 2, rad = Math.hypot(r, (y1 - y0) / 2) + pad[0] + pad[1] * Math.max(0, dh);
    let inside = true;
    for (let p = 0; p < planes.length; p++) {
      const pl = planes[p];
      if (pl[0] * cx + pl[1] * cy + pl[2] * cz + pl[3] < -rad) { inside = false; break; }
    }
    if (!inside) continue;
    res[count++] = k;
    lamps += bounds[o + 5];
  }
  return { cells: res, count, lamps };
}

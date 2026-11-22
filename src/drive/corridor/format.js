/**
 * Corridor: the buildings beyond the core (plan 02, D7.6). Pure, no three.js, so it runs in the
 * mesher worker and under Node. Python twin: scripts/lib/corridor_format.py (the writer).
 *
 * Files, in public/data/<city>/corridor/:
 *
 *   index.json   { version: 1, cellSize, cells: [{ i, j, file, count, bytes, bounds: [x0, y0, x1, y1],
 *                  maxHeight }], tall: { file, count, bytes, bounds, maxHeight } | null, thresholds,
 *                  attribution, counts }
 *     A cell (i, j) holds the buildings whose footprint's centre lies in the square
 *     [i * cellSize, (i + 1) * cellSize) x [j * cellSize, (j + 1) * cellSize) in map metres, lower
 *     than `tallFrom` (20 m). `bounds` is the extent of their footprints, which may spill over the
 *     square. Every building of 20 m or more is in the one `tall` file, whatever its place.
 *
 *   <cell>.bin   one cell, little-endian:
 *
 *     offset  type     field
 *     0       u8[4]    magic "CRD1"
 *     4       u16      version, 1
 *     6       u16      flags: bit 0 "wide": points are int32 centimetres; otherwise int16 decimetres
 *     8       i32      origin x, map metres (the cell's centre; 0 for the tall file)
 *     12      i32      origin y
 *     16      u32      B, buildings
 *     20      u32      R, rings
 *     24      u32      P, points
 *     28      u32      reserved, 0
 *     32      then these sections in order, each starting at a multiple of 4 (zero padding):
 *             points     P pairs (x, y) from the origin, int16 dm or int32 cm (flag); rings are open
 *                        (the first point is not repeated), the outer one counter-clockwise, holes clockwise
 *             ringPoints u16[R]  points in each ring
 *             height     u16[B]  height above the ground, decimetres
 *             ringCount  u8[B]   rings of each building, the outer one first
 *             type       u8[B]   TYPES below
 *             rung       u8[B]   RUNGS below: where the height came from
 *     Buildings follow one another: building k's rings come right after building k - 1's. The file
 *     ends at the padded end of the last section.
 *
 * A writer rounds half away from zero to the unit. Map metres: x east, y north from the city origin.
 */

export const MAGIC = 'CRD1';
export const VERSION = 1;
export const HEADER_BYTES = 32;
export const FLAG_WIDE = 1;
export const TYPES = ['other', 'house', 'apartments', 'retail', 'warehouse', 'hotel', 'office', 'civic', 'canopy', 'shed'];
export const TYPE = Object.fromEntries(TYPES.map((t, i) => [t, i]));
export const RUNGS = ['osm-height', 'osm-levels', 'overture', 'guess'];

export class CorridorFormatError extends Error {}

const pad4 = (n) => (n + 3) & ~3;
const roundAway = (v) => Math.sign(v) * Math.floor(Math.abs(v) + 0.5);

/**
 * Read one cell into flat arrays (no copies of the big sections; views on `buf`).
 * @param {ArrayBuffer} buf
 * @returns {{ origin: [number, number], wide: boolean, count: number, rings: number,
 *   points: Int16Array|Int32Array, unit: number, ringPoints: Uint16Array, height: Uint16Array,
 *   ringCount: Uint8Array, type: Uint8Array, rung: Uint8Array, ringStart: Uint32Array, pointStart: Uint32Array }}
 *   points are in 1/unit metres from origin; height in decimetres. ringStart[k] is building k's first ring,
 *   pointStart[r] ring r's first point (both with one extra entry at the end).
 */
export function decodeCell(buf) {
  if (buf.byteLength < HEADER_BYTES) throw new CorridorFormatError('not a corridor cell');
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new CorridorFormatError('not a corridor cell');
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new CorridorFormatError(`version ${version} is not supported`);
  const wide = (dv.getUint16(6, true) & FLAG_WIDE) !== 0;
  const origin = [dv.getInt32(8, true), dv.getInt32(12, true)];
  const B = dv.getUint32(16, true), R = dv.getUint32(20, true), P = dv.getUint32(24, true);
  const size = HEADER_BYTES + pad4(2 * P * (wide ? 4 : 2)) + pad4(R * 2) + pad4(B * 2) + pad4(3 * B);
  if (size !== buf.byteLength) throw new CorridorFormatError('the counts do not match the length');
  let off = HEADER_BYTES;
  const points = wide ? new Int32Array(buf, off, 2 * P) : new Int16Array(buf, off, 2 * P);
  off = pad4(off + points.byteLength);
  const ringPoints = new Uint16Array(buf, off, R); off = pad4(off + R * 2);
  const height = new Uint16Array(buf, off, B); off = pad4(off + B * 2);
  if (off + 3 * B > buf.byteLength) throw new CorridorFormatError('the counts do not match the length');
  const ringCount = new Uint8Array(buf, off, B); off += B;
  const type = new Uint8Array(buf, off, B); off += B;
  const rung = new Uint8Array(buf, off, B); off += B;
  if (pad4(off) !== buf.byteLength) throw new CorridorFormatError('the counts do not match the length');
  const ringStart = new Uint32Array(B + 1), pointStart = new Uint32Array(R + 1);
  for (let k = 0; k < B; k++) ringStart[k + 1] = ringStart[k] + ringCount[k];
  for (let r = 0; r < R; r++) pointStart[r + 1] = pointStart[r] + ringPoints[r];
  if (ringStart[B] !== R || pointStart[R] !== P) throw new CorridorFormatError('the counts do not match the length');
  return { origin, wide, count: B, rings: R, points, unit: wide ? 100 : 10, ringPoints, height, ringCount, type, rung, ringStart, pointStart };
}

/**
 * Write one cell. The inverse of decodeCell, for tests and tools; the pipeline writes with the Python twin.
 * @param {{ origin: [number, number], wide?: boolean, buildings: { rings: [number, number][][], height: number, type: number, rung: number }[] }} cell
 * @returns {ArrayBuffer}
 */
export function encodeCell({ origin, wide = false, buildings }) {
  const unit = wide ? 100 : 10, lim = wide ? 2 ** 31 - 1 : 32767;
  const R = buildings.reduce((a, b) => a + b.rings.length, 0);
  const P = buildings.reduce((a, b) => a + b.rings.reduce((s, r) => s + r.length, 0), 0);
  const B = buildings.length;
  const ptsBytes = pad4(2 * P * (wide ? 4 : 2));
  const size = HEADER_BYTES + ptsBytes + pad4(R * 2) + pad4(B * 2) + pad4(3 * B);
  const buf = new ArrayBuffer(size), dv = new DataView(buf);
  for (let i = 0; i < 4; i++) dv.setUint8(i, MAGIC.charCodeAt(i));
  dv.setUint16(4, VERSION, true); dv.setUint16(6, wide ? FLAG_WIDE : 0, true);
  dv.setInt32(8, origin[0], true); dv.setInt32(12, origin[1], true);
  dv.setUint32(16, B, true); dv.setUint32(20, R, true); dv.setUint32(24, P, true);
  let off = HEADER_BYTES;
  const pts = wide ? new Int32Array(buf, off, 2 * P) : new Int16Array(buf, off, 2 * P);
  let ri = 0, pi = 0;
  const ringPoints = new Uint16Array(buf, (off += ptsBytes), R);
  const height = new Uint16Array(buf, (off += pad4(R * 2)), B);
  const ringCount = new Uint8Array(buf, (off += pad4(B * 2)), B);
  const type = new Uint8Array(buf, off + B, B), rung = new Uint8Array(buf, off + 2 * B, B);
  buildings.forEach((b, k) => {
    if (b.rings.length < 1 || b.rings.length > 255) throw new CorridorFormatError('a building needs 1 to 255 rings');
    ringCount[k] = b.rings.length;
    const h = roundAway(b.height * 10);
    if (h < 0 || h > 65535) throw new CorridorFormatError('a height is outside 0..6553.5 m');
    height[k] = h; type[k] = b.type; rung[k] = b.rung;
    for (const r of b.rings) {
      if (r.length < 3 || r.length > 65535) throw new CorridorFormatError('a ring needs 3 to 65535 points');
      ringPoints[ri++] = r.length;
      for (const [x, y] of r) {
        const qx = roundAway((x - origin[0]) * unit), qy = roundAway((y - origin[1]) * unit);
        if (Math.abs(qx) > lim || Math.abs(qy) > lim) throw new CorridorFormatError('a point is too far from the cell origin');
        pts[pi++] = qx; pts[pi++] = qy;
      }
    }
  });
  return buf;
}

/** Building k as plain rings of map metres, for tests and tools. */
export function buildingRings(cell, k) {
  const out = [];
  for (let r = cell.ringStart[k]; r < cell.ringStart[k + 1]; r++) {
    const ring = [];
    for (let p = cell.pointStart[r]; p < cell.pointStart[r + 1]; p++) {
      ring.push([cell.origin[0] + cell.points[2 * p] / cell.unit, cell.origin[1] + cell.points[2 * p + 1] / cell.unit]);
    }
    out.push(ring);
  }
  return out;
}

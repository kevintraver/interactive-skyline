// Reader of the valley's traffic (plan 02, D6.6): public/data/<city>/traffic/valley.json + valley.bin, written by
// scripts/build_valley_traffic.py. The specification is the comment at the top of scripts/lib/valley_traffic.py;
// change both together.

export const VALLEY_VERSION = 1;
export const HOURS_PER_WEEK = 168;
const PIECE_BYTES = 20;

/** A malformed valley file. */
export class ValleyError extends Error {}

/**
 * @param {object} doc valley.json  @param {ArrayBuffer} buffer valley.bin
 * @returns {{ tz: string, year: number, classes: string[], shapes: Float32Array[], shapeMeta: object[], names: string[],
 *   count: number, coords: Float32Array, start: Uint32Array, n: Uint16Array, cls: Uint8Array, oneway: Uint8Array,
 *   assumed: Uint8Array, lanes: Uint8Array, speed: Float32Array, fwd: Float32Array, bwd: Float32Array,
 *   shapeF: Uint8Array, shapeB: Uint8Array, name: Uint16Array }}
 *   coords: map metres (x east, y north), two per vertex; speed m/s; fwd, bwd vehicles per day
 */
export function decodeValley(doc, buffer) {
  if (!doc || doc.version !== VALLEY_VERSION) throw new ValleyError(`valley: version ${doc && doc.version} is not supported`);
  const q = Number(doc.quantum);
  if (!(q > 0)) throw new ValleyError('valley: no quantum');
  const shapes = (doc.shapes || []).map((s, i) => {
    if (!Array.isArray(s.values) || s.values.length !== HOURS_PER_WEEK) throw new ValleyError(`valley: shape ${i} needs ${HOURS_PER_WEEK} values`);
    return Float32Array.from(s.values);
  });
  if (!shapes.length) throw new ValleyError('valley: no shapes');
  const [c0, cn] = doc.bin.coords, [p0, pn] = doc.bin.pieces;
  if (c0 + cn > buffer.byteLength || p0 + pn > buffer.byteLength) throw new ValleyError('valley: the bin is too short');
  if ((doc.bin.pieceBytes || PIECE_BYTES) !== PIECE_BYTES) throw new ValleyError('valley: unknown piece record size');
  const raw = new Int16Array(buffer.slice(c0, c0 + cn));
  const coords = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) coords[i] = raw[i] * q;
  const count = pn / PIECE_BYTES;
  if (count !== doc.pieces) throw new ValleyError('valley: piece count disagrees with the bin');
  const dv = new DataView(buffer, p0, pn);
  const out = {
    tz: doc.tz, year: doc.year, classes: doc.classes, shapes, shapeMeta: doc.shapes.map(({ values, ...m }) => m),
    names: doc.names || [], count, coords,
    start: new Uint32Array(count), n: new Uint16Array(count), cls: new Uint8Array(count), oneway: new Uint8Array(count),
    assumed: new Uint8Array(count), lanes: new Uint8Array(count), speed: new Float32Array(count),
    fwd: new Float32Array(count), bwd: new Float32Array(count), shapeF: new Uint8Array(count), shapeB: new Uint8Array(count),
    name: new Uint16Array(count),
  };
  const vertices = coords.length / 2;
  for (let i = 0; i < count; i++) {
    const o = i * PIECE_BYTES;
    out.start[i] = dv.getUint32(o, true);
    out.n[i] = dv.getUint16(o + 4, true);
    out.cls[i] = dv.getUint8(o + 6);
    const flags = dv.getUint8(o + 7);
    out.oneway[i] = flags & 1;
    out.assumed[i] = (flags >> 1) & 1;
    out.lanes[i] = dv.getUint8(o + 8);
    out.speed[i] = dv.getUint8(o + 9) / 3.6;
    out.fwd[i] = dv.getUint16(o + 10, true) * 10;
    out.bwd[i] = dv.getUint16(o + 12, true) * 10;
    out.shapeF[i] = dv.getUint8(o + 14);
    out.shapeB[i] = dv.getUint8(o + 15);
    out.name[i] = dv.getUint16(o + 18, true);
    if (out.start[i] + out.n[i] > vertices || out.n[i] < 2) throw new ValleyError(`valley: piece ${i} has bad vertices`);
    if (out.shapeF[i] >= shapes.length || out.shapeB[i] >= shapes.length) throw new ValleyError(`valley: piece ${i} names a missing shape`);
    if (!(out.speed[i] > 0)) throw new ValleyError(`valley: piece ${i} has no speed`);
  }
  return out;
}

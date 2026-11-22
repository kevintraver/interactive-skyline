/**
 * Barriers v1: the roadside barriers and delineators written by scripts/build_roadside.py
 * (plan 02, D3.6 and D3.7) and read by the road mesher (barriers, swept into the road chunks) and
 * the roadside (delineators, instanced).
 *
 * This comment is the specification. `encodeBarriers` is the reference writer; the Python writer
 * (scripts/lib/roadside_barrier_format.py) must produce the same text for the same input, and
 * tests/unit/roadside/barrierFormat.test.js with tests/data/test_barriers.py hold the two together.
 *
 * One file per route: `barriers.json` for route i15n, `barriers-<route>.json` for any other.
 * Compact JSON (no spaces), UTF-8, one trailing newline.
 *
 * ---------------------------------------------------------------- conventions
 * Roads and chainages are those of the RoadNet (src/drive/roadnet/format.js): `s` metres along a
 * road's reference line, "left" and "right" as seen facing the direction of travel. An offset `o`
 * is metres OUTWARD from that side's outer shoulder edge (the pavement edge edgesAt gives,
 * tapers included): positive away from the road, negative onto the shoulder. So a run follows the
 * pavement edge through tapers without a point of its own per station.
 *
 * Numbers: an integral value is written as an integer ("12", never "12.0"); chainages are
 * rounded to 0.1 m, offsets and heights relative to the pavement to 0.01 m, wall heights to 0.1 m.
 *
 * ---------------------------------------------------------------- document
 * {
 *   "version": 1,                          required, must be 1
 *   "source": { ... },                     optional, free-form provenance (default {})
 *   "types": ["concrete", "guardrail", "wall", "cable"],   required: the names run types index
 *   "roads": [ road, ... ]                 required (may be empty)
 * }
 * road = {
 *   "id": "i15n.main",                     required: a RoadNet road id
 *   "runs": [ run, ... ],                  optional (default []): barrier pieces, in order of s0
 *   "delineators": [ delineator, ... ]     optional (default [])
 * }
 * run = [s0, s1, side, type, o0, o1, prov, ends]            8 numbers, or
 *       [s0, s1, side, type, o0, o1, prov, ends, h, z0, z1] 11 numbers (walls)
 *   s0 < s1      metres; the piece covers [s0, s1]
 *   side         0 left, 1 right
 *   type         index into "types"
 *   o0, o1       offset at s0 and at s1; linear in s between
 *   prov         0 mapped (an OSM barrier way), 1 rule (scripts/lib/roadside_barriers.py)
 *   ends         bit 0: the piece's start is a free end (needs an end treatment: a sloped end on
 *                a concrete barrier, a flared, buried end on a guardrail, a capped end on a
 *                wall); bit 1: likewise its end. A clear bit means the next or previous piece
 *                carries on from there (the same barrier, split for its offsets).
 *   h            wall height above its base, metres
 *   z0, z1       the wall's base relative to the pavement edge's height at s0 and s1 (the ground
 *                or the embankment, whichever is higher, as the pipeline found it); linear between.
 *                Other types stand on the embankment surface the mesher draws (mesher.js).
 * delineator = [side, colour, o, [s, s, ...]]
 *   side         0 left, 1 right
 *   colour       0 white, 1 yellow (sheeting of the reflector, MUTCD 3F)
 *   o            offset of the post (outward from the shoulder edge)
 *   s            chainages, increasing
 * Unknown top-level and road fields are kept by the decoder and written back by the encoder.
 */

export const TYPES = ['concrete', 'guardrail', 'wall', 'cable'];
export const SIDES = ['left', 'right'];
export const PROVENANCE = ['mapped', 'rule'];
export const COLOURS = ['white', 'yellow'];

/** A malformed barriers file. */
export class BarrierFormatError extends Error {
  constructor(message) { super(`barriers: ${message}`); this.name = 'BarrierFormatError'; }
}
const fail = (m) => { throw new BarrierFormatError(m); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Round to `k` decimals the way the Python writer does (half away from zero), integral values as integers. */
export function num(v, k) {
  const f = 10 ** k;
  const r = Math.sign(v) * Math.round(Math.abs(v) * f) / f;
  return r === 0 ? 0 : r; // never -0
}

/**
 * Decode a parsed barriers document.
 * @returns {{ version: 1, source: object, types: string[], roads: { id: string, runs: object[], delineators: object[] }[] }}
 *   run: { s0, s1, side: 'left'|'right', type: string, o0, o1, prov: 'mapped'|'rule', open0, open1, h, z0, z1 }
 *   delineator: { side, colour: 'white'|'yellow', o, s: number[] }
 */
export function decodeBarriers(doc) {
  if (!doc || typeof doc !== 'object') fail('not an object');
  if (doc.version !== 1) fail(`version ${doc.version} is not supported`);
  if (!Array.isArray(doc.types) || !doc.types.length) fail('no types');
  if (!Array.isArray(doc.roads)) fail('no roads');
  const roads = doc.roads.map((r, ri) => {
    if (!r || typeof r.id !== 'string') fail(`road ${ri} has no id`);
    const runs = (r.runs || []).map((a, k) => {
      const where = `road ${r.id} run ${k}`;
      if (!Array.isArray(a) || (a.length !== 8 && a.length !== 11) || !a.every(isNum)) fail(`${where} must be 8 or 11 numbers`);
      const [s0, s1, side, type, o0, o1, prov, ends] = a;
      if (!(s1 > s0)) fail(`${where} needs s0 < s1`);
      if (side !== 0 && side !== 1) fail(`${where} side must be 0 or 1`);
      if (!Number.isInteger(type) || type < 0 || type >= doc.types.length) fail(`${where} type is out of range`);
      if (prov !== 0 && prov !== 1) fail(`${where} prov must be 0 or 1`);
      if (!Number.isInteger(ends) || ends < 0 || ends > 3) fail(`${where} ends must be 0..3`);
      const run = { s0, s1, side: SIDES[side], type: doc.types[type], o0, o1, prov: PROVENANCE[prov], open0: !!(ends & 1), open1: !!(ends & 2), h: 0, z0: 0, z1: 0 };
      if (a.length === 11) { run.h = a[8]; run.z0 = a[9]; run.z1 = a[10]; }
      return run;
    });
    for (let k = 1; k < runs.length; k++) if (runs[k].s0 < runs[k - 1].s0) fail(`road ${r.id} runs are not in order of s0`);
    const delineators = (r.delineators || []).map((a, k) => {
      const where = `road ${r.id} delineators ${k}`;
      if (!Array.isArray(a) || a.length !== 4 || !Array.isArray(a[3])) fail(`${where} must be [side, colour, o, [s...]]`);
      const [side, colour, o, s] = a;
      if (side !== 0 && side !== 1) fail(`${where} side must be 0 or 1`);
      if (colour !== 0 && colour !== 1) fail(`${where} colour must be 0 or 1`);
      if (!isNum(o) || !s.every(isNum)) fail(`${where} has a value that is not a number`);
      for (let i = 1; i < s.length; i++) if (!(s[i] > s[i - 1])) fail(`${where} chainages must increase`);
      return { side: SIDES[side], colour: COLOURS[colour], o, s };
    });
    const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'runs', 'delineators'].includes(k)));
    return { ...extra, id: r.id, runs, delineators };
  });
  const extra = Object.fromEntries(Object.entries(doc).filter(([k]) => !['version', 'source', 'types', 'roads'].includes(k)));
  return { ...extra, version: 1, source: doc.source || {}, types: [...doc.types], roads };
}

/** The text of a barriers file for decoded (or decoded-shaped) data: the reference writer. */
export function encodeBarriers(data) {
  const types = data.types || TYPES;
  const roads = data.roads.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) if (!['id', 'runs', 'delineators'].includes(k)) out[k] = v;
    const runs = r.runs.map((x) => {
      const a = [num(x.s0, 1), num(x.s1, 1), SIDES.indexOf(x.side), types.indexOf(x.type), num(x.o0, 2), num(x.o1, 2),
        PROVENANCE.indexOf(x.prov), (x.open0 ? 1 : 0) | (x.open1 ? 2 : 0)];
      if (x.type === 'wall') a.push(num(x.h, 1), num(x.z0, 2), num(x.z1, 2));
      return a;
    });
    const delineators = r.delineators.map((d) => [SIDES.indexOf(d.side), COLOURS.indexOf(d.colour), num(d.o, 2), d.s.map((v) => num(v, 1))]);
    return { id: r.id, ...out, runs, delineators };
  });
  const extra = {};
  for (const [k, v] of Object.entries(data)) if (!['version', 'source', 'types', 'roads'].includes(k)) extra[k] = v;
  return `${JSON.stringify({ version: 1, source: data.source || {}, types, ...extra, roads })}\n`;
}

/** A barriers document decoded, whether it comes raw (as parsed from the file) or decoded already. */
export function asDecoded(doc) {
  const raw = doc?.roads?.some((r) => (r.runs || []).some((a) => Array.isArray(a)) || (r.delineators || []).some((a) => Array.isArray(a)));
  return raw ? decodeBarriers(doc) : doc;
}

/** Runs of one road by side, for the mesher: { left: run[], right: run[] } (each in order of s0). */
export function runsBySide(road) {
  const out = { left: [], right: [] };
  for (const r of road?.runs || []) out[r.side].push(r);
  return out;
}

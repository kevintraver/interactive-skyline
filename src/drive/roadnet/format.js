/**
 * RoadNet v1: the road description written by scripts/build_roads.py and read by the drive.
 *
 * A RoadNet is two files side by side, `roadnet.json` (structure) and `roadnet.bin` (stations).
 * This comment is the specification; `encodeRoadNet` below is the reference writer, and a Python
 * writer must produce the same bytes for the same input.
 *
 * ---------------------------------------------------------------- frame and conventions
 * Map coordinates: x east, y north, metres from the city origin (Las Vegas: Las Vegas Blvd and
 * Flamingo Rd). h is metres above sea level (the pipeline's DEM datum). No earth curvature is
 * applied in the file; the runtime bakes it in.
 * s (chainage) is arc length along a road's reference line in metres, starting at 0 at the
 * road's first station and increasing in the direction of travel.
 * "Left" and "right" are as seen by a driver facing the direction of travel. A lateral offset d
 * is metres from the reference line, POSITIVE TO THE LEFT.
 *
 * ---------------------------------------------------------------- roadnet.bin
 * A flat array of little-endian signed 32-bit integers, no header, no padding. One record of
 * seven integers (28 bytes) per station, in this order:
 *
 *   0  s          millimetres        chainage
 *   1  x          millimetres        map east
 *   2  y          millimetres        map north
 *   3  h          millimetres        height of the reference line above sea level
 *   4  heading    microradians       direction of travel, measured from map +x (east)
 *                                    counter-clockwise towards +y (north): 0 = east,
 *                                    1570796 = north, -1570796 = south. Normalised to
 *                                    (-pi, pi], i.e. -3141592 ..= 3141593.
 *   5  curvature  nanoradians/metre  d(heading)/ds, so 1e9 / radius. POSITIVE FOR A LEFT
 *                                    (counter-clockwise) turn, negative for a right turn.
 *                                    A 600 m radius left curve is +1666667.
 *   6  crossfall  millionths         dh/dd across the pavement (rise per metre of lateral
 *                                    offset, d positive to the left). POSITIVE MEANS THE
 *                                    LEFT EDGE IS HIGHER: a 2% fall towards the right
 *                                    shoulder is +20000; banking into a left curve is negative.
 *
 * Integers are the true value times the unit factor, rounded half away from zero
 * (Python: int(math.copysign(math.floor(abs(v) + 0.5), v))). Ranges: s, x, y, h within
 * +-2147 km; that covers any city region.
 * Why these units: millimetres keep 70 km of road exact to 0.5 mm; one microradian of heading
 * is 70 mm of drift over 70 km even if integrated, and the runtime never integrates it (it
 * interpolates between stored positions); curvature down to 1e-9/m (radius 1000 km) is
 * distinguished from straight; crossfall to 1e-4 % is far below what LiDAR can fit.
 *
 * Station spacing is UNIFORM per road. Station i of a road has s = i * spacing exactly
 * (in millimetres: s_mm == i * spacing_mm, spacing_mm = round(spacing * 1000)). The first
 * station is at s = 0 and the road's length is (count - 1) * spacing, so a writer resamples
 * the line to the spacing and ends the road on the last whole station. The decoder rejects a
 * file that breaks this. The intended spacing is 4 m; level of detail takes every 1st, 4th
 * and 16th station, so a road meshes best when (count - 1) is a multiple of 16 (not required).
 * Positions are where the reference line actually is: consecutive stations must be about
 * `spacing` apart in plan (|chord - spacing| < 0.5% of spacing is checked), and heading must
 * be the tangent there. The runtime joins stations with cubic Hermite curves through x, y and
 * heading, so position and tangent are continuous.
 *
 * Roads are stored one after another. A road's records are stations.offset .. offset+count-1,
 * counted in RECORDS (multiply by 28 for bytes). The reference writer packs roads in the order
 * of `roads[]` with no gaps, but readers only rely on offset and count; ranges must lie inside
 * the file and must not overlap.
 *
 * ---------------------------------------------------------------- roadnet.json
 * {
 *   "version": 1,                         required, must be 1
 *   "source": { ... },                    optional, free-form provenance (default {})
 *   "roads": [ road, ... ]                required, at least one
 * }
 * road = {
 *   "id": "i15n.main",                    required, unique string
 *   "ref": "I 15",                        optional (default "")
 *   "dir": "north",                       optional (default "")
 *   "class": "motorway",                  optional (default "motorway")
 *   "stations": { "offset": 0,            required, first record of this road in roadnet.bin
 *                 "count": 17101,         required, >= 2
 *                 "spacing": 4 },         optional, metres between stations (default 4)
 *   "sections": [ section, ... ],         required; contiguous, in order, the first s0 = 0 and
 *                                         the last s1 = length; each s1 > s0. Metres.
 *   "speed":   [{ "s0": 0, "mph": 70 }],  optional (default []); each entry runs to the next s0
 *   "surface": [{ "s0": 0, "kind": "asphalt" }],  optional (default [{ s0: 0, kind: "asphalt" }])
 *   "bridges": [{ "s0": 30120, "s1": 30210, "kind": "viaduct" }],  optional (default [])
 *   "links":   [{ "s": 41020, "side": "right", "kind": "exit", "ref": "25", "to": "i15n.x25.off" }]
 *                                         optional (default []); passed through untouched
 * }
 * section = {
 *   "s0": 0, "s1": 12850,                 required, metres
 *   "lanes": [ lane, ... ],               required, at least one, LEFT TO RIGHT facing travel
 *   "left":  { "shoulder": 3.05, "edge": "yellow", "barrier": "none" },   optional
 *   "right": { "shoulder": 3.05, "edge": "white", "rumble": true },       optional
 *   "placement": "centre",                optional (default "centre"), where the reference line
 *                                         sits: "centre" = middle of the lanes (shoulders not
 *                                         counted); "left_of:N", "middle_of:N", "right_of:N" =
 *                                         left edge, middle or right edge of lane N, counted
 *                                         from 1 at the left (OSM's placement=* values)
 *   "provenance": { ... }                 optional, free-form (default {})
 * }
 * lane = {
 *   "w": 3.66,                            optional, metres (default 3.66)
 *   "kind": "drive",                      optional (default "drive"); free string
 *   "line": "broken"                      optional, the line on this lane's RIGHT edge when
 *                                         another lane follows: "broken" (default), "solid",
 *                                         "none". Ignored on the rightmost lane.
 * }
 * left / right = {
 *   "shoulder": metres                    optional; default right 3.05 m (10 ft); left 1.22 m
 *                                         (4 ft), or 3.05 m with three or more lanes
 *   "edge": "yellow" | "white" | "none"   optional; default "yellow" on the left, "white" on
 *                                         the right
 *   "barrier", "rumble", ...              optional, passed through
 * }
 * Unknown fields anywhere are kept by the decoder and written back by the encoder.
 */

export const RECORD_INTS = 7;
export const RECORD_BYTES = RECORD_INTS * 4;
export const DEFAULT_SPACING = 4;
export const LANE_WIDTH = 3.66;
export const SHOULDER_WIDE = 3.05;
export const SHOULDER_NARROW = 1.22;

const SCALE = [1e3, 1e3, 1e3, 1e3, 1e6, 1e9, 1e6]; // integer units per SI unit, per field

/** A malformed RoadNet. */
export class RoadNetError extends Error {
  constructor(message) {
    super(`roadnet: ${message}`);
    this.name = 'RoadNetError';
  }
}

const fail = (msg) => { throw new RoadNetError(msg); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Round half away from zero, as the spec asks (Math.round alone rounds -2.5 to -2). */
const roundAway = (v) => Math.sign(v) * Math.floor(Math.abs(v) + 0.5);
const wrapAngle = (a) => {
  const t = 2 * Math.PI;
  a = ((a + Math.PI) % t + t) % t - Math.PI;
  return a === -Math.PI ? Math.PI : a;
};

/** Fill in a section's defaults and check it. */
function normaliseSection(sec, road, i) {
  const where = `road ${road} section ${i}`;
  if (!sec || typeof sec !== 'object') fail(`${where} is not an object`);
  if (!isNum(sec.s0) || !isNum(sec.s1) || !(sec.s1 > sec.s0)) fail(`${where} needs s0 < s1`);
  if (!Array.isArray(sec.lanes) || !sec.lanes.length) fail(`${where} has no lanes`);
  const lanes = sec.lanes.map((l, j) => {
    const lane = { ...l, w: l?.w ?? LANE_WIDTH, kind: l?.kind ?? 'drive', line: l?.line ?? 'broken' };
    if (!isNum(lane.w) || lane.w <= 0) fail(`${where} lane ${j} width must be positive`);
    if (!['broken', 'solid', 'none'].includes(lane.line)) fail(`${where} lane ${j} line must be broken, solid or none`);
    return lane;
  });
  const side = (v, isLeft) => {
    const out = { ...(v || {}) };
    out.shoulder ??= isLeft ? (lanes.length >= 3 ? SHOULDER_WIDE : SHOULDER_NARROW) : SHOULDER_WIDE;
    out.edge ??= isLeft ? 'yellow' : 'white';
    if (!isNum(out.shoulder) || out.shoulder < 0) fail(`${where} shoulder must be a width >= 0`);
    if (!['yellow', 'white', 'none'].includes(out.edge)) fail(`${where} edge must be yellow, white or none`);
    return out;
  };
  const placement = sec.placement ?? 'centre';
  const m = /^(left_of|middle_of|right_of):(\d+)$/.exec(placement);
  if (placement !== 'centre' && !(m && +m[2] >= 1 && +m[2] <= lanes.length)) fail(`${where} placement "${placement}" is not understood`);
  return { ...sec, lanes, left: side(sec.left, true), right: side(sec.right, false), placement, provenance: sec.provenance ?? {} };
}

/**
 * Read a RoadNet. `json` is the parsed roadnet.json (or its text); `arrayBuffer` holds roadnet.bin.
 * Returns { version, source, roads[] } where each road carries its JSON fields with defaults filled
 * in, plus `spacing`, `count`, `length` and Float64Arrays x, y, h (m), heading (rad),
 * curvature (1/m) and crossfall (rise/run). Station i is at s = i * spacing.
 * Throws RoadNetError when the files break the specification.
 */
export function decodeRoadNet(json, arrayBuffer) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json;
  if (!doc || typeof doc !== 'object') fail('json is not an object');
  if (doc.version !== 1) fail(`version ${doc.version} is not supported (expected 1)`);
  if (!Array.isArray(doc.roads) || !doc.roads.length) fail('no roads');
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer?.buffer;
  if (!(buf instanceof ArrayBuffer)) fail('bin is not an ArrayBuffer');
  const view = arrayBuffer instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf, arrayBuffer.byteOffset, arrayBuffer.byteLength);
  if (view.byteLength % RECORD_BYTES) fail(`bin length ${view.byteLength} is not a multiple of ${RECORD_BYTES}`);
  const records = view.byteLength / RECORD_BYTES;
  const ids = new Set();
  const used = [];

  const roads = doc.roads.map((r, ri) => {
    if (!r || typeof r.id !== 'string' || !r.id) fail(`road ${ri} has no id`);
    if (ids.has(r.id)) fail(`road id "${r.id}" is repeated`);
    ids.add(r.id);
    const st = r.stations || {};
    const { offset, count } = st;
    const spacing = st.spacing ?? DEFAULT_SPACING;
    if (!Number.isInteger(offset) || offset < 0) fail(`road ${r.id} stations.offset must be an integer >= 0`);
    if (!Number.isInteger(count) || count < 2) fail(`road ${r.id} stations.count must be an integer >= 2`);
    if (!isNum(spacing) || spacing <= 0) fail(`road ${r.id} stations.spacing must be positive`);
    if (offset + count > records) fail(`road ${r.id} stations ${offset}..${offset + count - 1} run past the end of the bin (${records} records)`);
    for (const [a, b, other] of used) if (offset < b && a < offset + count) fail(`road ${r.id} stations overlap road ${other}`);
    used.push([offset, offset + count, r.id]);

    const spacingMm = roundAway(spacing * 1000);
    const f = Array.from({ length: RECORD_INTS }, () => new Float64Array(count));
    for (let i = 0; i < count; i++) {
      const base = (offset + i) * RECORD_BYTES;
      const sMm = view.getInt32(base, true);
      if (sMm !== i * spacingMm) fail(`road ${r.id} station ${i} has s = ${sMm} mm, expected ${i * spacingMm} (uniform ${spacing} m spacing from 0)`);
      for (let k = 0; k < RECORD_INTS; k++) f[k][i] = view.getInt32(base + 4 * k, true) / SCALE[k];
    }
    const [, x, y, h, heading, curvature, crossfall] = f;
    for (let i = 1; i < count; i++) {
      const chord = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
      if (Math.abs(chord - spacing) > 0.005 * spacing + 0.002) fail(`road ${r.id} stations ${i - 1} and ${i} are ${chord.toFixed(3)} m apart in plan, not ${spacing} m`);
    }
    for (let i = 0; i < count; i++) if (Math.abs(heading[i]) > Math.PI + 1e-6) fail(`road ${r.id} station ${i} heading is outside (-pi, pi]`);

    const length = (count - 1) * spacing;
    if (!Array.isArray(r.sections) || !r.sections.length) fail(`road ${r.id} has no sections`);
    const sections = r.sections.map((sec, i) => normaliseSection(sec, r.id, i));
    if (Math.abs(sections[0].s0) > 1e-6) fail(`road ${r.id} first section must start at 0`);
    for (let i = 1; i < sections.length; i++) {
      if (Math.abs(sections[i].s0 - sections[i - 1].s1) > 1e-6) fail(`road ${r.id} sections ${i - 1} and ${i} do not meet`);
    }
    if (Math.abs(sections[sections.length - 1].s1 - length) > 1e-3) fail(`road ${r.id} sections end at ${sections[sections.length - 1].s1}, the road at ${length}`);

    return {
      ...r,
      ref: r.ref ?? '', dir: r.dir ?? '', class: r.class ?? 'motorway',
      stations: { ...st, offset, count, spacing },
      sections,
      speed: r.speed ?? [], surface: r.surface ?? [{ s0: 0, kind: 'asphalt' }], bridges: r.bridges ?? [], links: r.links ?? [],
      spacing, count, length, x, y, h, heading, curvature, crossfall,
    };
  });
  return { ...doc, source: doc.source ?? {}, roads };
}

const RUNTIME_KEYS = new Set(['spacing', 'count', 'length', 'x', 'y', 'h', 'heading', 'curvature', 'crossfall', 's']);

/**
 * Write a RoadNet. Takes the decoded shape: { version?, source?, roads[] } where each road has its
 * JSON fields plus `x, y, h, heading, curvature, crossfall` (arrays or typed arrays, SI units,
 * one entry per station) and optional `spacing` (default 4). Roads are packed in order.
 * Returns { json, bin }: the roadnet.json document as an object, and roadnet.bin as an ArrayBuffer.
 */
export function encodeRoadNet(roadnet) {
  const roads = roadnet?.roads;
  if (!Array.isArray(roads) || !roads.length) fail('no roads to encode');
  const total = roads.reduce((n, r) => n + (r.x?.length ?? 0), 0);
  const bin = new ArrayBuffer(total * RECORD_BYTES);
  const view = new DataView(bin);
  let offset = 0;
  const outRoads = roads.map((r) => {
    const count = r.x?.length ?? 0;
    if (count < 2) fail(`road ${r.id} needs at least two stations`);
    const spacing = r.spacing ?? r.stations?.spacing ?? DEFAULT_SPACING;
    const spacingMm = roundAway(spacing * 1000);
    const fields = [null, r.x, r.y, r.h, r.heading, r.curvature, r.crossfall];
    for (let k = 1; k < RECORD_INTS; k++) if (!fields[k] || fields[k].length !== count) fail(`road ${r.id} field ${k} has the wrong length`);
    for (let i = 0; i < count; i++) {
      const base = (offset + i) * RECORD_BYTES;
      view.setInt32(base, i * spacingMm, true);
      for (let k = 1; k < RECORD_INTS; k++) {
        const v = k === 4 ? wrapAngle(fields[k][i]) : fields[k][i];
        if (!isNum(v)) fail(`road ${r.id} station ${i} field ${k} is not a finite number`);
        view.setInt32(base + 4 * k, roundAway(v * SCALE[k]), true);
      }
    }
    const json = {};
    for (const [key, v] of Object.entries(r)) if (!RUNTIME_KEYS.has(key)) json[key] = v;
    json.stations = { ...(r.stations || {}), offset, count, spacing };
    offset += count;
    return json;
  });
  return { json: { ...roadnet, version: 1, source: roadnet.source ?? {}, roads: outRoads }, bin };
}

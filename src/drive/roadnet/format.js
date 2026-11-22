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
 *   "provenance": { ... },                optional, free-form (default {})
 *   "taper": taper                        optional, never on the first section; see below
 * }
 * lane = {
 *   "w": 3.66,                            optional, metres (default 3.66)
 *   "kind": "drive",                      optional (default "drive"); free string
 *   "line": "broken",                     optional, the line on this lane's RIGHT edge when
 *                                         another lane follows: "broken" (default), "solid",
 *                                         "none". Ignored on the rightmost lane.
 *   "id": 2                               optional integer >= 1, the lane's identity along the
 *                                         road (see "lanes and tapers"). Default: its position
 *                                         in the section, 1 at the left.
 * }
 * left / right = {
 *   "shoulder": metres                    optional; default right 3.05 m (10 ft); left 1.22 m
 *                                         (4 ft), or 3.05 m with three or more lanes
 *   "edge": "yellow" | "white" | "none"   optional; default "yellow" on the left, "white" on
 *                                         the right
 *   "barrier", "rumble", ...              optional, passed through
 * }
 * Unknown fields anywhere are kept by the decoder and written back by the encoder.
 *
 * ---------------------------------------------------------------- lanes and tapers
 * Lane identity. A lane's `id` names one strip of pavement along the whole road: a lane of one
 * section and a lane of the next with the same id are the same lane, so "the lane with id 2"
 * keeps meaning the same pavement when an auxiliary lane appears beside it. Either every lane
 * of a road has an id or none does (then ids are positions, 1 at the left, which makes every
 * change of lane count an addition or a drop on the right). Within a section ids are unique;
 * lanes shared by two consecutive sections keep their left-to-right order. A lane whose id
 * is not in the previous section begins at this section; one not in the next section ends
 * with this section. The writer numbers the first section's lanes 1..n from the left and gives
 * every new lane the next unused id, but readers rely only on the rules above.
 *
 * taper = {
 *   "s0": 41180.2, "s1": 41418.0,         required, metres, s0 < s1
 *   ...                                   anything else is provenance, passed through (the
 *                                         reference writer adds "side", "evidence", "W", "L"
 *                                         and, where it had to, "shortened" or "moved")
 * }
 * Without a taper the cross-section changes abruptly at the section's s0 (version 1 as first
 * written; a file with no tapers reads exactly as before). With one, the change into this
 * section's cross-section is spread over [taper.s0, taper.s1], which must contain this section's
 * s0 and end by its s1. It blends FROM the section that contains taper.s0 (normally the previous
 * one). A taper may start further back, so that one or more short sections lie wholly inside it:
 * their own cross-sections are skipped (they are shorter than any taper between their
 * neighbours could be) and they carry no taper of their own. Tapers never overlap (they may
 * touch). Outside every taper a section's cross-section is exactly its own, so a taper may run
 * into the section before or after its boundary: lane counts still change at each s0, geometry
 * follows the taper. A point is inside a taper when taper.s0 <= s < taper.s1; the cross-section
 * "just before" s (as at the far end of a mesh span) uses taper.s0 < s <= taper.s1 instead.
 *
 * Inside a taper, with t = (s - taper.s0) / (taper.s1 - taper.s0) and the blend
 * u = t^3 (10 - 15 t + 6 t^2) (smootherstep: u, du/ds and d2u/ds2 run continuously into the
 * constant cross-sections either side):
 *   - "Previous" below is the section the taper blends from.
 *   - The lanes are the union of both sections' lanes by id. Order: walk both lists from the
 *     left; a lane only in the previous section comes next, else a lane only in this section,
 *     else the shared lane (the same in both).
 *   - Each lane's width is (1 - u) w_prev + u w_this, where a lane missing from a section has
 *     width 0 there. A dropped lane narrows to nothing; an added lane opens from nothing.
 *   - The left edge of the lanes (lane 1's left edge) is at (1 - u) o_prev + u o_this, where o is
 *     that section's own left-edge offset from its placement; lanes follow it to the right.
 *   - Shoulder widths blend the same way: (1 - u) prev + u this.
 *   - Edge kinds and other section-level attributes are the previous section's before the
 *     taper's middle, s < (taper.s0 + taper.s1) / 2, and this section's from it (compare s with
 *     the middle itself, not t with 0.5, so that every reader switches at the same row). Edge lines run along the pavement edge (the outer edge
 *     of the outermost lane, whatever its width).
 *   - A lane line keeps its lane's `line` (from this section if the lane is in it, else from the
 *     previous one) but is not drawn ("none") while either lane beside it is narrower than half
 *     its full width: before the middle next to a lane only in this section, from the middle on
 *     next to a lane only in the previous one. All kind changes in a taper happen at its middle.
 * Writers choose taper lengths so that no lane edge moves sideways faster than 1 m per 20 m;
 * the smootherstep's steepest slope is 1.875 times the average, so a taper of length L with a
 * largest edge movement W keeps to that when L >= 37.5 W.
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
    const lane = { ...l, w: l?.w ?? LANE_WIDTH, kind: l?.kind ?? 'drive', line: l?.line ?? 'broken', id: l?.id ?? j + 1 };
    if (!isNum(lane.w) || lane.w <= 0) fail(`${where} lane ${j} width must be positive`);
    if (!['broken', 'solid', 'none'].includes(lane.line)) fail(`${where} lane ${j} line must be broken, solid or none`);
    if (!Number.isInteger(lane.id) || lane.id < 1) fail(`${where} lane ${j} id must be an integer >= 1`);
    return lane;
  });
  if (new Set(lanes.map((l) => l.id)).size !== lanes.length) fail(`${where} repeats a lane id`);
  if (sec.taper !== undefined) {
    const tp = sec.taper;
    if (i === 0) fail(`${where} is the first section and cannot have a taper`);
    if (!tp || !isNum(tp.s0) || !isNum(tp.s1) || !(tp.s1 > tp.s0)) fail(`${where} taper needs s0 < s1`);
    if (tp.s0 > sec.s0 + 1e-6 || tp.s1 < sec.s0 - 1e-6) fail(`${where} taper ${tp.s0}..${tp.s1} does not contain the section start ${sec.s0}`);
    if (tp.s1 > sec.s1 + 1e-6) fail(`${where} taper runs past the section end`);
  }
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

/** Ids on every lane or none; shared lanes keep their order; tapers stay in place and apart. */
function checkLanesAndTapers(id, raw, sections) {
  const tagged = raw.map((sec) => sec.lanes.map((l) => l?.id !== undefined));
  const all = tagged.flat();
  if (all.some(Boolean) && !all.every(Boolean)) fail(`road ${id} gives ids to some lanes but not all`);
  let lastEnd = -Infinity;
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1].lanes.map((l) => l.id), b = sections[i].lanes.map((l) => l.id);
    const inB = new Set(b), inA = new Set(a);
    const sa = a.filter((x) => inB.has(x)), sb = b.filter((x) => inA.has(x));
    if (sa.some((x, k) => x !== sb[k])) fail(`road ${id} sections ${i - 1} and ${i} swap the order of shared lanes`);
    const tp = sections[i].taper;
    if (!tp) continue;
    if (tp.s0 < lastEnd - 1e-6) fail(`road ${id} section ${i} taper overlaps the one before it`);
    lastEnd = tp.s1;
    let k = i - 1;
    while (k > 0 && sections[k].s0 > tp.s0) k--;
    for (let j = k + 1; j < i; j++) if (sections[j].taper) fail(`road ${id} section ${j} lies inside the taper of section ${i} and has its own`);
    if (k < i - 1) {
      const a = sections[k].lanes.map((l) => l.id), b = sections[i].lanes.map((l) => l.id);
      const inB = new Set(b), inA = new Set(a);
      const sa = a.filter((x) => inB.has(x)), sb = b.filter((x) => inA.has(x));
      if (sa.some((x, q) => x !== sb[q])) fail(`road ${id} the taper of section ${i} swaps the order of shared lanes`);
    }
  }
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
    checkLanesAndTapers(r.id, r.sections, sections);

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

/**
 * Traffic v1: counted traffic along one route, written by scripts/build_traffic.py (D6.1) and read
 * by the drive's demand surface (src/drive/traffic/demand.js, D6.2). This comment is the
 * specification; parseTraffic below checks it and syntheticTraffic writes files of the same shape
 * for tests and for running without data.
 *
 * File: public/data/<city>/traffic/<route>.json
 * {
 *   "version": 1,                         required, must be 1
 *   "route": "i15n",                      required, the routes.json id
 *   "year": 2025,                         required, the year the counts describe
 *   "tz": "America/Los_Angeles",          required, an IANA zone; hours below are local in it
 *   "hourOfWeek": "...",                  optional, documentation only: index = 24 * day + hour,
 *                                         day 0 = Monday, hour = the local hour that starts then
 *   "seasons": ["winter", "spring", "summer", "autumn"],      required, 4 names
 *   "seasonOfMonth": [0,0,1,1,1,2,2,2,3,3,3,0],              required, 12 indices into seasons,
 *                                         by LOCAL month (January first)
 *   "directions": {                       required, both:
 *     "with":    { "road": "i15n.main", "segments": [segment, ...] },  the way the car drives
 *     "against": { "road": "i15s.opp",  "segments": [segment, ...] }   oncoming traffic
 *   },
 *   "sources": [ ... ]                    optional, free-form provenance (default [])
 * }
 * segment = {
 *   "s0", "s1":            metres of chainage along the ROUTE (routes.json s, the car's road),
 *                          for both directions; s1 > s0. Within a direction the segments are in
 *                          increasing s and tile one range [S0, S1] without gaps or overlaps
 *                          (|s1 - next s0| < 0.01 m); both directions tile the same range.
 *                          Oncoming traffic travels from S1 towards S0.
 *   "lanes":               integer 1..8, through lanes of that direction on the segment
 *   "freeFlowMps":         free-flow speed of the RIGHTMOST lane, m/s (> 0)
 *   "capacityVph":         capacity of the whole carriageway, vehicles per hour (> 0)
 *   "laneSpeedOffsetsMps": [lanes numbers], added to freeFlowMps per lane, LEFT TO RIGHT as seen by
 *                          a driver of that direction (normally +2.7, +1.3, 0 for three lanes)
 *   "laneShares":          [lanes numbers >= 0], share of the flow per lane, left to right; sums to
 *                          1 (within 0.01; the reader rescales it to exactly 1)
 *   "truckShare":          0..1, heavy vehicles / all vehicles
 *   "aadt":                annual average daily traffic of that direction (>= 0), informative
 *   "flow":                [4 seasons][168 hours of week] vehicles per hour (>= 0), the mean of
 *                          that hour at the MIDDLE of the segment (the demand reader treats it as
 *                          demand: where it exceeds capacity a queue forms upstream)
 *   "provenance":          optional, free-form (default {})
 * }
 * Unknown fields anywhere are kept.
 *
 * Conventions shared with the rest of the drive: s is metres along the route's road, a lateral
 * offset is positive to the LEFT, lanes are numbered 1.. from the left of their own direction.
 */

import { isTimeZone, HOURS_PER_WEEK } from './flow.js';

export const TRAFFIC_VERSION = 1;
export const DIRECTIONS = ['with', 'against'];
export const SEASONS = ['winter', 'spring', 'summer', 'autumn'];
export const SEASON_OF_MONTH = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0];
export const MAX_LANES = 8;
const MPH = 0.44704;

/** A malformed traffic file. */
export class TrafficError extends Error {
  constructor(message) {
    super(`traffic: ${message}`);
    this.name = 'TrafficError';
  }
}
const fail = (msg) => { throw new TrafficError(msg); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function parseSegment(seg, where) {
  if (!seg || typeof seg !== 'object') fail(`${where} is not an object`);
  for (const k of ['s0', 's1', 'freeFlowMps', 'capacityVph', 'truckShare', 'aadt']) if (!isNum(seg[k])) fail(`${where}.${k} is not a number`);
  if (!(seg.s1 > seg.s0)) fail(`${where} needs s0 < s1`);
  if (!Number.isInteger(seg.lanes) || seg.lanes < 1 || seg.lanes > MAX_LANES) fail(`${where}.lanes must be an integer 1..${MAX_LANES}`);
  if (!(seg.freeFlowMps > 0)) fail(`${where}.freeFlowMps must be > 0`);
  if (!(seg.capacityVph > 0)) fail(`${where}.capacityVph must be > 0`);
  if (seg.truckShare < 0 || seg.truckShare > 1) fail(`${where}.truckShare must be in 0..1`);
  if (seg.aadt < 0) fail(`${where}.aadt must be >= 0`);
  const perLane = (k) => {
    const a = seg[k];
    if (!Array.isArray(a) || a.length !== seg.lanes || !a.every(isNum)) fail(`${where}.${k} needs ${seg.lanes} numbers (one per lane)`);
    return a;
  };
  const offsets = perLane('laneSpeedOffsetsMps');
  const shares = perLane('laneShares');
  if (shares.some((x) => x < 0)) fail(`${where}.laneShares must be >= 0`);
  const sum = shares.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) fail(`${where}.laneShares sum to ${sum}, not 1`);
  offsets.forEach((o, i) => { if (seg.freeFlowMps + o <= 0) fail(`${where}: lane ${i + 1} has no positive free-flow speed`); });
  if (!Array.isArray(seg.flow) || seg.flow.length !== 4) fail(`${where}.flow needs 4 seasons`);
  seg.flow.forEach((row, s) => {
    if (!Array.isArray(row) || row.length !== HOURS_PER_WEEK) fail(`${where}.flow[${s}] needs ${HOURS_PER_WEEK} hours`);
    row.forEach((v, h) => { if (!isNum(v) || v < 0) fail(`${where}.flow[${s}][${h}] is not a flow >= 0`); });
  });
  return {
    ...seg,
    laneSpeedOffsetsMps: offsets.slice(),
    laneShares: shares.map((x) => x / sum),
    flow: seg.flow.map((row) => row.slice()),
    provenance: seg.provenance ?? {},
  };
}

/**
 * Check a traffic file and return a normalised copy (lane shares rescaled to sum to 1, defaults
 * filled). Throws TrafficError naming the first problem.
 * @param {object|string} json
 */
export function parseTraffic(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  if (!d || typeof d !== 'object') fail('not an object');
  if (d.version !== TRAFFIC_VERSION) fail(`version must be ${TRAFFIC_VERSION}, is ${d.version}`);
  if (typeof d.route !== 'string' || !d.route) fail('route must be a string');
  if (!Number.isInteger(d.year)) fail('year must be an integer');
  if (!isTimeZone(d.tz)) fail(`tz ${d.tz} is not a time zone`);
  if (!Array.isArray(d.seasons) || d.seasons.length !== 4) fail('seasons needs 4 names');
  if (!Array.isArray(d.seasonOfMonth) || d.seasonOfMonth.length !== 12 || !d.seasonOfMonth.every((x) => Number.isInteger(x) && x >= 0 && x < 4)) {
    fail('seasonOfMonth needs 12 season indices 0..3');
  }
  if (!d.directions || typeof d.directions !== 'object') fail('directions missing');
  const directions = {};
  let range = null;
  for (const dir of DIRECTIONS) {
    const D = d.directions[dir];
    if (!D || typeof D !== 'object') fail(`directions.${dir} missing`);
    if (typeof D.road !== 'string' || !D.road) fail(`directions.${dir}.road must be a string`);
    if (!Array.isArray(D.segments) || !D.segments.length) fail(`directions.${dir}.segments must be a non-empty array`);
    const segments = D.segments.map((s, i) => parseSegment(s, `directions.${dir}.segments[${i}]`));
    for (let i = 1; i < segments.length; i++) {
      if (Math.abs(segments[i].s0 - segments[i - 1].s1) >= 0.01) fail(`directions.${dir}.segments[${i}] does not start where segment ${i - 1} ends (${segments[i - 1].s1} vs ${segments[i].s0})`);
      segments[i].s0 = segments[i - 1].s1;
    }
    const r = [segments[0].s0, segments[segments.length - 1].s1];
    if (range && (Math.abs(range[0] - r[0]) >= 0.01 || Math.abs(range[1] - r[1]) >= 0.01)) fail(`directions.${dir} covers ${r[0]}..${r[1]}, not ${range[0]}..${range[1]}`);
    range = range || r;
    directions[dir] = { ...D, segments };
  }
  return { ...d, sources: d.sources ?? [], directions, range };
}

// ------------------------------------------------------------------------------- synthetic data

/** Share of a day's traffic in each hour: a generic freeway day with a morning and evening peak. */
const DAY_SHAPE = (() => {
  const raw = [];
  for (let h = 0; h < 24; h++) {
    const g = (c, w) => Math.exp(-0.5 * ((h + 0.5 - c) / w) ** 2);
    raw.push(0.12 + 0.9 * g(7.8, 1.6) + 1.0 * g(16.5, 2.4) + 0.55 * g(12.5, 3.5));
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / sum);
})();
/** Day multipliers, Monday first: the shape the plan's counts show (Friday out, Sunday back). */
const DAY_WITH = [0.92, 0.81, 0.86, 0.95, 1.36, 1.05, 1.05];
const DAY_AGAINST = [0.95, 0.81, 0.84, 0.9, 1.05, 1.04, 1.41];

/** Hour-of-week flow table (168) for a daily volume and day multipliers. */
export function weeklyShape(daily, dayFactors = DAY_WITH) {
  const mean = dayFactors.reduce((a, b) => a + b, 0) / 7;
  const out = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) out.push(daily * (dayFactors[d] / mean) * DAY_SHAPE[h]);
  return out;
}

function laneDefaults(lanes) {
  // left lanes a little faster and busier per lane in the middle (plan section 7.10)
  const laneSpeedOffsetsMps = [];
  const raw = [];
  for (let i = 0; i < lanes; i++) {
    const fromRight = lanes - 1 - i;
    laneSpeedOffsetsMps.push(Math.min(fromRight, 2) * 3 * MPH);
    raw.push(lanes === 1 ? 1 : i === lanes - 1 ? 0.8 : 1);
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  return { laneSpeedOffsetsMps, laneShares: raw.map((x) => x / sum) };
}

/**
 * A traffic file (already in the v1 shape, run it through parseTraffic) for tests and for driving
 * without data.
 * @param {object} [o]
 * @param {number} [o.length=20000]            route length, metres (s from 0)
 * @param {object[]} [o.segments]              the "with" segments; partial objects are completed.
 *                                             Default: one per o.segmentLength metres.
 * @param {object[]} [o.against]               the "against" segments (default: mirror of with)
 * @param {number} [o.segmentLength=5000]
 * @param {number} [o.aadt=23000]              daily volume per direction
 * @param {number|Function} [o.flow]           constant vph, or (how, season, i, dir, seg) => vph;
 *                                             default: the weekly shape of o.aadt (with summer +8%)
 */
export function syntheticTraffic(o = {}) {
  const length = o.length ?? 20000;
  const segLen = o.segmentLength ?? 5000;
  const lanes = o.lanes ?? 3;
  const base = (s0, s1, extra = {}) => {
    const n = extra.lanes ?? lanes;
    return {
      s0, s1, lanes: n,
      freeFlowMps: o.freeFlowMps ?? 70 * MPH,
      capacityVph: o.capacityVph ?? 2300 * n,
      ...laneDefaults(n),
      truckShare: o.truckShare ?? 0.15,
      aadt: o.aadt ?? 23000,
      provenance: { synthetic: true },
      ...extra,
    };
  };
  let withSegs;
  if (o.segments) withSegs = o.segments.map((s) => base(s.s0, s.s1, s));
  else {
    withSegs = [];
    for (let s = 0; s < length; s += segLen) withSegs.push(base(s, Math.min(length, s + segLen)));
  }
  const against = o.against
    ? o.against.map((s) => base(s.s0, s.s1, s))
    : withSegs.map((s) => ({ ...s, provenance: { synthetic: true, mirror: true } }));
  const fill = (segs, dir) => segs.map((seg, i) => {
    if (Array.isArray(seg.flow)) return seg;
    const flow = [];
    for (let season = 0; season < 4; season++) {
      const row = [];
      const shape = typeof o.flow === 'function' || typeof o.flow === 'number' ? null : weeklyShape(seg.aadt, dir === 'with' ? DAY_WITH : DAY_AGAINST);
      for (let h = 0; h < HOURS_PER_WEEK; h++) {
        if (typeof o.flow === 'function') row.push(o.flow(h, season, i, dir, seg));
        else if (typeof o.flow === 'number') row.push(o.flow);
        else row.push(shape[h] * (season === 2 ? 1.08 : season === 0 ? 0.92 : 1));
      }
      flow.push(row);
    }
    return { ...seg, flow };
  });
  return {
    version: TRAFFIC_VERSION,
    route: o.route ?? 'synthetic',
    year: o.year ?? 2025,
    tz: o.tz ?? 'America/Los_Angeles',
    hourOfWeek: 'index = 24 * day + hour, day 0 = Monday, local time, hour = the hour that starts then',
    seasons: SEASONS.slice(),
    seasonOfMonth: SEASON_OF_MONTH.slice(),
    directions: {
      with: { road: o.road ?? 'synthetic.main', segments: fill(withSegs, 'with') },
      against: { road: o.oppRoad ?? 'synthetic.opp', segments: fill(against, 'against') },
    },
    sources: [{ synthetic: true }],
  };
}

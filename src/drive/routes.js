// Loads the drive's routes and the road network they run on. Fetching is injected so the app
// can use fetch() and tests can read from disk.

import { decodeRoadNet } from './roadnet/format.js';

/** A malformed routes.json, or one that does not fit its roadnet. */
export class RoutesError extends Error {
  constructor(message) {
    super(`routes: ${message}`);
    this.name = 'RoutesError';
  }
}

const fail = (msg) => { throw new RoutesError(msg); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const TOL = 1e-3;

/** Check one route against the roads and fill in its defaults. Unknown fields are kept. */
function normaliseRoute(r, i, roads) {
  if (!r || typeof r.id !== 'string' || !r.id) fail(`route ${i} has no id`);
  const where = `route "${r.id}"`;
  const road = roads.get(r.road);
  if (!road) fail(`${where} names road "${r.road}", which is not in roadnet.json (roads: ${[...roads.keys()].join(', ')})`);
  if (!isNum(r.s0) || !isNum(r.s1) || !(r.s1 > r.s0)) fail(`${where} needs s0 < s1`);
  if (r.s0 < -TOL || r.s1 > road.length + TOL) {
    fail(`${where} runs over s ${r.s0}..${r.s1}, outside road "${road.id}" (0..${road.length})`);
  }
  const inside = (s, what) => {
    if (!isNum(s)) fail(`${where} ${what} has no s`);
    if (s < r.s0 - TOL || s > r.s1 + TOL) fail(`${where} ${what} at s ${s} lies outside the route (${r.s0}..${r.s1})`);
  };
  const lane = r.lane ?? 1;
  if (!Number.isInteger(lane) || lane < 1) fail(`${where} lane must be an integer >= 1`);
  if (r.reveal) inside(r.reveal.s, 'reveal');
  const starts = r.starts ?? {};
  for (const [k, s] of Object.entries(starts)) inside(s, `start "${k}"`);
  const markers = r.markers ?? [];
  if (!Array.isArray(markers)) fail(`${where} markers must be a list`);
  markers.forEach((m, j) => inside(m?.s, `marker ${j}`));
  return { ...r, lane, starts, markers, label: r.label ?? r.id, length: r.length ?? r.s1 - r.s0 };
}

/**
 * Check a routes.json document against a decoded roadnet.
 * @returns {{ version: number, source: object, routes: object[] }}
 */
export function parseRoutes(doc, roadnet) {
  if (typeof doc === 'string') doc = JSON.parse(doc);
  if (!doc || typeof doc !== 'object') fail('json is not an object');
  if (doc.version !== 1) fail(`version ${doc.version} is not supported (expected 1)`);
  if (!Array.isArray(doc.routes) || !doc.routes.length) fail('no routes');
  const roads = new Map(roadnet.roads.map((r) => [r.id, r]));
  const ids = new Set();
  const routes = doc.routes.map((r, i) => {
    const route = normaliseRoute(r, i, roads);
    if (ids.has(route.id)) fail(`route id "${route.id}" is repeated`);
    ids.add(route.id);
    return route;
  });
  return { ...doc, source: doc.source ?? {}, routes };
}

/**
 * Load routes.json, roadnet.json and roadnet.bin.
 * @param {{ fetchJson: (name: string) => Promise<any>, fetchBinary: (name: string) => Promise<ArrayBuffer> }} io
 *   called with the bare file names; the caller maps them to URLs or paths
 * @returns {Promise<{ routes: object[], roadnet: object, route: (id: string) => object|null, roadOf: (route: object) => object }>}
 */
export async function loadRoutes({ fetchJson, fetchBinary }) {
  const [doc, json, bin] = await Promise.all([fetchJson('routes.json'), fetchJson('roadnet.json'), fetchBinary('roadnet.bin')]);
  const roadnet = decodeRoadNet(json, bin);
  const { routes, source } = parseRoutes(doc, roadnet);
  const byId = new Map(routes.map((r) => [r.id, r]));
  const roads = new Map(roadnet.roads.map((r) => [r.id, r]));
  return {
    routes,
    source,
    roadnet,
    /** The route with this id, or null (an address may name one that does not exist). */
    route: (id) => byId.get(id) ?? null,
    roadOf(route) {
      const road = roads.get(typeof route === 'string' ? byId.get(route)?.road : route?.road);
      if (!road) fail(`no road for route ${typeof route === 'string' ? route : route?.id}`);
      return road;
    },
  };
}

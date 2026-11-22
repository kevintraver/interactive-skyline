// Loads the drive's routes and, for each route, the road network it runs on. Every route names its
// own files in routes.json ("files": { "roadnet", "signs", "traffic" }); a route without them uses
// roadnet.json. A RoadNet is fetched only when a route on it is chosen, and kept once loaded.
// Fetching is injected so the app can use fetch() and tests can read from disk.

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

/** The RoadNet a route runs on, as the file name of its JSON half. */
export const DEFAULT_ROADNET = 'roadnet.json';

/** The files a route names, with the defaults of the first route filled in. */
export function filesOf(route) {
  const f = route?.files ?? {};
  const roadnet = typeof f.roadnet === 'string' && f.roadnet ? f.roadnet : DEFAULT_ROADNET;
  if (!roadnet.endsWith('.json')) fail(`route "${route?.id}" names roadnet "${roadnet}", which is not a .json file`);
  return {
    ...f,
    roadnet,
    bin: `${roadnet.slice(0, -'.json'.length)}.bin`,
    signs: f.signs ?? 'signs.json',
    traffic: f.traffic ?? `traffic/${route?.id}.json`,
  };
}

/**
 * Check one route and fill in its defaults. Unknown fields are kept. With `roads` (the roads of the
 * RoadNet the route runs on) it is checked against its road too; without, only its own shape.
 */
function normaliseRoute(r, i, roads) {
  if (!r || typeof r.id !== 'string' || !r.id) fail(`route ${i} has no id`);
  const where = `route "${r.id}"`;
  if (!isNum(r.s0) || !isNum(r.s1) || !(r.s1 > r.s0)) fail(`${where} needs s0 < s1`);
  if (roads) {
    const road = roads.get(r.road);
    if (!road) fail(`${where} names road "${r.road}", which is not in ${filesOf(r).roadnet} (roads: ${[...roads.keys()].join(', ')})`);
    if (r.s0 < -TOL || r.s1 > road.length + TOL) {
      fail(`${where} runs over s ${r.s0}..${r.s1}, outside road "${road.id}" (0..${road.length})`);
    }
  } else if (typeof r.road !== 'string' || !r.road) fail(`${where} names no road`);
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
 * Check a routes.json document. The routes on `roadnet` (those whose files name `file`, by default
 * roadnet.json) are checked against its roads; the others only for their own shape, until their
 * RoadNet is loaded (checkRoute).
 * @param {object|string} doc  @param {object} [roadnet] a decoded RoadNet  @param {{ file?: string }} [opts]
 * @returns {{ version: number, source: object, routes: object[] }}
 */
export function parseRoutes(doc, roadnet, { file = DEFAULT_ROADNET } = {}) {
  if (typeof doc === 'string') doc = JSON.parse(doc);
  if (!doc || typeof doc !== 'object') fail('json is not an object');
  if (doc.version !== 1) fail(`version ${doc.version} is not supported (expected 1)`);
  if (!Array.isArray(doc.routes) || !doc.routes.length) fail('no routes');
  const roads = roadnet ? new Map(roadnet.roads.map((r) => [r.id, r])) : null;
  const ids = new Set();
  const routes = doc.routes.map((r, i) => {
    const on = roads && filesOf(r).roadnet === file;
    const route = normaliseRoute(r, i, on ? roads : null);
    if (ids.has(route.id)) fail(`route id "${route.id}" is repeated`);
    ids.add(route.id);
    return route;
  });
  return { ...doc, source: doc.source ?? {}, routes };
}

/** Check one (parsed) route against the RoadNet it runs on. Returns the route. */
export function checkRoute(route, roadnet) {
  return normaliseRoute(route, 0, new Map(roadnet.roads.map((r) => [r.id, r])));
}

/**
 * Load routes.json, then the RoadNet of one route (the first, unless `route` names another).
 * @param {{ fetchJson: (name: string) => Promise<any>, fetchBinary: (name: string) => Promise<ArrayBuffer> }} io
 *   called with the bare file names ("routes.json", "roadnet-i15s.json", ...); the caller maps them to URLs or paths
 * @param {{ route?: string }} [opts]
 * @returns {Promise<object>} the routes object:
 *   routes, source                     every route in routes.json (parsed), and its source
 *   roadnet                            the RoadNet loaded last (the chosen route's)
 *   route(id)                          the route, or null
 *   roadOf(route | id)                 its road in its RoadNet; throws if that RoadNet is not loaded yet
 *   roadnetOf(route | id)              its RoadNet, or null if not loaded yet
 *   isLoaded(route | id)               whether its RoadNet is loaded
 *   filesOf(route | id)                { roadnet, bin, signs, traffic }: the file names it uses
 *   loadRoute(id) -> Promise           fetch (once) and check its RoadNet, make it `roadnet`;
 *                                      resolves to { route, roadnet, road }
 */
export async function loadRoutes({ fetchJson, fetchBinary }, { route: first } = {}) {
  const doc = await fetchJson('routes.json');
  const { routes, source } = parseRoutes(doc);
  const byId = new Map(routes.map((r) => [r.id, r]));
  const nets = new Map(); // roadnet file -> Promise<{ roadnet, roads }>
  const ready = new Map(); // roadnet file -> { roadnet, roads }, once loaded

  const routeOf = (r) => {
    const route = typeof r === 'string' ? byId.get(r) : r && byId.get(r.id) === r ? r : byId.get(r?.id);
    if (!route) fail(`no route "${typeof r === 'string' ? r : r?.id}" (routes: ${routes.map((x) => x.id).join(', ')})`);
    return route;
  };

  function fetchNet(file) {
    if (!nets.has(file)) {
      const bin = `${file.slice(0, -'.json'.length)}.bin`;
      const p = Promise.all([fetchJson(file), fetchBinary(bin)]).then(([json, buf]) => {
        const roadnet = decodeRoadNet(json, buf);
        const net = { roadnet, roads: new Map(roadnet.roads.map((x) => [x.id, x])) };
        // every route on this RoadNet is checked against it now
        for (const r of routes) if (filesOf(r).roadnet === file) checkRoute(r, roadnet);
        ready.set(file, net);
        return net;
      });
      p.catch(() => nets.delete(file)); // a failed download may be retried
      nets.set(file, p);
    }
    return nets.get(file);
  }

  const api = {
    routes,
    source,
    roadnet: null,
    /** The route with this id, or null (an address may name one that does not exist). */
    route: (id) => byId.get(id) ?? null,
    filesOf: (r) => filesOf(routeOf(r)),
    isLoaded: (r) => ready.has(filesOf(routeOf(r)).roadnet),
    roadnetOf: (r) => ready.get(filesOf(routeOf(r)).roadnet)?.roadnet ?? null,
    roadOf(r) {
      const route = routeOf(r);
      const net = ready.get(filesOf(route).roadnet);
      if (!net) fail(`the RoadNet of route "${route.id}" (${filesOf(route).roadnet}) is not loaded: call loadRoute("${route.id}") first`);
      const road = net.roads.get(route.road);
      if (!road) fail(`no road for route ${route.id}`);
      return road;
    },
    async loadRoute(id) {
      const route = routeOf(id);
      const net = await fetchNet(filesOf(route).roadnet);
      api.roadnet = net.roadnet;
      return { route, roadnet: net.roadnet, road: net.roads.get(route.road) };
    },
  };
  await api.loadRoute(first ?? routes[0].id);
  return api;
}

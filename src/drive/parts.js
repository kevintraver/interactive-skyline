// The drive's optional features, one line each. An entry's load(ctx) gets the part context below and returns a
// part (see the top of session.js), a promise of one, or nothing when its data is missing. Factories
// run once the session has its road, terrain and clock; one that throws is reported and left out,
// and the drive goes on without it.
//
// Routes. The drive can switch routes (session.js, "Routes"). A part whose work depends on the route (its
// RoadNet, its signs) adds the optional hook setRoute({ route, roadnet, road, files }): called when the route
// changes and once on registering; `route` is routes.json's entry, `roadnet` the decoded RoadNet it runs on,
// `road` its road there, `files` its file names (roadnet, bin, signs, barriers, traffic). Valley-wide parts
// (billboards, the valley's ribbons, screens, obstruction lights) need none.
//
// ctx = {
//   app        the app's own context: city, cityId, DATA, scene, camera, renderer, settings, tall, invalidate,
//              events (the app's bus, src/app/events.js: 'buildings:changed', 'buildings:rebuilt'), ...
//   session    the drive session (journey, pose, clock, rig, env, net as getters; addPart)
//   get(name)  fetch a file of this city's data directory (rejects unless the answer is 2xx)
//   optional(name)  the same as JSON, or null when the file is missing
//   group, roads     the drive's scene group, and the group under it that holds everything on the road
//   terrain, wideMesh, ground    the terrain provider, the wide ground mesh, the ground meshes [[mesh, grid], ...] (the app's
//              and the terrain patches loaded so far)
//   eachGround(fn)  fn(mesh, grid) for every ground mesh now and for each that arrives later (a terrain patch comes with
//              the route that passes it, session.js); returns the unsubscribe. Parts that add terms to the ground's
//              materials use it (through eachGround below), not a loop over `ground`
//   eachSurface(fn)  fn(material, kind) for every surface the drive's light lands on ('road', 'sign', 'support', 'delineator',
//              'building', 'vehicle'), now and as a route switch builds more; returns the unsubscribe. addSurfaces([[m, kind]])
//              offers a part's own (the traffic part's vehicle bodies, 'vehicle'). These are node materials with
//              userData.surfaceLight = kind: the lights parts (lamps, headlights) add retroreflection and surface light to them through
//              src/drive/lights/surfaceLight.js, composing with their emissiveNode
//              (material.emissiveNode = (material.emissiveNode ?? materialEmissive).add(term))
//   net, env, clock, rig, frameOf, earthR, base   (net: routes.js; net.roadnet is the RoadNet loaded last). env is the
//              adapter of src/drive/env.js (env.plan01, env.nodes, env.state; clock is app.clock) and app.plan01 holds plan
//              01's contract (clock, timeline, env, quality, pipeline, loop): a part adds a pipeline stage with
//              app.plan01.pipeline.addStage({ id, at, render?, node? }) and removes it on dispose
//   materials  the road materials, shared by every route
//   chunks, roadside  getters: the current route's road chunk system and signs (null without signs); read them
//              when needed, not once, since a route change replaces them
// }

// `?parts=a,b` (`?parts=none` for none) limits the drive to the named parts, for the probes in tests/manual and for
// tests.

/**
 * The optional parts, one line each: { id, load(ctx) }.
 * @type {Array<{ id: string, load: (ctx: object) => (object | null | undefined | Promise<object | null | undefined>) }>}
 */
export const PARTS = [
  { id: 'lamps', load: (ctx) => import('./lights/index.js').then((m) => m.createLampsPart(ctx)) }, // street lamps: sprites, pools, poles, switching (D5.4, D5.5)
  { id: 'headlights', load: (ctx) => import('./lights/headlights.js').then((m) => m.createHeadlightsPart(ctx)) }, // the visitor's headlamps and what signs and markings return (D5.1, D5.2)
  { id: 'traffic', load: (ctx) => import('./traffic/index.js').then((m) => m.createTrafficPart(ctx)) }, // vehicles on both carriageways, placed by the demand model (D6.4)
  { id: 'cabin', load: (ctx) => import('./vehicle/cabin.js').then((m) => m.createCabin(ctx)) }, // the cabin, its displays, the steering wheel, mirrors, windshield and rain on the glass (D4.2 to D4.6, D8.2)
  { id: 'valley', load: (ctx) => import('./traffic/valley.js').then((m) => m.createValleyPart(ctx)) }, // light ribbons on the rest of the valley's roads (D6.6)
  { id: 'obstruction', load: (ctx) => import('./lights/obstruction.js').then((m) => m.createObstructionPart(ctx)) }, // red obstruction lights on buildings above 61 m, hidden and moved with them (D5.6)
  { id: 'screens', load: (ctx) => import('./screens/index.js').then((m) => m.createScreensPart(ctx)) }, // screens on simulation time, their registry, the Sphere's light (D7.3, D7.5)
  { id: 'billboards', load: (ctx) => import('./roadside/billboards.js').then((m) => m.createBillboardsPart(ctx)) }, // billboards: structures, abstract faces, digital glow (D7.4, D7.5)
  { id: 'weather', load: (ctx) => import('./weather/index.js').then((m) => m.createWeatherPart(ctx)) }, // rain: wet road, reflected lamps, rain, spray (D8.1, D8.3), on plan 01's weather
];

/**
 * The `?parts=` list of an address: null when absent (every part), else the ids named ([] for `none` or an empty value).
 * @param {string | URLSearchParams} search
 * @returns {string[] | null}
 */
export function partsFromSearch(search) {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search || '');
  if (!q.has('parts')) return null;
  const v = q.get('parts').trim();
  if (!v || v === 'none') return [];
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * The entries to load: those `wanted` names (null: all).
 * @param {{ wanted?: string[] | null, registry?: typeof PARTS }} o
 * @returns {typeof PARTS}
 */
export function selectParts({ wanted = null, registry = PARTS }) {
  return registry.filter((p) => wanted === null || wanted.includes(p.id));
}

/**
 * fn(mesh, grid) for every ground mesh of the part context, now and as more arrive (ctx.eachGround); a context without
 * the subscription (a test's) gets its `ground` list once. Returns the unsubscribe.
 * @param {{ eachGround?: (fn: Function) => () => void, ground?: Array<[object, string]> }} ctx
 * @param {(mesh: object, grid: string) => void} fn
 * @returns {() => void}
 */
export function eachGround(ctx, fn) {
  if (typeof ctx?.eachGround === 'function') return ctx.eachGround(fn);
  for (const [mesh, grid] of ctx?.ground || []) fn(mesh, grid);
  return () => {};
}

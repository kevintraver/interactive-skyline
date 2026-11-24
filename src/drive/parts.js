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
//   legacy     true on the classic renderer (pick `x.js`), false on the new one (pick `x.node.js`)
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
//              'building'), now and as a route switch builds more; returns the unsubscribe. On plan 01's renderer these are
//              node materials with userData.surfaceLight = kind: the lights part adds retroreflection and surface light to
//              them through src/drive/lights/surfaceLight.node.js, composing with their emissiveNode
//              (material.emissiveNode = (material.emissiveNode ?? materialEmissive).add(term))
//   net, env, clock, rig, frameOf, earthR, base   (net: routes.js; net.roadnet is the RoadNet loaded last). On plan 01's
//              renderer env is the adapter of src/drive/env.js (env.plan01, env.nodes, env.state; clock is app.clock) and
//              app.plan01 holds plan 01's contract (clock, timeline, env, quality, pipeline, loop): a part adds a pipeline
//              stage with app.plan01.pipeline.addStage({ id, at, render?, node? }) and removes it on dispose
//   materials  the road materials, shared by every route
//   chunks, roadside  getters: the current route's road chunk system and signs (null without signs); read them
//              when needed, not once, since a route change replaces them
// }

// On the new renderer (plan 02, third stretch, decision 1) a part loads only once it has node materials: its entry's
// `node` is true. Until then it runs on the classic renderer only. `?parts=a,b` (either renderer; `?parts=none` for
// none) limits the drive to the named parts, for the parity tool (tests/manual/drive-parity.mjs) and for tests.
//
// ctx.legacy is true on the classic renderer: a part picks its GLSL module `x.js` or its node module `x.node.js` by it
// (decision 2).

/**
 * The optional parts, one line each: { id, node, load(ctx) }. `node: true` once the part runs on the new renderer.
 * @type {Array<{ id: string, node: boolean, load: (ctx: object) => (object | null | undefined | Promise<object | null | undefined>) }>}
 */
export const PARTS = [
  { id: 'lamps', node: false, load: (ctx) => import('./lights/index.js').then((m) => m.createLampsPart(ctx)) }, // street lamps: sprites, pools, poles, switching (D5.4, D5.5)
  { id: 'headlights', node: false, load: (ctx) => import('./lights/headlights.js').then((m) => m.createHeadlightsPart(ctx)) }, // the visitor's headlamps and what signs and markings return (D5.1, D5.2)
  { id: 'traffic', node: false, load: (ctx) => import('./traffic/index.js').then((m) => m.createTrafficPart(ctx)) }, // vehicles on both carriageways, placed by the demand model (D6.4)
  { id: 'cabin', node: false, load: (ctx) => import('./vehicle/cabin.js').then((m) => m.createCabin(ctx)) }, // the cabin, its displays and the steering wheel (D4.2, D4.5)
  { id: 'valley', node: false, load: (ctx) => import('./traffic/valley.js').then((m) => m.createValleyPart(ctx)) }, // light ribbons on the rest of the valley's roads (D6.6)
  { id: 'obstruction', node: false, load: (ctx) => import('./lights/obstruction.js').then((m) => m.createObstructionPart(ctx)) }, // red obstruction lights on buildings above 61 m, hidden and moved with them (D5.6)
  { id: 'screens', node: false, load: (ctx) => import('./screens/index.js').then((m) => m.createScreensPart(ctx)) }, // screens on simulation time, their registry, the Sphere's light (D7.3, D7.5)
  { id: 'billboards', node: false, load: (ctx) => import('./roadside/billboards.js').then((m) => m.createBillboardsPart(ctx)) }, // billboards: structures, abstract faces, digital glow (D7.4, D7.5)
  { id: 'weather', node: false, load: (ctx) => import('./weather/index.js').then((m) => m.createWeatherPart(ctx)) }, // rain on the stand-in weather: wet road, reflected lamps, rain, spray, grey sky (D8.1, D8.3)
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
 * The entries to load: those `wanted` names (null: all), and on the new renderer only those with node materials.
 * @param {{ legacy: boolean, wanted?: string[] | null, registry?: typeof PARTS }} o
 * @returns {typeof PARTS}
 */
export function selectParts({ legacy, wanted = null, registry = PARTS }) {
  return registry.filter((p) => (wanted === null || wanted.includes(p.id)) && (legacy || p.node));
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

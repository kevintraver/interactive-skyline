// Everything Drive mode builds and runs, created the first time Drive is entered (index.js imports
// this module only then). It owns the drive's scene objects (wide ground, skirts, road chunks), the
// journey and the rig, and is a subsystem of plan 01's frame loop (see "the frame loop and the pipeline" below).
//
// The usual frame (plan 02, section 5.7): the app's clock moves (frame step 0) -> journey.poseAt -> parts' update ->
// rig.apply on the app's own camera (step 20); the look from plan 01's environment (step 45); then the pipeline draws,
// with the parts' beforeRender and afterRender around it. Everything else (which look, what the pill shows)
// follows from the pose and the clock, so a frame is a pure function of simulation time and the look state.
//
// Routes. The session is on one route at a time (routeswitch.js). A route brings its own RoadNet, road chunks,
// signs and barriers (the route's "kit"); configure() on another route loads that route's files (routes.js
// filesOf), builds its kit, disposes of the old kit (its chunk meshes, its mesher worker, its sign atlas and
// materials, its delineators), then tells the parts (setRoute below). While a switch loads and settles, the last frame
// stays on screen (main.js skips the pipeline's draw while `holding`), so no frame shows the road missing or two routes
// at once.
//
// Parts. Each drive feature (the road chunks, the roadside signs, the terrain's loading, and every
// later one) is registered with addPart(part), where a part is
//   { name, update?(frame), setLook?(look), setRoute?(route), show?(on), whenSettled?(), stats?(),
//     beforeRender?(frame), afterRender?(frame), dispose?() }
//   frame = { simMs, dtSimMs, pose, camera, viewport, night, sun: { elevation, azimuth }, rate, playing }
//   look  = look.js lookFromEnv(): { night: boolean, dusk: number, lights: number, beams: number, sun, ambientLux }
//           dusk 0 by day .. 1 by night, in steps of 1 / LOOK_STEPS; lights 0..1, plan 01's street-light switch-on;
//           beams 0..1, the headlamps' dusk curve
//   route = { route, roadnet, road, files }: the route (routes.json, parsed), the decoded RoadNet it runs on, its
//           road in that RoadNet, and its file names (routes.js filesOf: roadnet, bin, signs, barriers, traffic)
// update runs when the pose moved (every frame while the clock plays), setLook when the look changes
// (and once on registering, if there is a look already), setRoute when the route changes (and once on
// registering, if a route is set; before the journey moves onto the new route, so session.journey may still
// be the old one's), whenSettled and stats over all parts. A pass of a part's own (the mirrors) is a pipeline stage
// (parts.js). The part context's `chunks` and `roadside` (parts.js) are the current route's.

import * as THREE from 'three';
import { createFrame, EARTH_R, localUp } from '../world/frame.js';
import { buildWideMesh, cutWideMesh } from '../world/terrain/widemesh.js';
import { buildSkirt } from '../world/terrain/skirt.js';
import { createApron } from '../city/apron.js';
import { buildPatches, NO_PATCHES, patchesCrossing } from '../world/terrain/patches.js';
import { loadRoutes } from './routes.js';
import { createRoadMaterials } from './roadnet/material.js';
import { corridorMaterial } from './corridor/material.js';
import { createRoadChunks } from './roadnet/chunks.js';
import { createRoadside } from './roadside/index.js';
import { createCorridor } from './corridor/index.js';
import { createRouteSwitch } from './routeswitch.js';
import { PARTS, selectParts, partsFromSearch } from './parts.js';
import { createEnv } from './env.js';
import { createJourney } from './journey.js';
import { defaultDeparture } from './moment.js';
import { createRig } from './vehicle/rig.js';
import { isNightAt, lookFromEnv } from './look.js';
import { sightOverGround } from './sightline.js';
import { createTimings } from './timing.js';
import { createAdaptationStage } from './adaptation.js'; // decision 13: the driver's night adaptation

/** Metres the skirts hang below the edges of the finer terrain meshes: more than the 8 m sink and the grids' disagreement. */
const SKIRT_DEPTH = 20;
const RAD = Math.PI / 180;
/**
 * The look's dusk is rounded to 1/512, and parts get setLook when that changes. A step moves the drive's glows by
 * under 1% of their night strength (the windows by under one 8-bit level), too little to see; across the whole of
 * dusk (sun +6 to -9 degrees, about an hour) it is 512 setLook calls, about two a second at 16x.
 */
const LOOK_STEPS = 512;

/** The renderer's maximum anisotropy. */
const maxAnisotropy = (renderer) => renderer.getMaxAnisotropy();

const bitmapOf = (blob) => createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

/** The longest a route switch keeps the last frame on screen while the new route's road comes in, ms. */
const HOLD_MAX_MS = 15000;

/**
 * Download and build everything the drive needs. Rejects (leaving nothing in the scene) when a file fails.
 * @param {object} ctx the context initDrive was given  @param {object} terrain from createTerrain
 * @param {{ onFrame: (session: object) => void }} hooks onFrame runs at the end of every drive frame (the UI)
 * @param {{ route?: string, routesDoc?: Promise<object>|object }} [opts] the route to load first (default the
 *   first in routes.json), and routes.json when the caller has it already
 */
export async function createSession(ctx, terrain, hooks, { route: firstRoute, routesDoc } = {}) {
  const ctx0 = ctx;
  const { city, DATA, scene, renderer, camera, settings, tall, getLow, ground, invalidate } = ctx;
  const plan01 = ctx.plan01 || {}; // plan 01's contract: clock, timeline, env, quality, pipeline, loop
  const get = async (name) => {
    const r = await fetch(`${DATA}/${name}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r;
  };
  // the signs, barriers and roadside buildings are dressing: a city or a build without them still drives
  const optional = (name) => get(name).then((r) => r.json()).catch(() => null);
  let routesJson = routesDoc ? Promise.resolve(routesDoc) : null;
  const fetchJson = (n) => (n === 'routes.json' ? (routesJson ||= get(n).then((r) => r.json())) : get(n).then((r) => r.json()));
  // The terrain's patches (finer ground where the wide grid loses the land's shape: Black Canyon) are fetched with the
  // route that passes them (patchesCrossing: the route's outline against the patch's extent), the first route's with
  // the wide grid and the others when a route switch loads such a route (addPatches below). Their meshes join the part
  // context's ground (eachGround), so the lamps, headlights, screens and wet road reach them whenever they arrive.
  const patchMeta = terrain.patchIds.length ? Object.fromEntries(terrain.patchIds.map((id) => [id, terrain.patchInfo(id)])) : null;
  const patchesOf = (route) => (patchMeta && route ? patchesCrossing(route.outline, patchMeta) : []);
  const buildSome = (ids) => (ids.length ? buildPatches({
    terrain, base: city.base, renderer, json: optional, ids,
    image: (f) => get(f).then((r) => r.blob()).then(bitmapOf),
  }).catch((e) => { console.warn(`terrain patches left out: ${e && e.message ? e.message : e}`); return NO_PATCHES; }) : Promise.resolve(NO_PATCHES));
  const [net, wide, bitmap, corridorIndex, patches] = await Promise.all([
    loadRoutes({ fetchJson, fetchBinary: (n) => get(n).then((r) => r.arrayBuffer()) }, { route: firstRoute }),
    terrain.loadWide(),
    terrain.hasWide ? get('ground-wide.jpg').then((r) => r.blob()).then(bitmapOf) : null,
    optional('corridor/index.json'),
    patchMeta ? fetchJson('routes.json').then((doc) => {
      const list = doc?.routes || [];
      return buildSome(patchesOf(list.find((r) => r.id === firstRoute) ?? list[0]));
    }, () => NO_PATCHES) : NO_PATCHES,
  ]);

  const group = new THREE.Group();
  group.name = 'drive';
  group.visible = false;
  let wideMesh = null, wideMap = null;
  if (wide) {
    if (bitmap) {
      wideMap = new THREE.Texture(bitmap);
      wideMap.flipY = false; // flipped while decoding, as main.js does for its grids
      wideMap.colorSpace = THREE.SRGBColorSpace;
      wideMap.anisotropy = maxAnisotropy(renderer);
      wideMap.needsUpdate = true;
    }
    wideMesh = buildWideMesh({ wide, hole: terrain.grid('far'), cuts: patches.grids, base: city.base, map: wideMap });
    group.add(wideMesh);
  }
  // Plan 01's apron rings the far grid and, inside the wide grid, rises above the drive's ground in places (123 of its
  // 488 posts there, by up to 418 m): two grounds. While driving it is hidden and the same apron (src/city/apron.js)
  // rings the wide grid instead, tucked under its edge, so the ground runs on past the wide grid with no cliff and no
  // second ground.
  const mapApron = wideMesh ? scene.getObjectByName('terrain apron') : null;
  const driveApron = mapApron ? createApron({ scene: group, base: city.base }, wide, wideMesh, wideMap) : null;
  if (driveApron) driveApron.name = 'drive apron';
  // ground[i] is drawn from the grid named alongside it; a skirt fills the ledge at each one's edge
  for (const [mesh, name] of ground) group.add(buildSkirt(mesh, terrain.grid(name), SKIRT_DEPTH));
  // the patches bring their own skirts and water
  if (wide) for (const o of patches.objects) group.add(o);
  const groundMeshes = wide ? [...ground, ...patches.ground] : [...ground];
  const patchSets = wide ? [patches] : [];
  const patchIdsIn = new Set(wide ? patches.ground.map(([, id]) => id) : []);
  const groundListeners = new Set();
  /** Run fn(mesh, gridId) for every ground mesh, now and for each that arrives later; returns the unsubscribe. */
  function eachGround(fn) {
    for (const [mesh, id] of groundMeshes) fn(mesh, id);
    groundListeners.add(fn);
    return () => groundListeners.delete(fn);
  }
  /** The patches a route needs and the session has not built yet: fetched, built, cut out of the wide mesh, announced. */
  const patchLoads = new Map();
  function addPatches(route) {
    if (!wide) return Promise.resolve();
    const ids = patchesOf(route).filter((id) => !patchIdsIn.has(id));
    if (!ids.length) return Promise.resolve();
    const key = ids.join('|');
    if (!patchLoads.has(key)) {
      patchLoads.set(key, buildSome(ids).then((set) => {
        const fresh = set.ground.filter(([, id]) => !patchIdsIn.has(id));
        if (!fresh.length) return;
        for (const [, id] of fresh) patchIdsIn.add(id);
        for (const o of set.objects) group.add(o);
        set.setImagery(settings.imagery);
        patchSets.push(set);
        if (wideMesh) cutWideMesh(wideMesh, { wide, hole: terrain.grid('far'), cuts: patchSets.flatMap((p) => p.grids) });
        for (const entry of fresh) {
          groundMeshes.push(entry);
          for (const fn of groundListeners) fn(entry[0], entry[1]);
        }
        invalidate();
      }).finally(() => patchLoads.delete(key)));
    }
    return patchLoads.get(key);
  }
  const roads = new THREE.Group();
  roads.name = 'roads';
  group.add(roads);
  scene.add(group);

  const parts = [];
  let look = null, frame = null, lastSimMs = null;
  /** Register a part (see the top of this file). Returns it. */
  function addPart(part) {
    if (!part || typeof part.name !== 'string') throw new Error('a drive part needs a name');
    if (parts.some((p) => p.name === part.name)) throw new Error(`a drive part named "${part.name}" is registered already`);
    parts.push(part);
    if (look) part.setLook?.(look);
    if (routes.kit) part.setRoute?.(routeInfo(routes.kit));
    return part;
  }

  const anisotropy = maxAnisotropy(renderer);
  const materials = createRoadMaterials({ anisotropy });

  // Surfaces (decision 6): the node materials light lands on, by kind ('road', 'sign', 'support', 'delineator', 'building',
  // and the traffic part's 'vehicle'; the ground has eachGround). The lights parts add their terms to each through
  // src/drive/lights/surfaceLight.js; a route switch brings new sign materials, which reach it as they are built.
  const surfaces = new Map(), surfaceListeners = new Set();
  function addSurfaces(list) {
    for (const [m, kind] of list) {
      if (!m || surfaces.has(m)) continue;
      surfaces.set(m, kind);
      for (const fn of surfaceListeners) fn(m, kind);
    }
  }
  const dropSurfaces = (list) => { for (const [m] of list) surfaces.delete(m); };
  /** fn(material, kind) for every surface material now and for each that arrives later; returns the unsubscribe. */
  function eachSurface(fn) {
    for (const [m, kind] of surfaces) fn(m, kind);
    surfaceListeners.add(fn);
    return () => surfaceListeners.delete(fn);
  }
  addSurfaces([[materials.road, 'road'], [materials.roadNear, 'road']]);
  // a route's kit: its road chunks, signs and barriers (see the top of this file); the materials are shared by all
  const routes = createRouteSwitch({
    async load(id) {
      const { route, roadnet, road } = await net.loadRoute(id);
      const files = net.filesOf(route);
      const [signs, barriers] = await Promise.all([optional(files.signs), optional(files.barriers), addPatches(route)]);
      return { id: route.id, route, roadnet, road, files, signs, barriers };
    },
    build(d) {
      const chunks = createRoadChunks({ roadnet: d.roadnet, base: city.base, earthR: EARTH_R, parent: roads, materials, barriers: d.barriers });
      const roadside = d.signs ? createRoadside({
        signs: d.signs, barriers: d.barriers, roadnet: d.roadnet, base: city.base, earthR: EARTH_R, parent: roads, anisotropy,
        ground: terrain.surfaceAt,
      }) : null;
      const own = roadside?.surfaces?.() ?? [];
      addSurfaces(own);
      return { ...d, chunks, roadside, dispose() { dropSurfaces(own); roadside?.dispose(); chunks.dispose(); } };
    },
  });
  const routeInfo = (k) => ({ route: k.route, roadnet: k.roadnet, road: k.road, files: k.files });
  routes.onSwap((k) => { for (const p of parts) p.setRoute?.(routeInfo(k)); });
  await routes.use(firstRoute ?? net.routes[0].id);
  // the drive's port over the app's clock and environment (env.js, decisions 4 and 5)
  const env = createEnv({ city, app: plan01 });
  const clock = env.clock;
  const frameOf = createFrame(city);
  const rig = createRig();
  const journeys = new Map();

  // the road chunks, the signs and the terrain as parts, through thin adapters over their own APIs; the first two
  // follow the current route's kit (its chunks and its signs; a route without signs has none)
  const car = (f) => ({ x: f.pose.position.x, y: -f.pose.position.z });
  addPart({
    name: 'roads', update: (f) => routes.kit?.chunks.update(car(f)),
    whenSettled: () => routes.whenSettled((k) => k.chunks.whenSettled()),
    stats: () => ({ ...routes.kit?.chunks.stats(), route: routes.id }), dispose: () => routes.dispose(),
  });
  addPart({
    name: 'signs', update: (f) => routes.kit?.roadside?.update(car(f)),
    whenSettled: () => routes.whenSettled((k) => k.roadside?.whenSettled()),
    stats: () => routes.kit?.roadside?.stats() ?? null,
  });
  addPart({ name: 'terrain', whenSettled: () => terrain.whenSettled(), stats: () => terrain.stats() });
  if (corridorIndex && wide) {
    const corridorMat = corridorMaterial();
    addSurfaces([[corridorMat, 'building']]);
    addPart(createCorridor({
      index: corridorIndex, fetchBinary: (f) => get(`corridor/${f}`).then((r) => r.arrayBuffer()), heightAt: terrain.surfaceAt,
      base: city.base, earthR: EARTH_R, parent: group, anisotropy, material: corridorMat,
    }));
  }

  // the optional features (parts.js) join as they finish loading; the drive does not wait for them to start
  let partsReady = Promise.resolve();
  function loadParts() {
    const ctx = {
      app: ctx0, session, get, optional, group, roads, terrain, wideMesh, ground: groundMeshes, eachGround, eachSurface, net, env, clock, rig, frameOf,
      addSurfaces, // [[material, kind], ...]: a part's own surfaces for the light (the traffic's bodies, 'vehicle')
      earthR: EARTH_R, base: city.base, materials,
      get chunks() { return routes.kit?.chunks ?? null; },
      get roadside() { return routes.kit?.roadside ?? null; },
    };
    const wanted = partsFromSearch(typeof location !== 'undefined' ? location.search : '');
    partsReady = Promise.all(selectParts({ wanted, registry: PARTS }).map(async (entry) => {
      try {
        const part = await entry.load(ctx);
        if (!part) return;
        addPart(part);
        if (frame) part.update?.(frame);
      } catch (e) { console.warn(`drive part left out: ${e && e.message ? e.message : e}`); }
    })).then(() => { needPose = true; invalidate(); });
  }

  let journey = null, pose = null, needPose = true, loading = false, updateId = 0;
  // a route switch keeps the last frame on screen until the new route's parts are in (see the top of this file)
  let holdUntil = 0;
  // the rig's body and head layers read the journey and the simulation time (vehicle/motion.js)
  rig.bind({ journey: () => journey, now: () => clock.now() });
  // the hold-position lock (plan 02, section 4.3) and the start chip the visitor last chose
  let locked = false, startKey = 'reveal';
  const timings = { total: createTimings(), journey: createTimings(), chunks: createTimings(), rig: createTimings(), ui: createTimings() };
  const viewport = () => ({ width: innerWidth, height: innerHeight });

  function journeyFor(routeId) {
    const route = net.route(routeId);
    if (!route) throw new Error(`no route "${routeId}" (routes: ${net.routes.map((r) => r.id).join(', ')})`);
    if (!journeys.has(route.id)) {
      journeys.set(route.id, createJourney({ route, road: net.roadOf(route), frame: frameOf, departMs: 0, startS: route.starts.reveal, city: ctx.cityId }));
    }
    return journeys.get(route.id);
  }

  /** Put the car on a loaded route (configure's work once the route is current). */
  function place(routeId, { s, t } = {}) {
    const before = journey;
    journey = journeyFor(routeId);
    if (before && before !== journey) startKey = 'reveal'; // another route starts from its default chip
    const startS = Number.isFinite(s) ? s : journey.route.starts.reveal ?? journey.s0;
    if (Number.isFinite(t)) journey.rebase(startS, t);
    else {
      const d = defaultDeparture({ journey, env, startS });
      journey.rebase(startS, Number.isFinite(d.startMs) ? d.startMs : Date.now());
    }
    clock.seek(journey.timeAt(startS));
    syncTimeline();
    needPose = true;
    invalidate();
  }

  // One clock (decision 4): the journey is on app.timeline, so plan 01's environment, exposure and transport
  // know a journey is under way and where it departed. The drive's journey (journey.js) stays the one that places the
  // car; the timeline's handle is begun again whenever the drive re-times its departure (a start, a seek with a time,
  // the time-of-day jumps; the lock re-times every frame and syncs when it is released). The timeline's own end of
  // journey does nothing ('hold'): the car holds at the end of the route by itself, and the drive's bar says so.
  let handle = null;
  const timelineJourneys = new WeakMap();
  function timelineJourney(j) {
    if (!timelineJourneys.has(j)) {
      const t0 = () => j.timeAt(j.s0);
      timelineJourneys.set(j, {
        id: j.id, label: j.route.label || j.route.name || j.route.id, durationS: j.duration / 1000, atEnd: 'hold',
        markers: j.markers.filter((m) => Number.isFinite(m.s)).map((m) => ({ progressS: (j.timeAt(m.s) - t0()) / 1000, label: m.label })),
        /** plan 01 moved the departure (handle.setStart): the car keeps its place on the road, the sky moves */
        rebase: (startMs) => { j.rebase(j.s0, startMs); needPose = true; },
      });
    }
    return timelineJourneys.get(j);
  }
  function syncTimeline() {
    if (!group.visible || !journey || locked) return;
    const startMs = journey.timeAt(journey.s0);
    if (handle && plan01.timeline.active === handle && handle.journey === timelineJourney(journey) && handle.startMs === startMs) return;
    handle = plan01.timeline.begin(timelineJourney(journey), { startMs });
  }
  function endTimeline() {
    if (handle) handle.end();
    handle = null;
  }

  // The look the parts get (look.js lookFromEnv): the sky, the light, the haze and the exposure are plan 01's (decision
  // 5), and the look is computed from env.state at frame step 45, after the environment; the parts are told when dusk
  // moves a step.
  /** Tell the parts when the look moved a step. */
  function updateLook() {
    if (!plan01.env.state) return;
    const next = lookFromEnv(plan01.env.state, { steps: LOOK_STEPS });
    if (look && look.dusk === next.dusk && look.night === next.night && look.lights === next.lights) return;
    look = next;
    for (const p of parts) p.setLook?.(look);
  }

  /** Bring the pose, the parts and the look up to date with the clock. */
  function update() {
    let t = performance.now();
    const lap = (name) => { const n = performance.now(); timings[name].add(n - t); t = n; };
    const simMs = clock.now();
    pose = journey.poseAt(simMs);
    lap('journey');
    const sun = env.ephemeris.sun(simMs);
    frame = {
      simMs, dtSimMs: lastSimMs === null ? 0 : simMs - lastSimMs, pose, camera, viewport: viewport(),
      night: isNightAt(sun.elevation), sun: { elevation: sun.elevation, azimuth: sun.azimuth }, rate: clock.rate, playing: clock.playing,
    };
    lastSimMs = simMs;
    for (const p of parts) p.update?.(frame);
    const id = ++updateId;
    loading = true;
    // Paused, the next frame is drawn once the parts are in, not one per chunk as they arrive: the
    // mesher is quick, and on a slow GPU (or a software one) frames in between starve it of CPU.
    // Playing, the clock asks for every frame anyway.
    settledParts().then(() => { if (id === updateId) loading = false; invalidate(); });
    updateLook();
    lap('chunks');
  }
  const settledParts = () => partsReady.then(() => Promise.all(parts.map((p) => p.whenSettled?.())));

  const session = {
    net, env, clock, rig, group, terrain, timings, addPart, eachSurface,
    get parts() { return parts.map((p) => p.name); },
    /** A registered part by name, or null. */
    part: (name) => parts.find((p) => p.name === name) || null,
    get journey() { return journey; },
    get pose() { return pose; },
    get loading() { return loading; },
    get locked() { return locked; },
    get startKey() { return startKey; },
    /** The car is at the end of the route, holding there. */
    get arrived() { return !!(pose && journey && pose.s >= journey.s1 - 1); },

    /** The route the session is on (its id), and the one it is switching to, or null. */
    get route() { return routes.id; },
    get switching() { return routes.switching; },
    /** The current route's road chunks and signs (null without signs). */
    get chunks() { return routes.kit?.chunks ?? null; },
    get roadside() { return routes.kit?.roadside ?? null; },

    /**
     * Put the car on a route. With no time, the default moment (moment.js): today, timed so the reveal
     * falls in mid civil twilight. With a time, the journey is re-timed so `s` falls at `t`.
     * On the current route this is done at once; on another, that route is loaded first (see the top of this
     * file). Resolves when the car is on the route; resolves without moving it when a later configure() for
     * another route superseded this one; rejects when the route's files fail (the car stays where it was).
     * @param {string} routeId  @param {{ s?: number, t?: number }} [at]
     * @returns {Promise<void>}
     */
    configure(routeId, at = {}) {
      if (!net.route(routeId)) return Promise.reject(new Error(`no route "${routeId}" (routes: ${net.routes.map((r) => r.id).join(', ')})`));
      if (routes.id === routeId) {
        if (routes.switching) { routes.use(routeId); holdUntil = 0; } // drops a switch to another route still loading
        place(routeId, at);
        return Promise.resolve();
      }
      holdUntil = performance.now() + HOLD_MAX_MS;
      return routes.use(routeId).then((k) => {
        if (!k) return; // superseded
        place(routeId, at);
        if (group.visible) update();
        settledParts().then(() => { if (routes.id === routeId) { holdUntil = 0; invalidate(); } });
      }, (err) => { if (!routes.switching) holdUntil = 0; invalidate(); throw err; });
    },

    /** Move the car: both s and t re-time the journey; s alone moves the clock to when the car is there. */
    seek({ s, t } = {}) {
      if (Number.isFinite(s) && Number.isFinite(t)) { journey.rebase(s, t); clock.seek(t); syncTimeline(); }
      else if (Number.isFinite(s)) clock.seek(journey.timeAt(s));
      else if (Number.isFinite(t)) clock.seek(t);
      // the pose is current at once; the next frame redoes it and times the whole frame. No frame is
      // asked for here: update() asks for one once the road chunks for the new place are in
      if (group.visible) update();
      needPose = true;
    },
    seekBy(seconds) { session.setTime(clock.now() + seconds * 1000); },

    /** Change the time. Unlocked the car drives along the journey to where it is then; locked it stays. */
    setTime(t) {
      if (!Number.isFinite(t)) return;
      if (locked && pose) session.keepPlace(t); else session.seek({ t });
    },
    /** Change the time and keep the car where it is, lock or no lock (the time-of-day jumps). */
    keepPlace(t) {
      if (!Number.isFinite(t) || !pose) return;
      session.seek({ s: pose.s, t });
    },
    /** Locked, the journey is re-based every frame so the car holds its place while the clock runs. */
    setLocked(on) { locked = !!on; syncTimeline(); },
    setRate(rate) { clock.setRate(rate); },
    /** The default moment (moment.js) for where the car is, on the clock's own day. */
    duskAt() {
      if (!pose) return NaN;
      return defaultDeparture({ journey, env, startS: pose.s, nowMs: clock.now() }).startMs;
    },
    /** A start chip: the car goes to that start at the default moment for it. */
    startFrom(key) {
      const s = journey?.route.starts?.[key];
      if (!Number.isFinite(s)) return;
      startKey = key;
      session.configure(journey.route.id, { s });
      if (group.visible) update();
    },
    /** From the end of the route: drive it again from the chosen start, on the same timing. */
    restart() {
      const s = journey?.route.starts?.[startKey] ?? journey?.startS;
      if (Number.isFinite(s)) session.seek({ s });
    },

    /** Show or hide the drive's scene objects. */
    show(on) {
      group.visible = on;
      // a part with pipeline stages of its own adds and removes them with the drive (the cabin), here and not a frame
      // later: Map puts its pipeline state back right after this (index.js, mapPipeline.js)
      for (const p of parts) p.show?.(on);
      if (!on) look = null;
      attach(on);
      if (mapApron) mapApron.visible = !on;
      if (on) {
        if (wideMesh) {
          wideMesh.material.map = settings.imagery ? wideMap : null;
          wideMesh.material.color.set(settings.imagery ? 0xffffff : 0xbdb9ad);
          wideMesh.material.needsUpdate = true;
          for (const p of patchSets) p.setImagery(settings.imagery);
        }
        needPose = true;
        update();
      }
      invalidate();
    },

    /** A route switch holds the last frame on screen (main.js then skips the pipeline's draw). */
    get holding() { return holdUntil > performance.now(); },

    /** Remove every part's objects, last registered first. The session is unusable after this. */
    dispose() {
      attach(false);
      for (const p of [...parts].reverse()) p.dispose?.();
      parts.length = 0;
      look = null;
      scene.remove(group);
    },

    /** Look at a point in the scene: the head turns, the car does not. */
    lookAt(point) {
      const eye = camera.position, up = localUp(eye.x, eye.z, new THREE.Vector3());
      const dir = point.clone().sub(eye).normalize();
      const fh = pose.forward.clone().addScaledVector(up, -pose.forward.dot(up)).normalize();
      const dh = dir.clone().addScaledVector(up, -dir.dot(up)).normalize();
      const yaw = Math.atan2(new THREE.Vector3().crossVectors(fh, dh).dot(up), fh.dot(dh)) / RAD;
      const pitch = (Math.asin(dir.dot(up)) - Math.asin(pose.forward.dot(up))) / RAD;
      rig.look({ yaw, pitch });
      invalidate();
    },

    /** Whether a building's top can be seen from the eye: standing, and clear of the terrain and other buildings. */
    visible(targetId) {
      const entry = tall.find((e) => e.data.id === targetId);
      if (!entry || !entry.mesh.visible || !pose) return false;
      const eye = rig.apply(scratch, pose, viewport()).position.clone();
      const top = topOf(entry).add(entry.mesh.position);
      if (!sightOverGround(eye, top, terrain.surfaceY).clear) return false;
      const dist = eye.distanceTo(top);
      ray.set(eye, top.clone().sub(eye).normalize());
      ray.far = dist - 1;
      const others = tall.filter((e) => e !== entry && e.mesh.visible).map((e) => e.mesh);
      if (ray.intersectObjects(others, false).length) return false;
      const low = getLow();
      return !(low && low.geometry.boundsTree && ray.intersectObject(low, false).length);
    },

    /** Resolves when every part (road chunks, signs, terrain, ...) is in for the current pose and a frame with them has been drawn. */
    async whenSettled() {
      if (!pose || !group.visible) await nextFrame(); // seek and show bring the parts up to date at once; otherwise a frame does
      await settledParts();
      const drawn = renderer.info.render.frame;
      invalidate();
      // a lost context stops three's animation loop: no frame will come, so say so rather than wait for ever
      while (renderer.info.render.frame === drawn) {
        if (contextLost(renderer)) throw new Error('the WebGL context was lost; no frame can be drawn');
        await nextFrame();
      }
    },
    /** The names of the parts whose whenSettled has not resolved within `ms` (for scripts that time out waiting). */
    async unsettled(ms = 0) {
      const names = await Promise.all(parts.map(async (p) => {
        if (!p.whenSettled) return null;
        const done = await Promise.race([Promise.resolve(p.whenSettled()).then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
        return done ? null : p.name;
      }));
      return names.filter(Boolean);
    },

    /** Pose as plain numbers. */
    poseNumbers() {
      if (!pose) return null;
      const v = (p) => ({ x: p.x, y: p.y, z: p.z });
      return {
        route: journey.route.id, s: pose.s, km: pose.s / 1000, lane: pose.lane, lateral: pose.lateral,
        speed: pose.speed, mph: pose.speed / 0.44704, accel: pose.accel, grade: pose.grade, curvature: pose.curvature,
        position: v(pose.position), forward: v(pose.forward), up: v(pose.up), eye: v(rig.apply(scratch, pose, viewport()).position),
        t: clock.now(), iso: new Date(clock.now()).toISOString(), playing: clock.playing,
        yaw: rig.yaw, pitch: rig.pitch, lens: rig.lens, view: rig.view, reduceMotion: rig.reduceMotion, glance: rig.glancing,
        night: !!look?.night, rate: clock.rate, locked, arrived: session.arrived,
        sunElevation: env.ephemeris.sun(clock.now()).elevation,
      };
    },

    stats() {
      const r = renderer.info.render;
      return {
        render: { calls: r.calls, triangles: r.triangles },
        signs: null, // a city or build without signs
        ...Object.fromEntries(parts.filter((p) => p.stats).map((p) => [p.name, p.stats()])),
        js: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v.summary()])),
        // plan 01's quality governor owns the render scale (decision 8)
        renderScale: { governedBy: 'app.quality', ratio: plan01.quality?.renderScale ?? 1, level: plan01.quality?.level ?? null },
      };
    },
  };

  // ---------------------------------------------------------------- the frame loop and the pipeline
  // The session is a subsystem of the app's frame loop (decision 3): at order 20, after the clock (0) and the timeline
  // (10), it places the car and the camera and runs the parts' update; at 45, after the environment (40), it gives the
  // parts the look; it votes 'continuous' while the clock plays or a glance eases. main.js draws through the pipeline,
  // whose camera is the app's camera the rig drives; the parts' beforeRender and afterRender run around each draw.
  let lastSeenMs = null, detach = null;
  function frameStep() {
    if (!group.visible || !journey) return;
    const t0 = performance.now();
    const simMs = clock.now();
    if (locked && pose && lastSeenMs !== null && simMs !== lastSeenMs) journey.rebase(pose.s, simMs);
    const moved = needPose || simMs !== lastSeenMs;
    lastSeenMs = simMs;
    if (moved) { needPose = false; update(); }
    let t = performance.now();
    rig.apply(camera, pose, viewport()); // its near plane is NEAR_M (rig.js)
    if (moved) timings.rig.add(performance.now() - t);
    t = performance.now();
    hooks.onFrame(session);
    if (moved) { timings.ui.add(performance.now() - t); timings.total.add(performance.now() - t0); }
  }
  const around = (before) => {
    if (!frame || !group.visible) return;
    for (const p of parts) (before ? p.beforeRender : p.afterRender)?.call(p, frame);
  };
  function attach(on) {
    if (!on) { detach?.(); detach = null; endTimeline(); return; }
    if (detach) return;
    lastSeenMs = null;
    const { loop, pipeline } = plan01;
    const off = [
      loop.add({ update: frameStep, demand: () => (group.visible && (clock.playing || rig.glancing) ? 'continuous' : 'idle') }, 20),
      loop.add({ update: () => { if (group.visible) updateLook(); } }, 45),
    ];
    pipeline.around.push(around);
    if (pipeline.scenePass && pipeline.scenePass.camera !== camera) pipeline.setCamera(camera);
    syncTimeline();
    // ---- decision 13: the driver's night adaptation (adaptation.js). Registered once the
    // parts are in, so it follows their afterBloom stages (the cabin's veil is light in front of the eye too).
    let adaptation = null, attached = true;
    if (pipeline.addStage) {
      partsReady.then(() => {
        if (!attached) return;
        adaptation = createAdaptationStage({ pipeline, ev100: () => plan01.env?.state?.exposure?.ev100 });
        group.userData.adaptation = adaptation; // for tests/manual/night-display.mjs
        invalidate();
      });
    }
    // ---- end decision 13
    detach = () => {
      attached = false; // decision 13
      if (adaptation) { adaptation.remove(); adaptation = null; delete group.userData.adaptation; } // decision 13
      off.forEach((f) => f());
      const i = pipeline.around.indexOf(around);
      if (i >= 0) pipeline.around.splice(i, 1);
    };
  }

  const scratch = new THREE.PerspectiveCamera();
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const tops = new WeakMap();
  /** The highest vertex a building draws, where it really stands (the same point scripts/lib/sightline.py uses). */
  function topOf(entry) {
    const geo = entry.mesh.geometry;
    if (!tops.has(geo)) {
      const p = geo.getAttribute('position');
      let k = 0;
      for (let i = 1; i < p.count; i++) if (p.getY(i) > p.getY(k)) k = i;
      tops.set(geo, new THREE.Vector3(p.getX(k), p.getY(k), p.getZ(k)));
    }
    return tops.get(geo).clone();
  }

  loadParts();
  return session;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Whether the renderer's WebGL context is lost (WebGPU reports a lost device through its own handler instead). */
function contextLost(renderer) {
  try { return !!renderer.getContext?.()?.isContextLost?.(); } catch { return false; }
}

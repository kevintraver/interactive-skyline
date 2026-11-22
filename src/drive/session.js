// Everything Drive mode builds and runs, created the first time Drive is entered (index.js imports
// this module only then). It owns the drive's scene objects (wide ground, skirts, road chunks), the
// clock, the journey and the rig, and runs one frame at a time from the app's animation loop.
//
// The usual frame (plan 02, section 5.7): clock.advance -> journey.poseAt -> parts' update ->
// rig.apply on the app's own camera; then, when the app asks for a frame, render(): parts'
// beforeRender, the draw, parts' afterRender. Everything else (which look, what the pill shows)
// follows from the pose and the clock, so a frame is a pure function of simulation time and the look state.
//
// Routes. The session is on one route at a time (routeswitch.js). A route brings its own RoadNet, road chunks,
// signs and barriers (the route's "kit"); configure() on another route loads that route's files (routes.js
// filesOf), builds its kit, disposes of the old kit (its chunk meshes, its mesher worker, its sign atlas and
// materials, its delineators), then tells the parts (setRoute below). While a switch loads and settles, the last frame
// stays on screen (render draws nothing), so no frame shows the road missing or two routes at once.
//
// Parts. Each drive feature (the road chunks, the roadside signs, the terrain's loading, and every
// later one) is registered with addPart(part), where a part is
//   { name, update?(frame), setLook?(look), setRoute?(route), whenSettled?(), stats?(), beforeRender?(frame), beforeWorld?(frame),
//     afterRender?(frame), dispose?() }
//   frame = { simMs, dtSimMs, pose, camera, viewport, night, sun: { elevation, azimuth }, rate, playing }
//   look  = look.js lookAt(): { night: boolean, dusk: number, lights: number, beams: number, sun, ambientLux, sky, light, street }
//           dusk 0 by day .. 1 by night, in steps of 1 / LOOK_STEPS; lights 0..1, how far the city's lights are on;
//           beams 0..1, how far the drive's headlight stand-ins (road and sign glow) are on
//   route = { route, roadnet, road, files }: the route (routes.json, parsed), the decoded RoadNet it runs on, its
//           road in that RoadNet, and its file names (routes.js filesOf: roadnet, bin, signs, barriers, traffic)
// update runs when the pose moved (every frame while the clock plays), setLook when the look changes
// (and once on registering, if there is a look already), setRoute when the route changes (and once on
// registering, if a route is set; before the journey moves onto the new route, so session.journey may still
// be the old one's), whenSettled and stats over all parts. beforeWorld runs after every part's beforeRender, with the
// scene's matrices up to date, for passes drawn into targets of their own before the world is drawn (the mirrors); it
// may clear the canvas and draw into it (the cabin's silhouette in the depth) and return 'cleared', and the world's
// draw then leaves the canvas as it is. The part context's `chunks` and `roadside` (parts.js)
// are the current route's.

import * as THREE from 'three';
import { createFrame, EARTH_R, localUp } from '../world/frame.js';
import { buildWideMesh, cutWideMesh } from '../world/terrain/widemesh.js';
import { buildSkirt } from '../world/terrain/skirt.js';
import { buildPatches, NO_PATCHES, patchesCrossing } from '../world/terrain/patches.js';
import { loadRoutes } from './routes.js';
import { createRoadMaterials } from './roadnet/material.js';
import { createRoadChunks } from './roadnet/chunks.js';
import { createRoadside } from './roadside/index.js';
import { createCorridor } from './corridor/index.js';
import { createRouteSwitch } from './routeswitch.js';
import { PART_FACTORIES } from './parts.js';
import { createEnv } from './env.js';
import { createJourney } from './journey.js';
import { defaultDeparture } from './moment.js';
import { createRig } from './vehicle/rig.js';
import { isNightAt, lookAt } from './look.js';
import { createSkyBlend, SUN_STEP_MS } from './skyblend.js';
import { sightOverGround } from './sightline.js';
import { createTimings } from './timing.js';
import { createRenderScale, adaptiveAllowed, isSoftwareRenderer } from './renderScale.js';

/** Real time a single frame may advance the clock by, so a hidden tab or a stalled frame does not jump the car. */
const MAX_STEP_MS = 250;
/** Metres the skirts hang below the edges of the finer terrain meshes: more than the 8 m sink and the grids' disagreement. */
const SKIRT_DEPTH = 20;
const RAD = Math.PI / 180;
/**
 * The look's dusk is rounded to 1/512, and parts get setLook when that changes. A step moves the drive's glows by
 * under 1% of their night strength (the windows by under one 8-bit level), too little to see; across the whole of
 * dusk (sun +6 to -9 degrees, about an hour) it is 512 setLook calls, about two a second at 16x.
 */
const LOOK_STEPS = 512;

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
  const { city, DATA, scene, renderer, camera, seam, invalidate, applyNight, settings, tall, getLow, ground } = ctx;
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
      wideMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
      wideMap.needsUpdate = true;
    }
    wideMesh = buildWideMesh({ wide, hole: terrain.grid('far'), cuts: patches.grids, base: city.base, map: wideMap });
    group.add(wideMesh);
  }
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

  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const materials = createRoadMaterials({ anisotropy });
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
      }) : null;
      if (roadside && look) roadside.setLook(look);
      return { ...d, chunks, roadside, dispose() { roadside?.dispose(); chunks.dispose(); } };
    },
  });
  const routeInfo = (k) => ({ route: k.route, roadnet: k.roadnet, road: k.road, files: k.files });
  routes.onSwap((k) => { for (const p of parts) p.setRoute?.(routeInfo(k)); });
  await routes.use(firstRoute ?? net.routes[0].id);
  const env = createEnv({ city });
  const clock = env.clock;
  const frameOf = createFrame(city);
  const rig = createRig();
  const journeys = new Map();

  // the road chunks, the signs and the terrain as parts, through thin adapters over their own APIs; the first two
  // follow the current route's kit (its chunks and its signs; a route without signs has none)
  const car = (f) => ({ x: f.pose.position.x, y: -f.pose.position.z });
  addPart({
    name: 'roads', update: (f) => routes.kit?.chunks.update(car(f)), setLook: (l) => materials.setLook(l),
    whenSettled: () => routes.whenSettled((k) => k.chunks.whenSettled()),
    stats: () => ({ ...routes.kit?.chunks.stats(), route: routes.id }), dispose: () => routes.dispose(),
  });
  addPart({
    name: 'signs', update: (f) => routes.kit?.roadside?.update(car(f)), setLook: (l) => routes.kit?.roadside?.setLook(l),
    whenSettled: () => routes.whenSettled((k) => k.roadside?.whenSettled()),
    stats: () => routes.kit?.roadside?.stats() ?? null,
  });
  addPart({ name: 'terrain', whenSettled: () => terrain.whenSettled(), stats: () => terrain.stats() });
  if (corridorIndex && wide) {
    addPart(createCorridor({
      index: corridorIndex, fetchBinary: (f) => get(`corridor/${f}`).then((r) => r.arrayBuffer()), heightAt: terrain.heightAt,
      base: city.base, earthR: EARTH_R, parent: group, anisotropy: renderer.capabilities.getMaxAnisotropy(),
    }));
  }

  // the optional features (parts.js) join as they finish loading; the drive does not wait for them to start
  let partsReady = Promise.resolve();
  function loadParts() {
    const ctx = {
      app: ctx0, session, get, optional, group, roads, terrain, wideMesh, ground: groundMeshes, eachGround, net, env, clock, rig, frameOf,
      earthR: EARTH_R, base: city.base, materials,
      get chunks() { return routes.kit?.chunks ?? null; },
      get roadside() { return routes.kit?.roadside ?? null; },
    };
    partsReady = Promise.all(PART_FACTORIES.map(async (factory) => {
      try {
        const part = await factory(ctx);
        if (!part) return;
        addPart(part);
        if (frame) part.update?.(frame);
      } catch (e) { console.warn(`drive part left out: ${e && e.message ? e.message : e}`); }
    })).then(() => { needPose = true; invalidate(); });
  }

  let journey = null, pose = null, needPose = true, lastNow = null, loading = false, updateId = 0;
  // a route switch keeps the last frame on screen until the new route's parts are in (see the top of this file)
  let holdUntil = 0;
  // the rig's body and head layers read the journey and the simulation time (vehicle/motion.js)
  rig.bind({ journey: () => journey, now: () => clock.now() });
  // the hold-position lock (plan 02, section 4.3) and the start chip the visitor last chose
  let locked = false, startKey = 'reveal';
  const timings = { total: createTimings(), journey: createTimings(), chunks: createTimings(), rig: createTimings(), ui: createTimings() };
  const viewport = () => ({ width: innerWidth, height: innerHeight });
  // the adaptive render scale (renderScale.js): playing, the pixel ratio follows the frame times; paused, the full one
  const scale = createRenderScale({
    renderer, invalidate,
    allowed: adaptiveAllowed({ webdriver: typeof navigator !== 'undefined' && !!navigator.webdriver, software: isSoftwareRenderer(renderer) }),
  });

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
    needPose = true;
    invalidate();
  }

  // The look (look.js) for the sun: blended on the app's sky (skyblend.js), the parts told when dusk moves a step,
  // and the boolean night (the interface theme, the app's night-only extras) switched once at its threshold. The sun is
  // rounded (elevation to 0.02 degree, azimuth to 0.1) so the sky is repainted only when something visible changes.
  const skyBlend = createSkyBlend({
    dome: ctx.sky, renderer, invalidate, ephemeris: env.ephemeris, ground, imagery: () => settings.imagery,
  });
  let skyKey = null;
  function updateLook(sun, simMs) {
    const elevation = Math.round(sun.elevation * 50) / 50, azimuth = Math.round(sun.azimuth * 10) / 10;
    const next = lookAt({ elevation, azimuth }, { steps: LOOK_STEPS });
    const key = `${elevation} ${azimuth} ${Math.round(simMs / SUN_STEP_MS)}`;
    if (key !== skyKey) { skyKey = key; skyBlend?.set(next, simMs); }
    if (seam.night !== next.night) {
      seam.night = next.night;
      applyNight(); // the legacy sky hands this to the blend; another sky gets the boolean look
      document.documentElement.dataset.theme = next.night ? 'dark' : 'light';
    }
    if (look && look.dusk === next.dusk && look.night === next.night) return;
    look = next;
    for (const p of parts) p.setLook?.(look);
  }
  /** Leaving Drive: the map's sun and dome come back (index.js then applies the visitor's own look). */
  function releaseLook() {
    skyBlend?.release();
    skyKey = null;
    look = null;
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
    updateLook(sun, simMs);
    lap('chunks');
  }
  const settledParts = () => partsReady.then(() => Promise.all(parts.map((p) => p.whenSettled?.())));

  const session = {
    net, env, clock, rig, group, terrain, timings, addPart,
    /** The adaptive render scale (renderScale.js): stats(), setAdaptive(on). */
    renderScale: scale,
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
      if (Number.isFinite(s) && Number.isFinite(t)) { journey.rebase(s, t); clock.seek(t); }
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
    setLocked(on) { locked = !!on; },
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
      lastNow = null;
      if (on) scale.enter(); else scale.leave(); // leaving Drive puts the app's own pixel ratio back
      if (!on) releaseLook();
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

    /** One frame, run by the app's animation loop before it renders. */
    frame(now) {
      const t0 = performance.now();
      const dt = lastNow === null ? 0 : Math.min(Math.max(now - lastNow, 0), MAX_STEP_MS);
      lastNow = now;
      const before = clock.now();
      clock.advance(dt);
      if (locked && pose && clock.now() !== before) journey.rebase(pose.s, clock.now());
      const moved = needPose || clock.now() !== before;
      if (moved) {
        needPose = false;
        update(); // asks for a frame once the chunks are in; a playing clock asks for every frame below
      }
      let t = performance.now();
      // every tick: resize() may have put the map's lens back on the shared camera
      rig.apply(camera, pose, viewport());
      ctx.sky.position.copy(camera.position);
      if (moved) timings.rig.add(performance.now() - t);
      t = performance.now();
      hooks.onFrame(session);
      if (moved) {
        timings.ui.add(performance.now() - t);
        timings.total.add(performance.now() - t0);
      }
      if (clock.playing || rig.glancing) invalidate(); // a glance eases over real time
      scale.tick(now, clock.playing); // before the frame is drawn: a paused frame at the full ratio
    },

    /** Draw the frame (app.drive.render, while driving): parts' beforeRender, the scene, parts' afterRender. */
    render() {
      if (holdUntil > performance.now()) return; // a route switch: the last frame stays until the new road is in
      if (frame) for (const p of parts) p.beforeRender?.(frame);
      // passes into targets of their own (the mirrors) go before the world: the canvas is then drawn in one go, world
      // and cabin, where a pass in between makes the GPU store the canvas's multisampled buffer and load it again
      // (about 4.5 ms at 2560 x 1440 on an M4). The scene's matrices are brought up to date once, for all of them.
      // A part that has cleared the canvas and drawn into it already (the cabin's silhouette in the depth) says so.
      let early = false, cleared = false;
      if (frame) {
        for (const p of parts) {
          if (!p.beforeWorld) continue;
          if (!early) { scene.updateMatrixWorld(); early = true; }
          if (p.beforeWorld(frame) === 'cleared') cleared = true;
        }
      }
      const auto = scene.matrixWorldAutoUpdate, autoClear = renderer.autoClear;
      if (early) scene.matrixWorldAutoUpdate = false;
      if (cleared) renderer.autoClear = false;
      renderer.render(scene, camera);
      scene.matrixWorldAutoUpdate = auto;
      renderer.autoClear = autoClear;
      if (frame) for (const p of parts) p.afterRender?.(frame);
    },

    /** Remove every part's objects, last registered first. The session is unusable after this. */
    dispose() {
      for (const p of [...parts].reverse()) p.dispose?.();
      parts.length = 0;
      releaseLook();
      skyBlend?.dispose();
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
      if (!sightOverGround(eye, top, terrain.groundY).clear) return false;
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
        if (renderer.getContext().isContextLost?.()) throw new Error('the WebGL context was lost; no frame can be drawn');
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
        night: !!seam.night, rate: clock.rate, locked, arrived: session.arrived,
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
        renderScale: scale.stats(),
      };
    },
  };

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

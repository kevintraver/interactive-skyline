// The `traffic` drive part (plan 02, D6.4 and D6.5): vehicles on both carriageways, placed by the demand model,
// their lamps out to several kilometres, light ribbons beyond to the horizon, and the pools their head lamps throw.
//
// Per route (loaded the first time the journey is on it): the route's traffic file (routes.json files.traffic),
// the lane map onto the route's road and the opposing carriageway the file names (lanemap.js), the lanes of the
// car's direction referenced to the visitor's journey (reference.js: the car's lane runs at the car's speed and
// the car rides a slot of it), the demand surface with those lanes (demand.js), the fleet that places vehicles
// (fleet.js), the far field (far.js) and the ribbons' geometry (ribbon.js). Once: the vehicle models
// (public/models/drive/), the lamp sprite layer (lampLayer.js) and the pool decal (pools.js).
//
// Per frame (update, when the pose moved): every vehicle on both carriageways out to the lamps' range (by day the
// bodies' range: where a sedan shrinks below a few pixels with the current lens; behind the car only BEHIND_SHARE
// of it unless the camera looks back) comes from the far field (far.js: placed per tile and quantum, moved on),
// except within EXACT_AHEAD_M ahead and EXACT_BEHIND_M behind the car, where the fleet places them exactly, with
// the car taking its slot (fleet.js, reference.js). Which vehicles there are is the far field's list throughout
// (a vehicle whose moved-on place is near the car takes its exact pose), so nothing doubles or drops where the
// two meet. When the journey was re-timed (the hold-position lock) the lanes' slot grids are slid to keep the
// car on its slot (reference.shifts).
// Per render (beforeRender): the renderer sorts the bodies into the twelve instanced meshes by size on screen and
// culls by the view (render.js); then, while the look has the vehicles' lamps on (look.beams > 0), the lamps of
// the near and far vehicles out to the sprite range (SPRITE_RANGE_M by preset the way the camera looks, the
// bodies' range the other way, half of it each way when it looks across) are
// written to the sprite layer, the ribbons take over beyond (the last SPRITE_BAND of the range hands over), and
// the nearest lit vehicles get pools. By day none of that runs.
// Nothing is carried from frame to frame but caches: the same simulation time gives the same vehicles and lamps.
//
// Plan 01's renderer (plan 02, third stretch, decisions 2, 4, 6 and 8). The same part over the node modules
// (render.node.js, lampLayer.node.js, ribbon.node.js, pools.node.js), chosen by ctx.legacy; each shares its CPU work with
// its GLSL sibling (renderCore.js, lampCore.js, ribbonCore.js, poolsCore.js). Time is app.clock through the session's
// clock (frame.simMs). Light is physical: vehicle lamps are candela through the node sprite layer, lamp faces and
// ribbons cd/m^2, pools lux on the road, all times photometry.node.js artificialScale (the pre-exposure and the
// lights-out slider). In the shipped look the look's `beams` fade (the classic fixed exposure's stand-in) is 1 and
// the vehicles' own thresholds switch them (lamps.js vehicleThresholdLux; the ribbons by vehicleLitShare); the lamp
// faces carry only the stop lamps by day (see where they are set);
// at ?display=classic the fade, the classic face values and the ribbons' tone are kept, for the parity tool.
// Detail by quality level (TRAFFIC_DETAIL): bodies detailed above DETAIL_PX on screen, the lamps' sprite range.
// The bodies' materials are offered to the light as surfaces of kind 'vehicle' (ctx.addSurfaces), so the headlights'
// beam can land on them.
//
// The part's own API, beyond the session's (update, beforeRender, setLook, whenSettled, stats, dispose):
//   lampPoints()   the lamps of the vehicles drawn this frame (render.js header)
//   placed()       the vehicles of this frame (the far field's list, exact near the car), for tests and the overlay
//   model()        { traffic, laneMap, fleet, reference, far, ribbons } of the current route, or null
//   renderer       the instanced meshes (render.js), for tests and the frame-budget probe
//   lamps          the lamp sprite layer (lampLayer.js); pools the decal (pools.js)
//   setEnabled(v)  switch the whole part off and on (for measuring what it costs)
// The weather part reads placed() and renderer.lengths for spray; the vehicle lamps' reflected twins are the lamp
// layer's (`reflect`), driven by the sprite module's setTwins (lights/sprites.js or sprites.node.js) like every
// reflecting layer.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createTraffic } from './demand.js';
import { createLaneMap } from './lanemap.js';
import { createFleet, BODY_NAMES } from './fleet.js';
import { createReference, createEasedPace } from './reference.js';
import { createFarField } from './far.js';
import { vehicleLitShare, vehicleThresholdLux } from './lamps.js';
import { physicalFaceCdM2 } from './lightData.js';
import { createTimings } from '../timing.js';

const MODELS = '/models/drive/';
/** Share of the range kept behind the car when the camera looks forward (all of it when it looks back). */
const BEHIND_SHARE = 0.35;
/** How far ahead vehicles are drawn as lamp sprites, by preset (m); behind, half of it unless looking back. */
export const SPRITE_RANGE_M = Object.freeze({ low: 2000, high: 4000, ultra: 6000 });
/** Below this share of vehicles with lamps on, the shipped look skips the lamps, ribbons and pools (by day). */
export const LIT_SHARE_MIN = 1e-3;
/** Share of the sprite range over which the sprites hand over to the ribbons. */
export const SPRITE_BAND = 0.25;
/** The stretch around the car where vehicles are placed exactly each frame (m). */
export const EXACT_AHEAD_M = 300;
export const EXACT_BEHIND_M = 150;
const EXACT_MARGIN_M = 40;
const COMBINED = {
  pos: [Float64Array, 3], fwd: [Float32Array, 3], up: [Float32Array, 3], s: [Float64Array, 1], speed: [Float32Array, 1],
  id: [Float64Array, 1], k: [Float64Array, 1], body: [Uint8Array, 1], colour: [Uint32Array, 1], brake: [Uint8Array, 1],
  alpha: [Float32Array, 1], dir: [Uint8Array, 1], lane: [Uint8Array, 1],
};

/** @param {object} ctx the part context (parts.js) */
export async function createTrafficPart(ctx) {
  const { session, net, frameOf, earthR, group } = ctx;
  const legacy = ctx.legacy !== false;
  const env = ctx.env || session.env;
  // the modules of the renderer (decision 2), and on plan 01's the light's scale and display (photometry.node.js)
  const [sidecar, gltf, R, L, RB, PL, photo, sprites] = await Promise.all([
    fetch(`${MODELS}vehicles.json`).then((r) => { if (!r.ok) throw new Error(`vehicles.json: HTTP ${r.status}`); return r.json(); }),
    new GLTFLoader().loadAsync(`${MODELS}vehicles.glb`),
    ...(legacy
      ? [import('./render.js'), import('./lampLayer.js'), import('./ribbon.js'), import('./pools.js'), null, null]
      : [import('./render.node.js'), import('./lampLayer.node.js'), import('./ribbon.node.js'), import('./pools.node.js'),
        import('../lights/photometry.node.js'), import('../lights/sprites.node.js')]),
  ]);
  const photometry = legacy ? null : photo.photometryContext({ nodes: env.nodes });
  const display = legacy ? 'classic' : photometry.display;
  const physical = display === 'physical';
  const scale = legacy ? null : photo.artificialScale(photometry);
  const toScene = legacy || physical ? null : (await import('./classicDisplay.node.js')).toScene;
  const quality = legacy ? null : ctx.app?.plan01?.quality ?? null;
  const renderer = legacy ? R.createTrafficRenderer({ parent: group, sidecar, gltf }) : R.createTrafficRenderer({ parent: group, sidecar, gltf, lightScale: scale });
  const lamps = legacy ? L.createLampLayer({ parent: renderer.group, sidecar }) : L.createLampLayer({ parent: renderer.group, sidecar, photometry });
  const pools = legacy ? PL.createPools({ parent: renderer.group, sidecar, bodyNames: BODY_NAMES })
    : PL.createPools({ parent: renderer.group, sidecar, bodyNames: BODY_NAMES, lightScale: scale, twinWet: sprites.TWIN_UNIFORMS.uTwinWet });
  const makeRibbons = (traffic, laneMap) => (legacy
    ? RB.createRibbons({ parent: renderer.group, traffic, laneMap, frame: frameOf })
    : RB.createRibbons({ parent: renderer.group, traffic, laneMap, frame: frameOf, lightScale: scale, tone: physical ? 'scene' : 'sprite', ...(toScene ? { toScene } : {}) }));
  // The lamp faces in the shipped look. A lit lamp's light is its sprite's: near, the sprite is a disc of the lens's size
  // carrying the lamp's candela (flux kept), so a face emitting the lamp's luminance as well counted the light twice and,
  // emitting the same toward every side over the modelled lens, drew oncoming head lamps as glare a vehicle wide. So
  // head and tail faces emit nothing there; the stop lamps' faces emit the stop lamp's own luminance (lightData.js
  // physicalFaceCdM2) where the vehicle's lamps are off (by day, when no sprite is lit), x (1 - the lit share).
  const faceBrake = physicalFaceCdM2().brake;
  if (physical) { const u = renderer.uniforms; u.uHead.value = 0; u.uTail.value = 0; u.uBrake.value = faceBrake; }
  // detail by plan 01's quality level (decision 8)
  const applyDetail = (level) => { if (!legacy) renderer.setDetailPx(R.DETAIL_PX[level] ?? R.DETAIL_PX.high); };
  applyDetail(quality?.level);
  const offQuality = quality?.on ? quality.on('change', (q) => applyDetail(q.level)) : () => {};
  // the bodies' node materials, for the light that lands on surfaces (the headlights' beam)
  if (!legacy) ctx.addSurfaces?.(renderer.materials.map((m) => [m, 'vehicle']));
  const models = new Map(); // route id -> Promise<model | null>
  let current = null, currentId = null, loading = Promise.resolve();
  let placed = null, enabled = true;
  const placedWindow = { s: 0, range: 0, sA: 0, sB: 0 };
  const timings = { place: createTimings(), draw: createTimings(), lamps: createTimings() };
  const sub = { far: createTimings(), exact: createTimings(), merge: createTimings() };
  const look = { beams: 0, lights: 0, ambient: 1e5 };
  let ambient = 1e5, lastDepart = NaN, lastJourney = null;
  const lampStats = { on: false, far: 0, exact: 0 };

  function modelFor(route) {
    if (!models.has(route.id)) {
      const p = (async () => {
        const file = net.filesOf(route).traffic;
        const data = await ctx.optional(file);
        if (!data) return null;
        const base = createTraffic(data);
        const roadnet = net.roadnetOf(route);
        const byId = (id) => roadnet.roads.find((r) => r.id === id);
        const roads = { with: byId(base.file.directions.with.road) || net.roadOf(route), against: byId(base.file.directions.against.road) };
        if (!roads.against) throw new Error(`traffic: no road ${base.file.directions.against.road} for ${route.id}`);
        const laneMap = createLaneMap({ traffic: base, roads });
        const journey = session.journey?.route?.id === route.id ? session.journey : null;
        const reference = journey ? createReference({ traffic: base, laneMap, journey }) : null;
        const lanePace = { with: reference ? reference.lanePace.with : createEasedPace({ traffic: base, dir: 'with' }), against: createEasedPace({ traffic: base, dir: 'against' }) };
        const traffic = createTraffic(data, { lanePace });
        if (reference) reference.shifts(traffic, journey);
        const fleet = createFleet({ traffic, laneMap, frame: frameOf, lengths: renderer.lengths, earthR, reference });
        const far = createFarField({ traffic, laneMap, frame: frameOf, lengths: renderer.lengths, earthR });
        const ribbons = makeRibbons(traffic, laneMap);
        return { traffic, laneMap, fleet, reference, far, ribbons, journey, depart: journey?.departMs };
      })().catch((e) => { console.warn(`traffic for ${route.id} left out: ${e && e.message ? e.message : e}`); return null; });
      models.set(route.id, p);
    }
    return models.get(route.id);
  }

  /** Make sure the journey's route has its model; returns true when it is ready. */
  function ensure() {
    const route = session.journey?.route;
    if (!route) return false;
    if (route.id !== currentId) {
      currentId = route.id;
      if (current) { current.ribbons.mesh.visible = false; }
      current = null;
      renderer.clear(); lamps.clear(); pools.clear();
      loading = modelFor(route).then((m) => {
        if (currentId === route.id) { current = m; ctx.app?.invalidate?.(); }
      });
      return false;
    }
    return !!current;
  }

  /** The journey was re-timed (or is another object): slide the lanes so the car keeps riding a slot. */
  function followJourney() {
    const j = session.journey;
    if (!current.reference || !j) return;
    if (j === lastJourney && j.departMs === lastDepart) return;
    lastJourney = j; lastDepart = j.departMs;
    current.reference.shifts(current.traffic, j);
    current.far.clear();
    current.ribbons.invalidate();
  }

  const range = { ahead: 0, behind: 0, full: 0, spriteAhead: 0, spriteBehind: 0 };
  function rangeFor(frame) {
    const cam = frame.camera, pose = frame.pose;
    const full = renderer.rangeFor(cam, frame.viewport?.height || 720);
    // the camera's look along the car: forward (1) .. back (-1); from above, both ways
    const e = cam.matrixWorld.elements;
    const c = -(e[8] * pose.forward.x + e[9] * pose.forward.y + e[10] * pose.forward.z);
    const lookAhead = c > 0 ? c : 0, lookBack = c < 0 ? -c : 0;
    const height = cam.position.y - pose.position.y;
    const wide = height > 30 ? 1 : 0; // a view from above sees both ways
    range.full = full;
    range.ahead = full * Math.max(BEHIND_SHARE + (1 - BEHIND_SHARE) * (1 - lookBack), wide);
    range.behind = full * Math.max(BEHIND_SHARE + (1 - BEHIND_SHARE) * (1 - lookAhead), wide);
    const S = SPRITE_RANGE_M[env?.quality?.preset] || SPRITE_RANGE_M.high;
    // the lamps' range: all of S the way the camera looks, nothing beyond the bodies the other way (the ribbons
    // carry on from there), half of it each way when the camera looks across the road
    range.spriteAhead = Math.max(range.ahead + 100, S * Math.max(wide, 0.5 * (1 - lookBack) + 0.5 * lookAhead));
    range.spriteBehind = Math.max(range.behind + 100, S * Math.max(wide, 0.5 * (1 - lookAhead) + 0.5 * lookBack));
    return range;
  }

  // the vehicles of this frame: the far field's list, with the exact poses near the car (see the header)
  const combined = { count: 0, capacity: 0, pos: null, fwd: null, up: null, s: null, speed: null, id: null, k: null, body: null, colour: null, brake: null, alpha: null, dir: null, lane: null };
  function growCombined(n) {
    for (const [k, [T, w]] of Object.entries(COMBINED)) {
      const a = new T(n * w);
      if (combined.capacity) a.set(combined[k].subarray(0, combined.count * w));
      combined[k] = a;
    }
    combined.capacity = n;
  }
  growCombined(2048);
  const farRanges = [0, 0], exactRange = [0, 0];
  /** Append vehicle i of src (the far field's or the fleet's list) to the combined list: plain field copies. */
  function copyInto(src, i) {
    if (combined.count >= combined.capacity) growCombined(combined.capacity * 2);
    const c = combined, o = c.count++, o3 = 3 * o, i3 = 3 * i;
    const P = c.pos, F = c.fwd, U = c.up, sp = src.pos, sf = src.fwd, su = src.up;
    P[o3] = sp[i3]; P[o3 + 1] = sp[i3 + 1]; P[o3 + 2] = sp[i3 + 2];
    F[o3] = sf[i3]; F[o3 + 1] = sf[i3 + 1]; F[o3 + 2] = sf[i3 + 2];
    U[o3] = su[i3]; U[o3 + 1] = su[i3 + 1]; U[o3 + 2] = su[i3 + 2];
    c.s[o] = src.s[i]; c.speed[o] = src.speed[i]; c.id[o] = src.id[i]; c.k[o] = src.k[i]; c.body[o] = src.body[i];
    c.colour[o] = src.colour[i]; c.brake[o] = src.brake[i]; c.alpha[o] = src.alpha[i]; c.dir[o] = src.dir[i]; c.lane[o] = src.lane[i];
  }
  function placeAll(frame, lampsOn) {
    const s = frame.pose.s;
    farRanges[0] = s - (lampsOn ? range.spriteBehind : range.behind);
    farRanges[1] = s + (lampsOn ? range.spriteAhead : range.ahead);
    const t0 = performance.now();
    exactRange[0] = s - range.behind - 10; exactRange[1] = s + range.ahead + 10;
    const cached = current.far.collect(frame.simMs, farRanges, exactRange);
    const t1 = performance.now();
    const eA = s - EXACT_BEHIND_M, eB = s + EXACT_AHEAD_M;
    const exact = current.fleet.place(frame.simMs, eA - EXACT_MARGIN_M, eB + EXACT_MARGIN_M, frame.pose);
    const t2 = performance.now();
    sub.far.add(t1 - t0); sub.exact.add(t2 - t1);
    combined.count = 0;
    let fromExact = 0;
    for (let i = 0; i < cached.count; i++) {
      const sv = cached.s[i];
      if (sv < eA || sv > eB) { copyInto(cached, i); continue; }
      // near the car: the exact pose (and the car's rule); not listed there (hidden, the car's slot): not drawn
      const id = cached.id[i];
      for (let j = 0; j < exact.count; j++) if (exact.id[j] === id) { copyInto(exact, j); fromExact++; break; }
    }
    lampStats.far = cached.count; lampStats.exact = fromExact;
    sub.merge.add(performance.now() - t2);
    placedWindow.s = s;
    placedWindow.range = Math.max(range.ahead, range.behind);
    placedWindow.sA = s - range.behind; placedWindow.sB = s + range.ahead;
    return combined;
  }

  /** Lamps, ribbons and pools for this frame (beforeRender, after the bodies). */
  /** The look's fade of the vehicles' light: look.beams on the classic renderer and display, 1 in the shipped look. */
  const fade = () => (physical ? 1 : look.beams);
  /** Whether the vehicles' lamps are drawn: the look's beams, or in the shipped look the vehicles' own switching. */
  const lampsOn = () => (physical ? vehicleLitShare(ambient) > LIT_SHARE_MIN : look.beams > 0);
  function drawLights(frame) {
    const on = lampsOn() && enabled;
    lampStats.on = on;
    if (!on || !current) { lamps.update({ on: false }); pools.update({ near: null }); current?.ribbons.update({ on: false }); return; }
    const t0 = performance.now();
    const s = frame.pose.s;
    const eye = frame.camera.position;
    const cam = frame.camera;
    const pxPerRad = (frame.viewport?.height || 720) / (2 * Math.tan(((cam.getEffectiveFOV ? cam.getEffectiveFOV() : cam.fov) * Math.PI) / 360));
    lamps.update({ near: null, far: placed, carS: s, ahead: range.spriteAhead, behind: range.spriteBehind, band: SPRITE_BAND, eye, on: true, pxPerRad });
    // classic: scene units per cd/m^2 x the fade; plan 01's: the fade alone (the materials carry the light's scale)
    const gain = legacy ? env.lighting.units.nit * look.beams : fade();
    const visibility = env.weather?.state?.().visibilityM || 80000;
    lamps.setFrame({ camera: frame.camera, renderer: ctx.app.renderer, ...(legacy ? { gain } : { fade: gain }), ambientLux: ambient, visibility });
    current.ribbons.update({
      simMs: frame.simMs, carS: s, ahead: range.spriteAhead, behind: range.spriteBehind, band: SPRITE_BAND,
      camera: frame.camera, renderer: ctx.app.renderer, gain, lit: vehicleLitShare(ambient), visibility, on: true,
    });
    pools.update({ near: placed, eye, ambient, gain, threshold: vehicleThresholdLux });
    timings.lamps.add(performance.now() - t0);
  }

  const part = {
    name: 'traffic',
    setEnabled(v) {
      enabled = !!v;
      renderer.group.visible = enabled;
      if (!enabled) { renderer.clear(); lamps.clear(); pools.clear(); }
    },
    update(frame) {
      if (!enabled) return;
      if (!ensure()) { placed = null; return; }
      const t0 = performance.now();
      followJourney();
      ambient = env?.lighting?.ambientLux ? env.lighting.ambientLux(frame.sun.elevation) : look.ambient;
      rangeFor(frame);
      if (physical) renderer.uniforms.uBrake.value = faceBrake * (1 - vehicleLitShare(ambient)); // stop lamps by day
      placed = placeAll(frame, lampsOn());
      timings.place.add(performance.now() - t0);
    },
    beforeRender(frame) {
      if (!enabled) return;
      // the route's model arrived after the last update (a paused clock moves no pose, so no update follows): place now
      if (!placed && current) part.update(frame);
      if (!placed || !current) { renderer.clear(); lamps.clear(); pools.clear(); return; }
      const t0 = performance.now();
      // the camera turned (looked back, zoomed out) since the placement: place again for the new range
      const ahead = range.ahead, behind = range.behind;
      rangeFor(frame);
      if (range.ahead > ahead * 1.1 || range.behind > behind * 1.1) placed = placeAll(frame, lampsOn());
      else { range.ahead = ahead; range.behind = behind; }
      renderer.draw(placed, frame.camera, frame.viewport?.height || 720, placedWindow);
      timings.draw.add(performance.now() - t0);
      drawLights(frame);
    },
    setLook(lk) {
      const dusk = Math.min(1, Math.max(0, lk.dusk ?? (lk.night ? 1 : 0)));
      if (!physical) renderer.uniforms.uDusk.value = dusk;
      renderer.uniforms.uStrength.value = 0.6 - 0.35 * dusk;
      look.beams = lk.beams ?? dusk;
      look.lights = lk.lights ?? dusk;
      if (Number.isFinite(lk.ambientLux)) look.ambient = lk.ambientLux;
    },
    /** Another route: the other routes' models (their ribbons' geometry) are let go; the journey's is loaded by ensure(). */
    setRoute({ route }) {
      for (const [id, p] of models) {
        if (id === route.id) continue;
        models.delete(id);
        p.then((m) => m?.ribbons.dispose());
        if (id === currentId) { currentId = null; current = null; renderer.clear(); lamps.clear(); pools.clear(); }
      }
    },
    whenSettled: () => loading,
    stats() {
      const f = current?.fleet.stats();
      return {
        route: currentId, ready: !!current, enabled,
        enumerated: f?.enumerated ?? 0, placed: f?.placed ?? 0, gapped: f?.gapped ?? 0,
        car: f ? { refLane: f.refLane, slot: f.carSlot, slotOff: +(f.slotOff || 0).toFixed(3), guard: f.guard } : null,
        ...renderer.stats(),
        range: { ahead: Math.round(range.ahead), behind: Math.round(range.behind), spriteAhead: Math.round(range.spriteAhead), spriteBehind: Math.round(range.spriteBehind) },
        listed: lampStats.far, exact: lampStats.exact,
        renderer: legacy ? 'classic' : 'node', display, detailPx: renderer.detailPx, quality: quality?.level ?? null,
        lamps: { on: lampStats.on, ambientLux: +ambient.toFixed(1), ...lamps.stats(), mergeDist: Math.round(lamps.mergeDist), far: current?.far.stats(), ribbons: current?.ribbons.stats(), ...pools.stats() },
        js: { place: timings.place.summary(), draw: timings.draw.summary(), lamps: timings.lamps.summary(), sub: Object.fromEntries(Object.entries(sub).map(([k, v]) => { const x = v.summary(); return [k, [+x.mean.toFixed(3), +x.p95.toFixed(2)]]; })) },
      };
    },
    lampPoints: () => renderer.lampPoints(),
    placed: () => placed,
    model: () => (current ? { traffic: current.traffic, laneMap: current.laneMap, fleet: current.fleet, reference: current.reference, far: current.far, ribbons: current.ribbons } : null),
    /** The renderer (render.js), for tests and the frame-budget probe. */
    renderer, lamps, pools,
    dispose() {
      offQuality();
      renderer.dispose(); lamps.dispose(); pools.dispose();
      for (const p of models.values()) p.then((m) => m?.ribbons.dispose());
    },
  };
  renderer.group.userData.part = part; // for tests/manual/traffic-shots.mjs, which finds it in the scene
  return part;
}

// A flight in the running app (plan 03, F1.4 and F1.6): loaded the first time Fly is entered (src/flight/index.js),
// it owns the scene objects (world.js: the regional terrain, the airport and the ground under it; the airframe and the
// modelled cabin through view/layers.js), the head rig
// and its input, and the one journey on plan 01's timeline. Each frame (loop order 20, before the environment) it
// samples the track at the journey's progress, places the aircraft and the shared camera, and applies the condensed
// pace through the clock's rate. Everything drawn is a pure function of the progress and the look, so scrubbing back
// to a moment gives the same picture as playing to it.
//
// The airframe is the modelled one (aircraft/airframe.js createModelledAirframe: the stand-in at once, the model when it
// has loaded), posed each frame from the state and a presentation time (wall seconds that run only while the clock
// plays: flashing lights and wing shake, plan 7.5). On the wheels the state itself is turned nose-down by the ground
// attitude before the layers place anything (attitude.js), so the cabin and the camera tilt with the airframe.
import { Vector3, Raycaster } from 'three';
import { loadTrack, createState } from './track.js';
import { flightJourney } from './journey.js';
import { createModelledAirframe } from './aircraft/airframe.js';
import { RIG_URL } from './aircraft/model.js';
import { applyGroundPitch } from './attitude.js';
import { createModelledCabin, windowLuminance, cabinLightLevel } from './cabin/cabin.js';
import { createWindowPane } from './window/index.js';
import { createHeadRig, attachHeadInput, headShake, DEFAULT_LOOK, LIMITS } from './cabin/headRig.js';
import { seat as seatOf, defaultSeat } from './cabin/lopa.js';
import { createFlightLayers } from './view/layers.js';
import { createCabinStage } from './view/cabinStage.js';
import { createFlightWorld } from './world.js';
import { paceRateFor, playStart } from './pace.js';
import { bodyDirection, lookToward } from './lookAt.js';

/** Frames of the mode's own JavaScript time kept for stats(). */
const KEEP = 240;

/**
 * @param {{ app: object, fe: ReturnType<import('./env.js').createFlightEnv>, terrain: object, meta: object, data: string,
 *           onFrame: (s: object) => void, onLook: () => void }} o
 *   terrain: the app's provider; meta: terrain.json; data is the city's data folder (/data/<city>); onFrame runs after
 *   each placed frame, onLook after the head moved
 */
export async function createFlightSession({ app, fe, terrain, meta, data, onFrame, onLook }) {
  const { scene, camera, canvas, settings, city } = app;
  const { clock, loop } = fe;
  const ground = { far: app.terrain?.[0]?.mesh ?? null, near: app.terrain?.[1]?.mesh ?? null };
  const world = await createFlightWorld({ scene, fe, provider: terrain, meta, data, ground, sky: app.sky, settings, renderer: app.renderer });
  const airframe = createModelledAirframe({ nodes: fe.nodes });
  airframe.ready.then(() => fe.invalidate());
  // the ground attitude comes from the same rig.json the model is built from (the model does not hand it out)
  let airRig = null;
  const rigLoad = fetch(RIG_URL).then((r) => (r.ok ? r.json() : null)).then((j) => { airRig = j; fe.invalidate(); }).catch(() => {});
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let seat = defaultSeat('right');
  const cabin = createModelledCabin({ nodes: fe.nodes, seat });
  cabin.ready.then(() => fe.invalidate());
  const rig = createHeadRig({ seat });
  const layers = createFlightLayers({ scene, camera, airframe, cabin, rig, base: city.base });
  // the cabin drawn after the world's anti-aliasing and composed over it (F3.9; view/cabinStage.js)
  const cabinStage = createCabinStage({ renderer: app.renderer, pipeline: fe.pipeline, layers });
  // the window's glass (Phase 5, window/index.js), reading the finished outside picture from the cabin stage
  const pane = createWindowPane({ nodes: fe.nodes, cabin, quality: fe.quality, renderer: app.renderer, pipeline: fe.pipeline, outside: cabinStage.outside });
  pane.ready.then(() => fe.invalidate());
  cabinStage.useOutside(() => pane.enabled && !!pane.mesh);
  const offWeather = fe.onWeather ? fe.onWeather(() => { if (track) { pane.setTrack(track, { airAt: (st) => fe.at(st.position) }); fe.invalidate(); } }) : () => {};
  const offQuality = fe.quality?.on ? fe.quality.on('change', (q) => { pane.setQuality(q.level); fe.invalidate(); }) : () => {};

  const tracks = new Map();
  let track = null, journey = null, handle = null, active = false, pace = true;
  const sample = createState();
  let heightAboveGround = NaN, compiled = false, groundPitch = 0, wallS = 0, stageOff = false;
  const ms = [];

  /** The track of a flight, loaded once (a failed load can be tried again). */
  function trackOf(entry) {
    if (!tracks.has(entry.id)) {
      const p = loadTrack(`${data}/flights/${entry.header || `${entry.id}.json`}`, { frame: fe.frame });
      tracks.set(entry.id, p);
      p.catch(() => tracks.delete(entry.id));
    }
    return tracks.get(entry.id);
  }

  const progress = () => (handle ? handle.progressS : 0);
  /** The aircraft at a progress, turned to its ground attitude when it stands on its wheels. */
  function sampleAt(t, out = createState()) {
    const s = track.sample(t, out);
    groundPitch = applyGroundPitch(s, airRig);
    return s;
  }
  /** Sample the track now and place the aircraft, its moving parts and lights, the cabin, the camera and the world.
   * dtS: wall seconds since the last frame (the shade's travel); 0 outside the frame loop, so a hook moves nothing. */
  function place(dtS = 0) {
    if (!track) return;
    const s = sampleAt(progress(), sample);
    heightAboveGround = s.position.y - world.surfaceY(s.position.x, -s.position.z);
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    const reducedMotion = !!reduce?.matches, night = isNight();
    const shake = headShake(s.t, { touchdown: track.touchdownT }, { reducedMotion });
    layers.update(s, { aspect: w / h, shake });
    cabinStage.setShown(layers.cabinShown && !stageOff);
    airframe.update(s, {
      wallS, reducedMotion, hasLightsChannel: track.meta.channels.includes('lights'),
      night, shake: fe.quality?.level !== 'low', groundPitch: false,
    });
    cabin.update(s, { cabinLight: s.cabinLight ?? 1, night, reducedMotion, dtS, outside: outsideLight(s) });
    // the glass: its reflection is the cabin drawn with the lamps at full, so it is weighted by the lamps' level now
    pane.update(s, { env: fe, wallS, night, reducedMotion, cabinLight: cabinLightLevel(s.cabinLight ?? 1, night) / cabinLightLevel(1, night) });
    world.update({ camera, position: s.position, simMs: clock.timeMs, wallS, night, reducedMotion, visibilityM: fe.at(s.position).visibilityM });
  }
  /** The light that comes in through the windows (the cabin's own light, cabin.js createCabinLight): the window's
   * mean luminance and the Sun, from plan 01's state at the aircraft. */
  const _outside = { windowL: 0, sunLux: 0, sunColor: null, sunWorld: null };
  function outsideLight(s) {
    const sun = fe.state?.sun;
    let L = null;
    try { L = fe.lightAt(s.position); } catch { L = null; }
    const sunLux = L?.sunLux ?? sun?.illuminanceLux ?? 0, ambientLux = L?.ambientLux ?? 0;
    _outside.windowL = windowLuminance({ sunLux, ambientLux, sunAltDeg: sun?.altDeg ?? -90 });
    _outside.sunLux = (sun?.altDeg ?? -90) > -1 ? sunLux : 0;
    _outside.sunColor = L?.sunColor ?? sun?.color ?? null;
    _outside.sunWorld = sun?.dir ?? null;
    return _outside;
  }
  /** Night for the aircraft's lamps, the cabin's tint and the airport's lights: the Sun below the horizon (the
   * airport's lights burn from sunset to sunrise, airport.json lightingSchedule SS-SR). */
  const isNight = () => (fe.state?.sun?.altDeg ?? 90) < 0;

  const sub = {
    update(frame) {
      if (!active || !track) return;
      const t0 = performance.now();
      if (clock.playing) wallS += (frame?.dtWallMs || 0) / 1000; // presentation time: frozen while paused
      const r = paceRateFor({ pace, playing: clock.playing, progressS: progress(), rate: clock.rate }, journey);
      if (r !== null) clock.setRate(r);
      place((frame?.dtWallMs || 0) / 1000);
      onFrame(session);
      ms.push(performance.now() - t0);
      if (ms.length > KEEP) ms.shift();
    },
    // continuous frames while the clock plays the flight, none while paused (the timeline votes the same way)
    demand: () => (active && (clock.playing || pane.settling) ? 'continuous' : 'idle'),
  };
  loop.add(sub, 20);

  const detachInput = attachHeadInput(canvas, rig, {
    onChange: () => { fe.invalidate(); onLook(); },
    onShade: () => { cabin.toggleShade(); fe.invalidate(); },
    enabled: () => active && !(app.dragging && app.dragging()),
  });

  // what blocks a click or a line of sight from the eye: the airframe and the cabin as drawn (the cabin sits on its
  // own layer, which picking's rays do not test)
  const caster = new Raycaster();
  caster.layers.enableAll();
  // the window's glass is in the cabin's group but lets the eye through: never a blocker
  const solid = (o) => { for (let p = o; p; p = p.parent) { if (!p.visible || p === pane.group) return false; } return true; };
  const blockers = () => {
    const list = [];
    for (const g of [airframe.group, cabin.group]) g.traverse((o) => { if (o.isMesh && o.visible && g.visible) list.push(o); });
    return list.filter(solid);
  };
  /** True when the airframe or the cabin is hit before `distance` along `ray`. */
  function blocked(ray, distance) {
    caster.ray.copy(ray);
    caster.near = 0;
    caster.far = distance;
    return caster.intersectObjects(blockers(), false).length > 0;
  }

  /** True when the cabin (not the airframe) stands between the eye and a scene point. */
  function cabinBlocks(point) {
    place();
    if (!cabin.group.visible) return false;
    const d = point.clone().sub(camera.position), dist = d.length();
    caster.ray.origin.copy(camera.position);
    caster.ray.direction.copy(d.normalize());
    caster.near = 0;
    caster.far = dist;
    const parts = [];
    cabin.group.traverse((o) => { if (o.isMesh && o.visible && solid(o)) parts.push(o); });
    return caster.intersectObjects(parts, false).length > 0;
  }

  const _p = new Vector3(), _pose = { eye: new Vector3(), quaternion: new (camera.quaternion.constructor)() };
  /** The scene point of a removable building at a fraction of its height. */
  const anchor = (entry, k, out = new Vector3()) => {
    const b = entry.data;
    return out.set(b.c[0], b.ground - city.base + b.h * k, -b.c[1]).add(entry.offset);
  };

  const session = {
    rig, layers, world, airframe,
    cabin, cabinStage, pane,
    get seat() { return seat; },
    get track() { return track; },
    get journey() { return journey; },
    get handle() { return handle; },
    get active() { return active; },
    get pace() { return pace; },
    get heightAboveGround() { return heightAboveGround; },
    get progressS() { return progress(); },
    /** The ground attitude applied to the last sample, radians (0 in the air). */
    get groundPitch() { return groundPitch; },
    sampleAt,
    trackOf,

    /** Change seat (by id such as '23F', or the default for a side): the cabin re-placed round it; the look is kept. */
    setSeat(id) {
      const next = typeof id === 'string' ? seatOf(id) : defaultSeat(id?.side || 'right');
      if (next.id === seat.id) return seat;
      seat = next;
      cabin.setSeat(seat);
      pane.setSeat(seat);
      rig.setSeat(seat);
      fe.invalidate();
      return seat;
    },

    /** Begin a flight on the timeline at its recorded start (so the Sun is where it was), at `at` seconds in. */
    async begin(entry, { at, startMs } = {}) {
      const t = await trackOf(entry);
      if (handle) fe.attachJourney(null);
      track = t;
      // the pane's frost, fog and water over the journey, from the air along it (again when the weather changes)
      pane.setTrack(track, { airAt: (st) => fe.at(st.position) });
      journey = flightJourney(track, () => {}); // the frame samples the track itself, at the same progress
      handle = fe.attachJourney(journey);
      if (Number.isFinite(startMs) && Math.abs(startMs - journey.recordedStartMs) > 1000) handle.setStart(startMs);
      handle.seek(Number.isFinite(at) ? at : playStart(track));
      // the grids the first frame needs, coarsest first, while the fade is still black
      const s0 = track.sample(progress());
      world.preload({ x: s0.position.x, y: -s0.position.z, altitude: s0.altMsl, far: Infinity }).catch(() => {});
      return track;
    },
    /** End the journey (the transport bar hides). */
    end() {
      if (handle) fe.attachJourney(null);
      handle = null;
    },
    /** Into the scene (the camera is taken, saved first) or out of it (the camera is given back exactly). */
    show(on) {
      if (on === active) return;
      active = !!on;
      world.show(active);
      cabinStage.setStaged(active);
      if (active) { layers.attach(); place(); } else { layers.detach(); cabinStage.setShown(false); }
      fe.invalidate();
    },
    setPace(on) { pace = !!on; fe.invalidate(); },
    seek(t) { if (handle) { handle.seek(t); place(); fe.invalidate(); } },
    look(l) { rig.look(l || {}); fe.invalidate(); },
    resetLook() { rig.reset(); fe.invalidate(); },
    cleanView(on) { const c = layers.cleanView(on); cabinStage.setShown(layers.cabinShown && !stageOff); fe.invalidate(); return c; },
    /** For measurements only: the cabin stage idle (no cabin, no glass) with the eye where it is. */
    setStageOff(on) { stageOff = !!on; cabinStage.setShown(layers.cabinShown && !stageOff); fe.invalidate(); },
    place,
    blocked,

    /** Turn the head to a removable building if this seat can see it; returns the look and where the building is. */
    lookAt(entry) {
      if (!track) return null;
      const s = sampleAt(progress());
      anchor(entry, 0.6, _p);
      let l = null;
      // the eye turns about a pivot behind it, so a second pass from the turned eye lands on the building
      const before = rig.state;
      for (let k = 0; k < 2; k++) {
        rig.pose({ clean: layers.clean }, _pose);
        l = lookToward(seat, bodyDirection(s, _pose.eye, _p));
        if (!l.inView) break;
        rig.look({ yaw: l.yaw, pitch: l.pitch });
      }
      // the head can face it, but the window's reveal may still stand between: lean to the pane, as people do to see
      // further ahead or behind, and if the wall is still in the way the seat cannot see it
      if (l.inView && cabinBlocks(_p)) {
        rig.look({ lean: LIMITS.leanIn });
        rig.pose({ clean: layers.clean }, _pose);
        const leaned = lookToward(seat, bodyDirection(s, _pose.eye, _p));
        if (leaned.inView) rig.look({ yaw: leaned.yaw, pitch: leaned.pitch });
        if (!leaned.inView || cabinBlocks(_p)) {
          rig.look(before);
          l = { ...l, inView: false, where: l.yaw >= 0 ? 'ahead' : 'behind' };
        } else l = leaned;
      }
      fe.invalidate();
      return l;
    },
    /** A line of sight from the eye through the window to the building's top: the head can face it, nothing of the aircraft is in the way. */
    visible(entry) {
      if (!track || !entry || !entry.mesh.visible) return false;
      place();
      const s = sample;
      anchor(entry, 0.97, _p);
      rig.pose({ clean: layers.clean }, _pose);
      if (!lookToward(seat, bodyDirection(s, _pose.eye, _p)).inView) return false;
      const d = _p.clone().sub(camera.position), dist = d.length();
      caster.ray.origin.copy(camera.position);
      caster.ray.direction.copy(d.normalize());
      return !blocked(caster.ray, dist);
    },
    /** A scene point on the screen, and whether the window shows it. */
    project(x, y, z) {
      place();
      const p = new Vector3(x, y, z), v = p.clone().project(camera);
      const r = canvas.getBoundingClientRect();
      const onScreen = v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
      const d = p.clone().sub(camera.position), dist = d.length();
      caster.ray.origin.copy(camera.position);
      caster.ray.direction.copy(d.normalize());
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, onScreen, throughWindow: onScreen && !blocked(caster.ray, dist) };
    },
    /** Scene Y of the ground the aircraft stands on, as drawn (world.js surfaceY). */
    groundY: (x, n) => world.surfaceY(x, n),
    /** Resolves once the ground is in and a frame has been drawn since. */
    async whenSettled() {
      // the ground (place() asks for the grids this view needs), and the plan's own assets: the modelled airframe, its
      // rig and the modelled cabin (a failed load leaves the stand-in)
      if (active) place();
      await Promise.all([world.whenSettled(), airframe.ready, cabin.ready, rigLoad]);
      if (active) place();
      await world.whenSettled();
      // the first time, the new materials (the wide ground, the aircraft) are compiled before the frame is waited for
      // (at most 8 s: it is only a head start, and under load it has been seen not to settle)
      if (!compiled && app.renderer.compileAsync) {
        compiled = true;
        const cap = new Promise((r) => setTimeout(r, 8000));
        try { await Promise.race([app.renderer.compileAsync(scene, camera), cap]); } catch { /* drawn on demand anyway */ }
      }
      const n = loop.frames;
      fe.invalidate();
      const deadline = performance.now() + 20000;
      while (loop.frames <= n + 1 && performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(r));
        if (loop.frames <= n + 1) fe.invalidate();
      }
    },
    stats() {
      const info = app.renderer.info?.render || {};
      const sorted = [...ms].sort((a, b) => a - b);
      const q = (k) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(k * sorted.length))] : 0);
      return {
        drawCalls: info.calls ?? info.drawCalls ?? null, triangles: info.triangles ?? null, lightPoints: 0,
        layerMs: { mean: ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length), p50: q(0.5), p95: q(0.95), frames: ms.length },
        aircraftTriangles: airframe.triangles + cabin.triangles, airframeModel: !!airframe.model, cabinModel: !!cabin.model,
        cabinDrawCalls: cabin.drawCalls, shade: cabin.shade, world: world.stats(), cabinStage: cabinStage.stats(),
        pane: pane.stats(),
        cabinLight: cabin.light ? { level: cabin.light.level, night: cabin.light.night, windowL: +_outside.windowL.toPrecision(4), sunLux: Math.round(_outside.sunLux) } : null,
      };
    },
    dispose() { detachInput(); offWeather(); offQuality(); pane.dispose(); cabinStage.dispose(); },
    DEFAULT_LOOK,
  };
  return session;
}

// Drive mode's entry point, joined to the app by one call in main.js (initDrive) and the `app.drive` seam.
// This module is light: the mode switch, the address, the test hooks, and handing the app's camera
// between the map and the drive. The drive itself (session.js and everything it imports) is loaded,
// downloaded and built only the first time Drive is entered.
//
// The seam (lines marked "drive seam" in main.js, interaction/edits.js, interaction/focus.js, app/sim.js and
// ui/skyPopover.js): while app.drive.active the frame loop leaves the map controls and the camera glide alone and
// skips the viewpoint snapshots, and skips the pipeline's draw while seam.holding() (a route switch keeps the last
// frame); removable buildings are painted in their natural colours; focusOn calls seam.focus; #sky's keys and a drive
// link's ?t= are the drive's. The session itself is a subsystem of plan 01's frame loop and the pipeline draws
// (session.js). Drive is not offered on the map's classic renderer (?renderer=legacy).

import { createTerrain } from '../world/terrain/index.js';
import { decodeDriveState, encodeDriveState, clearDriveState } from './url.js';
import { createRouteBar } from './ui/routebar.js';
import { createRouteCards } from './ui/routecard.js';
import { createTimePop } from './ui/timepop.js';
import { createViewPop } from './ui/viewpop.js';
import { stepRate, atLocalMinutes } from './ui/format.js';
import { attachInput } from './input.js';
import { saveMapPipeline } from './mapPipeline.js';

/** The first-visit hint while driving (main.js keeps its own text for the map). */
const DRIVE_HINT = 'Drag to look around. Scroll to zoom. Space to pause.';
/** At most one address write a second while the clock plays. */
const WRITE_EVERY_MS = 1000;
/** The drive's own options (Reduce motion), kept per browser. */
const OPTIONS_KEY = 'slc-skyline-drive';
/** Local minutes past midnight of the time-of-day jumps. */
const NOON = 12 * 60, NIGHT = 3 * 60;

/**
 * What the drive takes from the app (src/app/context.js and the modules that add to it), as one object.
 * @param {object} app  the shared application context, with the city, terrain and buildings loaded
 * @param {{ terrainData: { meta: object, near: ArrayBuffer, far: ArrayBuffer } }} loaded  terrain.json and the grids main.js downloaded
 */
function contextOf(app, { terrainData }) {
  const { city, cityId, scene, camera, controls, renderer, canvas, settings, invalidate, sky, terrain, tall, events } = app;
  return {
    city, cityId, DATA: `/data/${cityId}`, scene, camera, controls, renderer, canvas, settings, invalidate, tall,
    /** plan 01's contract (section 11): the clock, the timeline, the environment, quality, the pipeline, the loop */
    plan01: { clock: app.clock, timeline: app.timeline, env: app.env, quality: app.quality, pipeline: app.pipeline, loop: app.loop, weather: () => app.loadWeather?.() ?? null }, // weather: plan 01's weather service, loaded on demand (the drive's weather, decision 9)
    /** the app's event bus (src/app/events.js): 'buildings:changed' after a hide, show or move, 'buildings:rebuilt' */
    events,
    /** { active, focus, holding }: the seam main.js reads (see the top of this file) */
    seam: app.drive,
    applyNight: () => sky.apply({ night: settings.night, imagery: settings.imagery, terrain }),
    repaint: () => tall.forEach(app.paint),
    resize: () => app.views.resize(),
    stopFlight: () => app.stopFlight(),
    showToast: (text, undoable) => app.showToast(text, undoable),
    getLow: () => app.buildings.low,
    sky: sky.dome,
    ground: [[terrain[0].mesh, 'far'], [terrain[1].mesh, 'near']],
    terrainMeta: terrainData.meta, buffers: { near: terrainData.near, far: terrainData.far },
  };
}

/**
 * @param {object} app  the shared application context (see contextOf)
 * @param {{ terrainData: object }} loaded
 */
export function initDrive(app, loaded) {
  const ctx = contextOf(app, loaded);
  const { city, DATA, camera, controls, canvas, settings, seam, invalidate, plan01 } = ctx;
  const terrain = createTerrain({
    meta: ctx.terrainMeta, buffers: ctx.buffers, base: city.base,
    fetchBinary: async (file) => {
      const r = await fetch(`${DATA}/${file}`);
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return r.arrayBuffer();
    },
  });
  const hooks = window.__skyline || (window.__skyline = {});
  hooks.terrain = { whenSettled: terrain.whenSettled, stats: terrain.stats, heightAt: terrain.heightAt, groundY: terrain.groundY, surfaceAt: terrain.surfaceAt, surfaceY: terrain.surfaceY };

  const routes = city.routes || [];
  const modes = document.getElementById('modes');
  // the drive's materials are node materials: on the map's classic renderer (?renderer=legacy, until plan 01's phase 3
  // deletes it) Drive is not offered, and a drive link opens the map
  const classic = app.rendererKind !== 'webgpu';
  if (!routes.length || classic) {
    if (classic && routes.length && new URLSearchParams(location.search).get('mode') === 'drive') {
      console.info('Drive mode needs the default renderer: ?mode=drive is ignored on the classic one.');
    }
    const none = () => Promise.reject(new Error(classic ? 'Drive mode is not offered on the classic renderer' : `${city.name} has no drive routes`));
    hooks.drive = { start: none, whenSettled: none, active: () => false, exit() {}, pose: () => null, stats: () => null, visible: () => false };
    return hooks.drive;
  }
  const about = document.getElementById('about');
  about.textContent = about.textContent.replace('footprints from OpenStreetMap.', 'footprints and road geometry from OpenStreetMap.');

  const el = {
    views: document.querySelector('.views'), night: document.getElementById('night'), sky: document.getElementById('sky-toggle'), hint: document.getElementById('hint'),
    compass: document.getElementById('compass'), tools: document.getElementById('tools'), transport: document.getElementById('transport'),
  };
  const tz = city.tz || 'UTC';
  const units = () => settings.units;
  const hintText = el.hint.querySelector('span');
  const mapHint = hintText.textContent;
  const bar = createRouteBar({ dock: document.getElementById('dock'), tz, units, onToggle: toggle, onRate: rate, onLock: lock, onSeek: seekS });
  const cards = createRouteCards({ parent: document.getElementById('top'), routes, units, onStart: chooseStart, onRoute: chooseRoute });
  // routes.json (facts and outlines for every card), fetched the first time Drive is entered and handed to the session
  let routesDoc = null;
  function loadRoutesDoc() {
    if (!routesDoc) {
      routesDoc = fetch(`${DATA}/routes.json`).then((r) => { if (!r.ok) throw new Error(`routes.json: HTTP ${r.status}`); return r.json(); });
      routesDoc.then((doc) => {
        for (const r of doc.routes || []) {
          cards.setInfo(r.id, { length: r.length ?? r.s1 - r.s0, postedSeconds: r.postedSeconds, s0: r.s0, s1: r.s1, reveal: r.reveal, outline: r.outline });
        }
      }, () => { routesDoc = null; });
    }
    return routesDoc;
  }
  const timePop = createTimePop({
    button: bar.time, tz, onTime, onJump,
    state: () => ({ simMs: session ? session.clock.now() : Date.now(), locked: !!session?.locked }),
  });
  let session = null, loadingSession = null, mapState = null, wasPlaying = true, entering = 0, shownRoute = null, lastWrite = 0;
  let routeId = routes[0].id; // the route the drive remembers for this visit
  let view = 'cabin'; // cabin (the default) or clean, kept across sessions of this visit

  // Reduce motion: the system's setting, unless the visitor chose otherwise in the drive's view popover
  const systemReduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const readOptions = () => { try { return JSON.parse(localStorage.getItem(OPTIONS_KEY)) || {}; } catch { return {}; } };
  const reduceMotion = () => {
    const o = readOptions();
    return typeof o.reduceMotion === 'boolean' ? o.reduceMotion : !!systemReduce?.matches;
  };
  function setReduceMotion(on) {
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...readOptions(), reduceMotion: !!on })); } catch { /* this visit only */ }
    session?.rig.setReduceMotion(!!on);
    invalidate();
  }
  systemReduce?.addEventListener?.('change', () => { session?.rig.setReduceMotion(reduceMotion()); invalidate(); });
  const viewPop = createViewPop({
    button: bar.view, onView: setView, onReduceMotion: setReduceMotion,
    onGlance: (name) => { if (session) { session.rig.glance(name); invalidate(); } },
    state: () => ({ view, reduceMotion: session ? session.rig.reduceMotion : reduceMotion() }),
  });

  attachInput({
    canvas, controls, tools: el.tools, invalidate, onToggle: toggle, active: () => seam.active, session: () => session,
    onLook: writeAddress, onSeekBy: (sec) => { session.seekBy(sec); writeAddress(); }, onRate: rate,
    onView: () => setView(view === 'cabin' ? 'clean' : 'cabin'),
  });

  // ---------------------------------------------------------------- mode switch
  modes.hidden = false;
  const modeBtns = [...modes.querySelectorAll('button')];
  const showMode = (mode) => modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  for (const b of modeBtns) {
    b.addEventListener('click', () => {
      b.blur(); // Space plays and pauses while driving; it must not press this button again
      if (b.dataset.mode === 'drive') enter(routeId).catch(() => {}); else exit();
    });
  }

  // the search box takes the corner the open picker uses: opening it folds the picker
  document.getElementById('search')?.addEventListener('focus', () => cards.dismiss());

  // ---------------------------------------------------------------- the controls
  /** Cabin or clean. Neither the pose nor the simulation time changes: only the camera does. */
  function setView(v) {
    if (v !== 'cabin' && v !== 'clean') return;
    view = v;
    session?.rig.setView(v);
    viewPop.update({ view, reduceMotion: session ? session.rig.reduceMotion : reduceMotion() });
    writeAddress();
    invalidate();
  }
  function toggle() {
    if (!session?.journey) return;
    // from the end of the route, play drives it again from the chosen start
    if (session.arrived) { session.restart(); session.clock.play(); }
    else if (session.clock.playing) session.clock.pause();
    else session.clock.play();
    writeAddress();
    invalidate();
  }
  function rate(dir) {
    if (!session) return;
    session.setRate(stepRate(session.clock.rate, dir));
    invalidate();
  }
  function lock() {
    if (!session) return;
    session.setLocked(!session.locked);
    writeAddress();
    invalidate();
  }
  /** The thumb moved the car; the clock follows by the journey's time-distance function. */
  function seekS(s, done) {
    if (!session?.journey) return;
    session.seek({ s }); // asks for a frame once the road there is in
    if (done) writeAddress();
  }
  /** The time-of-day slider: obeys the lock. */
  function onTime(minutes, done) {
    if (!session?.journey) return;
    session.setTime(atLocalMinutes(session.clock.now(), tz, minutes));
    if (done) writeAddress();
  }
  /** Dusk, Noon and Night keep the car where it is, lock or no lock. */
  function onJump(which) {
    if (!session?.pose) return;
    const now = session.clock.now();
    const t = which === 'dusk' ? session.duskAt() : atLocalMinutes(now, tz, which === 'noon' ? NOON : NIGHT);
    session.keepPlace(t);
    writeAddress();
  }
  /** A route card: that route, from its default start at its default moment, at once (also while driving). */
  function chooseRoute(id) {
    enter(id, { route: true }).catch(() => {});
  }
  /** A start chip: the car goes there at that start's default moment, then plays once the road is in. */
  async function chooseStart(key, id = routeId) {
    if (id !== routeId || !session || session.route !== id) { enter(id, { route: true, startKey: key }).catch(() => {}); return; }
    if (!session?.journey || !seam.active) return;
    const token = ++entering;
    session.clock.pause();
    session.startFrom(key);
    writeAddress();
    invalidate();
    cards.setLoading(true);
    try {
      await session.whenSettled();
    } finally {
      if (token === entering) cards.setLoading(false);
    }
    if (token !== entering || !seam.active) return;
    session.clock.play();
    writeAddress();
  }
  /** Give the bar and the card the route the journey drives, once per route. */
  function showRoute() {
    const j = session.journey;
    if (shownRoute === j.route.id) return;
    shownRoute = j.route.id;
    let road = null;
    try { road = session.net.roadOf(j.route); } catch { /* no map, the rest still works */ }
    const r = { s0: j.s0, s1: j.s1, markers: j.markers, reveal: j.reveal, to: j.route.to };
    bar.setRoute(r);
    cards.setRoute(j.route.id, { ...r, road, length: j.length, postedSeconds: j.route.postedSeconds ?? j.duration / 1000 });
  }

  // ---------------------------------------------------------------- the address
  function writeAddress() {
    if (!session?.journey) return;
    const { rig } = session;
    const p = seam.active
      ? encodeDriveState({ route: routeId, s: session.pose?.s, t: session.clock.now(), view: rig.view, yaw: rig.yaw, pitch: rig.pitch, lens: rig.lens }, location.search)
      : clearDriveState(location.search);
    const q = p.toString();
    lastWrite = performance.now();
    const next = q ? `?${q}` : location.pathname;
    if (next !== location.search) history.replaceState(history.state, '', next);
  }

  // ---------------------------------------------------------------- the camera, handed between map and drive
  function saveMap() {
    mapState = {
      position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(),
      fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect, zoom: camera.zoom,
      target: controls.target.clone(), enabled: controls.enabled, width: innerWidth, height: innerHeight,
      skyPosition: ctx.sky.position.clone(), compass: el.compass.firstElementChild.style.rotate,
      compassTitle: el.compass.title,
    };
  }
  function restoreMap() {
    const m = mapState;
    camera.position.copy(m.position); camera.quaternion.copy(m.quaternion); camera.up.copy(m.up);
    Object.assign(camera, { fov: m.fov, near: m.near, far: m.far, aspect: m.aspect, zoom: m.zoom });
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    controls.target.copy(m.target);
    controls.enabled = m.enabled;
    ctx.sky.position.copy(m.skyPosition);
    el.compass.firstElementChild.style.rotate = m.compass;
    setCompassTitle(m.compassTitle);
    hintText.textContent = mapHint;
    // the window changed shape while driving: let the map fit its lens to it, as it always does
    if (innerWidth !== m.width || innerHeight !== m.height) ctx.resize();
  }
  function setCompassTitle(text) { el.compass.title = text; el.compass.setAttribute('aria-label', text); }

  // ---------------------------------------------------------------- the map's clock, handed to the drive
  // One clock (decision 4): the drive runs on app.clock. Entering Drive saves what the map had (pinned or the clock
  // state, the time, the rate, playing) and enters the clock state (decision 5); leaving puts it back.
  let mapClock = null, driveRate = 1; // the drive's own rate on the shared clock, kept across sessions of this visit
  // the drive's moment when the visitor left for Map: leaving gives the shared clock back to the map, so coming back
  // seeks it again
  let driveMoment = null;
  function saveMapClock() {
    if (mapClock) return;
    const { clock, env } = plan01;
    mapClock = { mode: env.mode, night: !!settings.night, timeMs: clock.timeMs, rate: clock.rate, playing: clock.playing, live: clock.live, frozen: env.frozen };
  }
  // The map's pipeline, as the clock: noted before the drive first adds a stage (its parts add theirs as the session
  // loads), put back on leaving (mapPipeline.js)
  let restoreMapPipeline = null;
  function saveMapLook() {
    saveMapClock();
    restoreMapPipeline ||= saveMapPipeline(plan01.pipeline);
  }
  function restoreMapLook() {
    restoreMapClock();
    restoreMapPipeline?.();
    restoreMapPipeline = null;
  }
  function restoreMapClock() {
    if (!mapClock) return;
    const { clock, env } = plan01;
    const m = mapClock;
    mapClock = null;
    clock.pause();
    if (m.live) clock.goLive();
    else {
      clock.set(m.timeMs);
      if (clock.rate !== m.rate) clock.setRate(m.rate);
    }
    if (m.mode === 'pinned') { env.pin(m.night); return; } // pinning pauses the clock, as the map had it
    if (m.playing && !m.live) clock.play();
  }

  // ---------------------------------------------------------------- entering and leaving
  /** Load the drive the first time (on route `id`); a failed download shows one toast and leaves the app in Map. */
  function load(id) {
    if (session) return Promise.resolve(session);
    if (!loadingSession) {
      const doc = loadRoutesDoc().catch(() => null);
      loadingSession = Promise.all([import('./session.js'), doc])
        .then(([{ createSession }, d]) => createSession(ctx, terrain, { onFrame }, { route: id, routesDoc: d || undefined }))
        .then((s) => (session = s))
        .catch((err) => { loadingSession = null; throw err; });
    }
    return loadingSession;
  }

  /**
   * Enter Drive on a route, or switch to another route while driving. Resolves once the first frame is settled;
   * the clock then plays, unless it was paused when the visitor last left Drive or the address named a moment
   * (a shared link opens paused on it). Another route (or `route: true`, a card chosen) starts at that route's
   * default start and moment, or at the start chip `startKey`.
   * @param {string} id
   * @param {{ s?: number, t?: number, view?: string, yaw?: number, pitch?: number, lens?: number, route?: boolean, startKey?: string }} [at]
   */
  async function enter(id, at = {}) {
    const token = ++entering;
    if (!seam.active) saveMapLook();
    const switching = seam.active && !!session && id !== session.route;
    showMode('drive');
    bar.show(true);
    if (!seam.active) cards.show(true); // entering from Map: the routes show while the drive loads
    cards.setRoute(id);
    cards.setLoading(true);
    timePop.open(false);
    viewPop.open(false);
    bar.setStatus(!session ? 'Loading the drive…' : switching || (session.route !== id) ? 'Loading the route…' : null);
    loadRoutesDoc().catch(() => {});
    try {
      await load(id);
    } catch (err) {
      if (token === entering) {
        bar.show(false);
        cards.show(false);
        cards.setLoading(false);
        showMode('map');
        if (!seam.active) restoreMapLook();
        ctx.showToast('The drive could not be loaded.', false);
      }
      console.warn('Drive mode failed to load.', err);
      throw err;
    }
    if (token !== entering) return; // the visitor went back to Map while it loaded
    const fresh = !session.journey || id !== routeId || id !== session.route || at.route || Number.isFinite(at.s) || Number.isFinite(at.t);
    routeId = id;
    if (fresh) {
      if (session.route !== id) session.clock.pause();
      try {
        await session.configure(id, at);
      } catch (err) {
        if (token === entering) {
          cards.setLoading(false);
          bar.setStatus(null);
          routeId = session.route;
          cards.setRoute(routeId);
          ctx.showToast('That route could not be loaded.', false);
        }
        console.warn(`Drive route ${id} failed to load.`, err);
        throw err;
      }
      if (token !== entering) return; // another route or Map was chosen meanwhile
      if (at.startKey) session.startFrom(at.startKey);
    }
    showRoute();
    if (at.view === 'cabin' || at.view === 'clean') view = at.view;
    session.rig.setView(view).setReduceMotion(reduceMotion());
    session.rig.look({ yaw: at.yaw, pitch: at.pitch, lens: at.lens });
    if (!seam.active) activate();
    session.clock.pause();
    if (!fresh && driveMoment !== null) session.seek({ t: driveMoment }); // back from Map: where the drive was
    driveMoment = null;
    writeAddress();
    bar.setStatus('Loading the road…');
    try {
      await session.whenSettled();
    } finally {
      if (token === entering) cards.setLoading(false);
    }
    if (token !== entering || !seam.active) return;
    bar.setStatus(null);
    cards.underway(); // the drive is under way: the picker folds to its chip
    if (!Number.isFinite(at.t) && (fresh || wasPlaying)) session.clock.play();
    writeAddress();
  }

  function activate() {
    ctx.stopFlight();
    saveMap();
    controls.enabled = false;
    // the session is a subsystem of the frame loop and the pipeline draws (session.js attach)
    seam.holding = () => session.holding;
    plan01.env.enterClock();
    plan01.quality?.hold?.(true); // a change of level while driving breaks the WebGPU frame (plan 02): the scale may still change
    session.setRate(driveRate); // the map's rate (60x, say) is the map's
    if (el.transport) el.transport.style.display = 'none'; // the drive's bar is the transport while driving
    seam.focus = (entry) => {
      const b = entry.data;
      session.lookAt(entry.offset.clone().set(b.c[0], b.ground - city.base + b.h * 0.6, -b.c[1]).add(entry.offset));
    };
    seam.active = true;
    el.views.hidden = true;
    el.night.hidden = true;
    if (el.sky) el.sky.hidden = true; // the map's time of day: the drive's bar sets it while driving
    hintText.textContent = DRIVE_HINT;
    setCompassTitle('Look ahead');
    document.body.classList.add('driving');
    ctx.repaint();
    session.show(true);
    invalidate();
  }

  function exit() {
    entering++;
    showMode('map');
    bar.show(false);
    cards.show(false);
    cards.setLoading(false);
    timePop.open(false);
    viewPop.open(false);
    if (!seam.active) return;
    wasPlaying = session.clock.playing;
    driveRate = session.clock.rate;
    driveMoment = session.clock.now();
    session.clock.pause();
    seam.active = false;
    seam.focus = seam.holding = null;
    session.show(false);
    restoreMapLook();
    plan01.quality?.hold?.(false); // a level chosen while driving applies now
    if (el.transport) el.transport.style.display = '';
    ctx.applyNight();
    ctx.repaint();
    document.documentElement.dataset.theme = settings.night ? 'dark' : 'light';
    el.views.hidden = false;
    el.night.hidden = false;
    if (el.sky) el.sky.hidden = false;
    document.body.classList.remove('driving');
    restoreMap();
    writeAddress();
    invalidate();
  }

  let compassDeg = null;
  function onFrame(s) {
    const st = {
      playing: s.clock.playing, simMs: s.clock.now(), speed: s.pose ? s.pose.speed : 0, s: s.pose?.s,
      rate: s.clock.rate, locked: s.locked, arrived: s.arrived, startKey: s.startKey,
    };
    bar.update(st);
    cards.update(st);
    timePop.update(st);
    if (st.playing && performance.now() - lastWrite > WRITE_EVERY_MS) writeAddress();
    // the compass needle shows north for the way the eye looks, as it does for the map camera
    const e = camera.matrixWorld.elements; // column 2 is the camera's backward axis
    const deg = Math.round((Math.atan2(e[8], e[10]) * 180) / Math.PI);
    if (deg !== compassDeg) { compassDeg = deg; el.compass.firstElementChild.style.rotate = `${deg}deg`; }
  }

  // ---------------------------------------------------------------- hooks (plan 02, section 5.12)
  const need = () => { if (!session || !seam.active) throw new Error('Drive is not active'); return session; };
  hooks.drive = {
    /** Enter Drive on a route; resolves when the first frame is settled. */
    start: (id = routeId, { s, t, view: v } = {}) => enter(id, { s, t, view: v }),
    /** 'cabin' or 'clean'; changes neither the pose nor the simulation time. */
    setView(v) { need(); if (v !== 'cabin' && v !== 'clean') throw new Error(`no view "${v}" (cabin, clean)`); setView(v); },
    view: () => view,
    /** Reduce motion on or off (stored as the drive's own option, as the view popover does). */
    setReduceMotion(on) { need(); setReduceMotion(on); viewPop.update({ view, reduceMotion: !!on }); },
    /** A glance: 'ahead', 'left', 'right' or 'center' (the keys 1 to 4). */
    glance(name) { need().rig.glance(name); invalidate(); },
    /** The cabin part: { model, readout, mirrors, windshield, cabinScene, cabinCamera, ... }, or null without it. */
    cabin: () => (session ? session.part('cabin') : null),
    /** The camera's offset from the path, in the path's frame (right, up, forward), metres. */
    eyeOffset() {
      const sn = need(), p = sn.pose, e = sn.poseNumbers().eye; // the eye for this pose and moment, as the next frame draws it
      const d = { x: e.x - p.position.x, y: e.y - p.position.y, z: e.z - p.position.z };
      const dot = (v) => d.x * v.x + d.y * v.y + d.z * v.z;
      return { right: dot(p.right), up: dot(p.up), forward: dot(p.forward) };
    },
    exit,
    seek(at) { need().seek(at); writeAddress(); },
    play() { need().clock.play(); invalidate(); },
    pause() { need().clock.pause(); writeAddress(); invalidate(); },
    look(l) { need().rig.look(l || {}); writeAddress(); invalidate(); },
    /** Turn the head toward a removable building (its id, as in window.__skyline.tall), as the list's focus does. */
    lookAtBuilding(id) {
      const sn = need(), entry = (ctx.tall || []).find((e) => e.data.id === id);
      if (!entry) throw new Error(`no removable building "${id}"`);
      seam.focus(entry);
      writeAddress();
      return { yaw: sn.rig.yaw, pitch: sn.rig.pitch };
    },
    pose: () => (session && seam.active ? session.poseNumbers() : null),
    whenSettled: () => need().whenSettled(),
    /** The parts not settled within `ms` (default 0), by name: for a script that timed out on whenSettled. */
    unsettled: (ms) => need().unsettled(ms),
    /** Draw the current frame once, now, through the pipeline (the parts' beforeRender and afterRender around it); for probes. */
    renderFrame() { need(); plan01.pipeline.render(); },
    /** The render scale's state: plan 01's quality governor owns it (decision 8), so this only reports it. */
    renderScale() { return need().stats().renderScale; },
    visible: (targetId) => need().visible(targetId),
    stats: () => (session ? { ...session.stats(), active: seam.active } : null),
    active: () => seam.active,
    route: () => (session?.journey ? { ...session.journey.route } : null),
    /** Open (true) or collapse (false) the route picker; toggle without an argument. */
    picker(open) { cards.setOpen(open === undefined ? !cards.state.open : !!open); },
    /** { shown, open, loading, current }: the route picker's state. */
    pickerState: () => cards.state,
  };

  // ?mode=drive opens straight into the drive
  const state = decodeDriveState(location.search);
  if (state.drive) {
    const id = routes.some((r) => r.id === state.route) ? state.route : routes[0].id;
    enter(id, state).catch(() => writeAddress());
  }
  return hooks.drive;
}

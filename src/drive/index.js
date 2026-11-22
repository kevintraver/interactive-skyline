// Drive mode's entry point, joined to the app by one call in main.js (initDrive) and the `app.drive` seam.
// This module is light: the mode switch, the address, the test hooks, and handing the app's camera
// between the map and the drive. The drive itself (session.js and everything it imports) is loaded,
// downloaded and built only the first time Drive is entered.
//
// The seam (lines marked "drive seam" in main.js, interaction/edits.js, interaction/focus.js and
// ui/settingsPanel.js): while app.drive.active the frame loop calls seam.frame instead of the map
// controls and the camera glide, skips the viewpoint snapshots and calls seam.render instead of
// drawing the scene itself; removable buildings are painted in their natural colours; seam.night,
// when not null, is the look the sky and the interface show instead of the saved setting
// (app.nightNow()); focusOn calls seam.focus.

import { createTerrain } from '../world/terrain/index.js';
import { decodeDriveState, encodeDriveState, clearDriveState } from './url.js';
import { createRouteBar } from './ui/routebar.js';
import { createRouteCards } from './ui/routecard.js';
import { createTimePop } from './ui/timepop.js';
import { createViewPop } from './ui/viewpop.js';
import { stepRate, atLocalMinutes } from './ui/format.js';
import { attachInput } from './input.js';

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
  const { city, cityId, scene, camera, controls, renderer, canvas, settings, invalidate, sky, terrain, tall } = app;
  return {
    city, cityId, DATA: `/data/${cityId}`, scene, camera, controls, renderer, canvas, settings, invalidate, tall,
    /** { active, night, frame, render, focus }: the seam main.js reads (see the top of this file) */
    seam: app.drive,
    applyNight: () => sky.apply({ night: app.nightNow(), imagery: settings.imagery, terrain }),
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
  const { city, DATA, camera, controls, canvas, settings, seam, invalidate } = ctx;
  const terrain = createTerrain({
    meta: ctx.terrainMeta, buffers: ctx.buffers, base: city.base,
    fetchBinary: async (file) => {
      const r = await fetch(`${DATA}/${file}`);
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return r.arrayBuffer();
    },
  });
  const hooks = window.__skyline || (window.__skyline = {});
  hooks.terrain = { whenSettled: terrain.whenSettled, stats: terrain.stats, heightAt: terrain.heightAt, groundY: terrain.groundY };

  const routes = city.routes || [];
  const modes = document.getElementById('modes');
  if (!routes.length) {
    const none = () => Promise.reject(new Error(`${city.name} has no drive routes`));
    hooks.drive = { start: none, whenSettled: none, active: () => false, exit() {}, pose: () => null, stats: () => null, visible: () => false };
    return hooks.drive;
  }
  const about = document.getElementById('about');
  about.textContent = about.textContent.replace('footprints from OpenStreetMap.', 'footprints and road geometry from OpenStreetMap.');

  const el = {
    views: document.querySelector('.views'), night: document.getElementById('night'), hint: document.getElementById('hint'),
    compass: document.getElementById('compass'), tools: document.getElementById('tools'),
  };
  const tz = city.tz || 'UTC';
  const units = () => settings.units;
  const hintText = el.hint.querySelector('span');
  const mapHint = hintText.textContent;
  const bar = createRouteBar({ dock: document.getElementById('dock'), tz, units, onToggle: toggle, onRate: rate, onLock: lock, onSeek: seekS });
  const cards = createRouteCards({ after: el.views, routes, units, onStart: chooseStart, onRoute: (id) => enter(id).catch(() => {}) });
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
  /** A start chip: the car goes there at that start's default moment, then plays once the road is in. */
  async function chooseStart(key) {
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

  // ---------------------------------------------------------------- entering and leaving
  /** Load the drive the first time; a failed download shows one toast and leaves the app in Map. */
  function load() {
    if (session) return Promise.resolve(session);
    if (!loadingSession) {
      loadingSession = import('./session.js')
        .then(({ createSession }) => createSession(ctx, terrain, { onFrame }))
        .then((s) => (session = s))
        .catch((err) => { loadingSession = null; throw err; });
    }
    return loadingSession;
  }

  /**
   * Enter Drive on a route. Resolves once the first frame is settled; the clock then plays, unless
   * it was paused when the visitor last left Drive or the address named a moment (a shared link
   * opens paused on it).
   * @param {string} id  @param {{ s?: number, t?: number, view?: string, yaw?: number, pitch?: number, lens?: number }} [at]
   */
  async function enter(id, at = {}) {
    const token = ++entering;
    showMode('drive');
    bar.show(true);
    cards.show(true);
    cards.setLoading(true);
    bar.setStatus(session ? null : 'Loading the drive…');
    try {
      await load();
    } catch (err) {
      if (token === entering) {
        bar.show(false);
        cards.show(false);
        cards.setLoading(false);
        showMode('map');
        ctx.showToast('The drive could not be loaded.', false);
      }
      console.warn('Drive mode failed to load.', err);
      throw err;
    }
    if (token !== entering) return; // the visitor went back to Map while it loaded
    const fresh = !session.journey || id !== routeId || Number.isFinite(at.s) || Number.isFinite(at.t);
    routeId = id;
    if (fresh) session.configure(id, at);
    showRoute();
    if (at.view === 'cabin' || at.view === 'clean') view = at.view;
    session.rig.setView(view).setReduceMotion(reduceMotion());
    session.rig.look({ yaw: at.yaw, pitch: at.pitch, lens: at.lens });
    if (!seam.active) activate();
    session.clock.pause();
    writeAddress();
    bar.setStatus('Loading the road…');
    try {
      await session.whenSettled();
    } finally {
      if (token === entering) cards.setLoading(false);
    }
    if (token !== entering || !seam.active) return;
    bar.setStatus(null);
    if (!Number.isFinite(at.t) && (fresh || wasPlaying)) session.clock.play();
    writeAddress();
  }

  function activate() {
    ctx.stopFlight();
    saveMap();
    controls.enabled = false;
    seam.frame = (now) => session.frame(now);
    seam.render = () => session.render();
    seam.focus = (entry) => {
      const b = entry.data;
      session.lookAt(entry.offset.clone().set(b.c[0], b.ground - city.base + b.h * 0.6, -b.c[1]).add(entry.offset));
    };
    seam.active = true;
    el.views.hidden = true;
    el.night.hidden = true;
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
    session.clock.pause();
    seam.active = false;
    seam.frame = seam.render = seam.focus = null;
    seam.night = null;
    session.show(false);
    ctx.applyNight();
    ctx.repaint();
    document.documentElement.dataset.theme = settings.night ? 'dark' : 'light';
    el.views.hidden = false;
    el.night.hidden = false;
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
    pose: () => (session && seam.active ? session.poseNumbers() : null),
    whenSettled: () => need().whenSettled(),
    visible: (targetId) => need().visible(targetId),
    stats: () => (session ? { ...session.stats(), active: seam.active } : null),
    active: () => seam.active,
    route: () => (session?.journey ? { ...session.journey.route } : null),
  };

  // ?mode=drive opens straight into the drive
  const state = decodeDriveState(location.search);
  if (state.drive) {
    const id = routes.some((r) => r.id === state.route) ? state.route : routes[0].id;
    enter(id, state).catch(() => writeAddress());
  }
  return hooks.drive;
}

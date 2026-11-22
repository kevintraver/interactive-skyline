// Drive mode's entry point, joined to main.js by one call (initDrive) and the `seam` object it passes.
// This module is light: the mode switch, the address, the test hooks, and handing the app's camera
// between the map and the drive. The drive itself (session.js and everything it imports) is loaded,
// downloaded and built only the first time Drive is entered.
//
// The seam (main.js, marked "drive seam"): while seam.active the animation loop calls seam.frame
// instead of the map controls and the camera glide, skips the viewpoint snapshots, and paints
// removable buildings in their natural colours; seam.night, when not null, is the look applyNight
// shows instead of the saved setting; focusOn calls seam.focus.

import { createTerrain } from '../world/terrain/index.js';
import { decodeDriveState, encodeDriveState, clearDriveState } from './url.js';
import { createTransport } from './ui/transport.js';
import { attachInput } from './input.js';

/**
 * @param {object} ctx
 * @param {object} ctx.city  an entry of data/cities.json   @param {string} ctx.cityId  @param {string} ctx.DATA  '/data/<city>'
 * @param {import('three').Scene} ctx.scene  @param {import('three').PerspectiveCamera} ctx.camera  the app's one camera
 * @param {object} ctx.controls  OrbitControls  @param {import('three').WebGLRenderer} ctx.renderer  @param {HTMLCanvasElement} ctx.canvas
 * @param {object} ctx.settings  the visitor's settings; read, never written
 * @param {{ active: boolean, night: boolean|null, frame: Function|null, focus: Function|null }} ctx.seam
 * @param {() => void} ctx.invalidate  @param {() => void} ctx.applyNight  @param {() => void} ctx.repaint  repaints removable buildings
 * @param {() => void} ctx.resize  @param {() => void} ctx.stopFlight  @param {(text: string, undoable: boolean) => void} ctx.showToast
 * @param {import('three').Mesh} ctx.sky  the sky dome  @param {Array<[import('three').Mesh, string]>} ctx.ground  terrain meshes with their grid names
 * @param {object} ctx.terrainMeta  terrain.json  @param {{ near: ArrayBuffer, far: ArrayBuffer }} ctx.buffers
 * @param {object[]} ctx.tall  removable buildings  @param {() => import('three').Mesh} ctx.getLow  the merged low buildings
 */
export function initDrive(ctx) {
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
  const transport = createTransport({ dock: document.getElementById('dock'), tz: city.tz || 'UTC', units: () => settings.units, onToggle: toggle });
  let session = null, loadingSession = null, mapState = null, wasPlaying = true, entering = 0;
  let routeId = routes[0].id; // the route the drive remembers for this visit

  attachInput({ canvas, controls, tools: el.tools, invalidate, onToggle: toggle, active: () => seam.active, session: () => session });

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

  function toggle() {
    if (!session) return;
    if (session.clock.playing) session.clock.pause(); else session.clock.play();
    writeAddress();
    invalidate();
  }

  // ---------------------------------------------------------------- the address
  function writeAddress() {
    if (!session?.journey) return;
    const p = seam.active
      ? encodeDriveState({ route: routeId, s: session.pose?.s, t: session.clock.now() }, location.search)
      : clearDriveState(location.search);
    const q = p.toString();
    history.replaceState(history.state, '', q ? `?${q}` : location.pathname);
  }

  // ---------------------------------------------------------------- the camera, handed between map and drive
  function saveMap() {
    mapState = {
      position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(),
      fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect, zoom: camera.zoom,
      target: controls.target.clone(), enabled: controls.enabled, width: innerWidth, height: innerHeight,
      skyPosition: ctx.sky.position.clone(), compass: el.compass.firstElementChild.style.rotate,
      compassTitle: el.compass.title, hint: el.hint.hidden,
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
    el.hint.hidden = m.hint;
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
   * Enter Drive on a route. Resolves once the first frame is settled; the clock then plays (unless
   * it was paused when the visitor last left Drive).
   * @param {string} id  @param {{ s?: number, t?: number, view?: string, yaw?: number, pitch?: number, lens?: number }} [at]
   */
  async function enter(id, at = {}) {
    const token = ++entering;
    showMode('drive');
    transport.show(true);
    transport.setStatus(session ? null : 'Loading the drive…');
    try {
      await load();
    } catch (err) {
      if (token === entering) {
        transport.show(false);
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
    session.rig.look({ yaw: at.yaw, pitch: at.pitch, lens: at.lens });
    if (!seam.active) activate();
    session.clock.pause();
    writeAddress();
    transport.setStatus('Loading the road…');
    await session.whenSettled();
    if (token !== entering || !seam.active) return;
    transport.setStatus(null);
    if (fresh || wasPlaying) session.clock.play();
    writeAddress();
  }

  function activate() {
    ctx.stopFlight();
    saveMap();
    controls.enabled = false;
    seam.frame = (now) => session.frame(now);
    seam.focus = (entry) => {
      const b = entry.data;
      session.lookAt(entry.offset.clone().set(b.c[0], b.ground - city.base + b.h * 0.6, -b.c[1]).add(entry.offset));
    };
    seam.active = true;
    el.views.hidden = true;
    el.night.hidden = true;
    el.hint.hidden = true;
    setCompassTitle('Look ahead');
    document.body.classList.add('driving');
    ctx.repaint();
    session.show(true);
    invalidate();
  }

  function exit() {
    entering++;
    showMode('map');
    transport.show(false);
    if (!seam.active) return;
    wasPlaying = session.clock.playing;
    session.clock.pause();
    seam.active = false;
    seam.frame = seam.focus = null;
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
    transport.update({ playing: s.clock.playing, simMs: s.clock.now(), speed: s.pose ? s.pose.speed : 0 });
    // the compass needle shows north for the way the eye looks, as it does for the map camera
    const e = camera.matrixWorld.elements; // column 2 is the camera's backward axis
    const deg = Math.round((Math.atan2(e[8], e[10]) * 180) / Math.PI);
    if (deg !== compassDeg) { compassDeg = deg; el.compass.firstElementChild.style.rotate = `${deg}deg`; }
  }

  // ---------------------------------------------------------------- hooks (plan 02, section 5.12)
  const need = () => { if (!session || !seam.active) throw new Error('Drive is not active'); return session; };
  hooks.drive = {
    /** Enter Drive on a route; resolves when the first frame is settled. */
    start: (id = routeId, { s, t, view } = {}) => enter(id, { s, t, view }),
    exit,
    seek(at) { need().seek(at); writeAddress(); },
    play() { need().clock.play(); invalidate(); },
    pause() { need().clock.pause(); invalidate(); },
    look(l) { need().rig.look(l || {}); invalidate(); },
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

// What the cabin part does the same way on both renderers (plan 02, D4.2 and D4.5; third stretch, decision 2): which
// model a device gets, the model's paint, the roles of its nodes, the mirror faces and windshield corners from
// cabin.json, and the displays' redraw logic (what the instrument cluster and the route screen show, and when they are
// drawn again). cabin.js (the classic renderer) and cabin.node.js (plan 01's) build their materials and passes around
// these; nothing here touches a renderer.

import * as THREE from 'three';
import { instrumentText, screenText } from './displays.js';
import { isSoftwareRenderer } from '../renderScale.js';

export const MODELS = '/models/drive/';
/** The interior fill: this share of the sky light's strength reaches inside from all round (assumed). */
export const FILL = 1.3;
/** The displays redraw at most this often (real time), and at once when the pose jumps. */
export const REDRAW_MS = 100;

/**
 * Which model a device gets. Low on a software renderer, on a device that reports 4 GB of memory or less or 4
 * logical cores or fewer, and on a phone (a coarse pointer and a screen under 768 px on its short side).
 * @param {{ software?: boolean, deviceMemory?: number, cores?: number, coarse?: boolean, minScreen?: number }} d
 * @returns {'high'|'low'}
 */
export function chooseCabinModel({ software = false, deviceMemory, cores, coarse = false, minScreen } = {}) {
  if (software) return 'low';
  if (Number.isFinite(deviceMemory) && deviceMemory <= 4) return 'low';
  if (Number.isFinite(cores) && cores <= 4) return 'low';
  if (coarse && Number.isFinite(minScreen) && minScreen < 768) return 'low';
  return 'high';
}

/**
 * The model on plan 01's renderer, where app.quality decides (decision 8): 'low' on Low, 'high' on High and Ultra.
 * Plan 01's detection already puts software renderers, phones and small devices on Low.
 * @param {'low'|'high'|'ultra'|string|undefined} level
 * @returns {'high'|'low'}
 */
export const cabinModelForLevel = (level) => (level === 'low' ? 'low' : 'high');

/** What chooseCabinModel needs, read from the browser and the renderer. */
export function probeDevice(renderer) {
  const software = isSoftwareRenderer(renderer);
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const minScreen = typeof screen === 'undefined' ? undefined : Math.min(screen.width, screen.height);
  return { software, deviceMemory: nav.deviceMemory, cores: nav.hardwareConcurrency, coarse, minScreen };
}

// Linear base colours. Matte and dark inside, as interiors are (a dashboard is about 4 % reflective); the
// darker the part sits under the roof, the darker it is drawn, which stands in for the roof's shade.
export const PAINT = {
  CabinDash: { color: [0.030, 0.031, 0.034], roughness: 0.92 },
  CabinTrim: { color: [0.050, 0.051, 0.055], roughness: 0.85 },
  CabinPillar: { color: [0.090, 0.090, 0.087], roughness: 0.95 },
  Hood: { color: [0.32, 0.32, 0.31], roughness: 0.38 }, // a neutral mid-grey paint
  MirrorHousing: { color: [0.035, 0.036, 0.04], roughness: 0.6 },
};

export const NODE_ROLES = {
  Instruments: 'instruments', CenterScreen: 'screen', MirrorLeft: 'mirror', MirrorRight: 'mirror', MirrorCenter: 'mirror',
};

/** The role of a mesh of the model ('instruments', 'screen', 'mirror' or undefined for paint), by its node or its parent's. */
export function roleOf(mesh) {
  const owner = mesh.name in NODE_ROLES ? mesh.name : mesh.parent?.name;
  return NODE_ROLES[owner];
}

/** The mesh of a node (a node with several primitives is a group of meshes: its first). */
export function meshOf(node) {
  if (!node) return null;
  if (node.isMesh) return node;
  let m = null;
  node.traverse((o) => { if (!m && o.isMesh) m = o; });
  return m;
}

/** cabin.json. */
export async function loadCabinMeta() {
  const res = await fetch(`${MODELS}cabin.json`);
  if (!res.ok) throw new Error(`cabin.json: HTTP ${res.status}`);
  return res.json();
}

/**
 * The mirrors and windshield of cabin.json, in cabin coordinates: mirrors { left, right, center } (each the mesh and its
 * plane, size and corners) and windshield { corners }.
 * @param {object} meta cabin.json  @param {Record<string, THREE.Object3D>} byNode the model's nodes by name
 */
export function cabinGlass(meta, byNode) {
  const v3 = (a) => new THREE.Vector3(...a);
  const corners = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v3(v)]));
  const face = (m) => {
    const normal = v3(m.normal).normalize();
    const center = v3(m.center);
    return {
      mesh: meshOf(byNode[m.node]), node: m.node, center, normal, right: v3(m.right), up: v3(m.up),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center),
      width: m.width, height: m.height, corners: corners(m.corners), kind: m.kind || 'flat',
      ...(m.radiusM ? { radiusM: m.radiusM } : {}), ...(m.minFovDeg ? { minFovDeg: m.minFovDeg } : {}),
    };
  };
  return {
    mirrors: { left: face(meta.mirrors.left), right: face(meta.mirrors.right), center: face(meta.mirrors.center) },
    windshield: { corners: corners(meta.windshield.corners) },
  };
}

/**
 * The displays' redraw logic: what the instrument cluster and the route screen show and when they are drawn again
 * (at most every REDRAW_MS of real time, at once on a jump: a seek, a scrub, a units or dusk change).
 * @param {{ session: object, settings: object, city: object, env: object, instruments: object, screen: object,
 *   look: () => { dusk: number }, onDrawn: (which: 'instruments'|'screen') => void }} o
 *   instruments, screen: displays.js createInstrumentCanvas / createScreenCanvas; onDrawn: a canvas was redrawn (its
 *   texture needs uploading)
 * @returns {{ update(frame: object, force?: boolean): void, readout: object }}
 */
export function createDisplayDriver({ session, settings, city, env, instruments, screen, look, onDrawn }) {
  let route = null; // the journey whose line the screen shows
  const drawn = { real: -Infinity, simMs: null, s: null, units: null, text: null, screen: null, dusk: null };
  const readout = { speed: null, unit: null, clock: null, temp: null, next: null, dist: null, drawnAt: null, s: null, simMs: null };

  function temperature() {
    // the stand-in environment's weather has a placeholder temperature; only a real one is shown
    const w = env?.weather;
    if (!w || w.hasTemperature !== true) return null;
    const t = w.state?.().tempC;
    return Number.isFinite(t) ? t : null;
  }

  function update(frame, force = false) {
    const now = performance.now();
    const journey = session.journey;
    if (!journey || !frame.pose) return;
    const dusk = look().dusk;
    if (route !== journey) {
      route = journey;
      let road = null;
      try { road = session.net.roadOf(journey.route); } catch { /* no line, the text still shows */ }
      screen.setRoute(road, { s0: journey.s0, s1: journey.s1 });
      force = true;
    }
    const units = settings.units;
    // a jump: paused (a seek or a scrub), or simulation time moved further than the clock's own step
    const expected = drawn.simMs === null ? 0 : (now - drawn.real) * (frame.rate || 1);
    const jumped = drawn.simMs === null || (!frame.playing && frame.simMs !== drawn.simMs)
      || Math.abs(frame.simMs - drawn.simMs - expected) > 2000 || units !== drawn.units || dusk !== drawn.dusk;
    if (!force && !jumped && now - drawn.real < REDRAW_MS) return;
    const held = session.locked || session.arrived;
    const it = instrumentText({ speed: held ? 0 : frame.pose.speed, simMs: frame.simMs, tz: city.tz || 'UTC', units, tempC: temperature() });
    const st = screenText({ s: frame.pose.s, s1: journey.s1, markers: journey.markers, to: journey.route.to, units });
    const key = `${it.speed}|${it.unit}|${it.clock}|${it.temp}|${dusk}`;
    if (key !== drawn.text) { instruments.draw(it, dusk); onDrawn('instruments'); drawn.text = key; }
    const sKey = `${st.title}|${st.dist}|${Math.round(frame.pose.s / 25)}|${dusk}`;
    if (sKey !== drawn.screen) { screen.draw(st, frame.pose.s, dusk); onDrawn('screen'); drawn.screen = sKey; }
    Object.assign(drawn, { real: now, simMs: frame.simMs, s: frame.pose.s, units, dusk });
    Object.assign(readout, { speed: it.speed, unit: it.unit, clock: it.clock, temp: it.temp, next: st.title, dist: st.dist, drawnAt: now, s: frame.pose.s, simMs: frame.simMs });
  }

  return { update, readout };
}

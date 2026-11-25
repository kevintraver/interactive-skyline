// What the cabin part is made of (plan 02, D4.2 and D4.5), with no renderer in it: which model a quality level gets, the
// model's paint, the roles of its nodes, the mirror faces and windshield corners from cabin.json, and the displays'
// redraw logic (what the instrument cluster and the route screen show, and when they are drawn again). cabin.js
// builds its materials and passes around these.

import * as THREE from 'three';
import { instrumentText, screenText } from './displays.js';

export const MODELS = '/models/drive/';
/** The interior fill: this share of the sky light's strength reaches inside from all round (assumed). */
export const FILL = 1.3;
/** The displays redraw at most this often (real time), and at once when the pose jumps. */
export const REDRAW_MS = 100;

/**
 * The model for app.quality's level (third stretch, decision 8): 'low' on Low, 'high' on High and Ultra. Plan 01's
 * detection already puts software renderers, phones and small devices on Low.
 * @param {'low'|'high'|'ultra'|string|undefined} level
 * @returns {'high'|'low'}
 */
export const cabinModelForLevel = (level) => (level === 'low' ? 'low' : 'high');

// Linear base colours. Matte and dark inside, as interiors are (a dashboard is about 4 % reflective); the
// darker the part sits under the roof, the darker it is drawn, which stands in for the roof's shade.
// `specular` is three's specularIntensity: the share of a smooth dielectric's reflection (F0 0.04, rising to 1 at
// grazing) the surface keeps. The grained, low-gloss skins of a dashboard and its trim (specified near 2 gloss units at
// 60 degrees against about 90 for smooth black plastic, so that the windshield does not mirror them) keep a tenth of it
// and are fully rough (assumed). With the full lobe a sunlit dashboard top facing a sun ahead, seen at the driver's
// grazing angle, reflected 0.17, more than the asphalt beyond it (the white dashboard driving south at noon,
// 2026-11-24). `outside`: beyond the glass (the bonnet), lit by the sun without the glass between.
export const PAINT = {
  CabinDash: { color: [0.030, 0.031, 0.034], roughness: 1, specular: 0.1 },
  CabinTrim: { color: [0.050, 0.051, 0.055], roughness: 1, specular: 0.1 },
  CabinPillar: { color: [0.090, 0.090, 0.087], roughness: 1, specular: 0.1 },
  Hood: { color: [0.32, 0.32, 0.31], roughness: 0.38, specular: 1, outside: true }, // a neutral mid-grey paint
  MirrorHousing: { color: [0.035, 0.036, 0.04], roughness: 0.6, specular: 1 },
};

/** The share of the sun a laminated windshield (and a front side window) passes into the cabin: visible transmittance
 * about 0.75 to 0.8 near normal incidence, 0.7 the legal minimum (assumed). */
export const GLASS_TRANSMITTANCE = 0.78;

/**
 * The reflectance of a paint under one direct light, as three shades it (MeshPhysicalNodeMaterial, no metal): the Lambert
 * term plus the GGX lobe (Schlick Fresnel from F0 = 0.04 x specular to F90 = specular, the height-correlated Smith
 * visibility, alpha = roughness^2), times pi: the albedo a Lambert surface would need to send the same luminance toward
 * the eye. The colour is taken by its luminance. Pure.
 * @param {{ color: number[], roughness: number, specular?: number }} paint
 * @param {{ nl: number, nv: number, nh: number, vh: number }} g cosines: normal-light, normal-view, normal-half, view-half
 */
export function paintReflectance(paint, { nl, nv, nh, vh }) {
  if (nl <= 0 || nv <= 0) return 0;
  const [r, g, b] = paint.color;
  const albedo = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = paint.specular ?? 1, a = paint.roughness ** 2, a2 = a * a;
  const F = 0.04 * s + (s - 0.04 * s) * (1 - vh) ** 5;
  const V = 0.5 / (nv * Math.sqrt(a2 + (1 - a2) * nl * nl) + nl * Math.sqrt(a2 + (1 - a2) * nv * nv));
  const D = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2);
  return albedo + Math.PI * F * V * D;
}

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
    // until plan 01's weather has loaded there is no temperature; only a real one is shown
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

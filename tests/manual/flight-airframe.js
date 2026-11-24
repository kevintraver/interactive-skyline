// The airframe harness (see flight-airframe.html): the modelled airframe with its rig, flex and lights, the cabin, the
// head rig and the layers on the app's renderer, without the app. Light is in the app's units: lux and cd/m^2 times the
// pre-exposure uniform (src/render/materials/shared.js `exposure`, which the environment's nodes read), with the sun at
// 100,000 lux by day and a quarter-moon's 0.1 lux by night. The ground is flight-cabin.html's plain field, moved under
// the aircraft for each view so the wheels can be judged on it.
import { Scene, PerspectiveCamera, PlaneGeometry, Mesh, Group, DirectionalLight, HemisphereLight, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { positionLocal, positionWorld, positionWorldDirection, vec2, vec3, float, floor, fract, sin, dot, mix, step, max, abs, pow, uniform } from 'three/tsl';
import { createRenderer } from '../../src/render/renderer.js';
import { EFFECTIVE_RADIUS } from '../../src/core/earth.js';
import { createFrame } from '../../src/world/frame.js';
import { exposure } from '../../src/render/materials/shared.js';
import { createEnvNodes } from '../../src/env/nodes.js';
import { parseTrack } from '../../src/flight/track.js';
import { createModelledAirframe } from '../../src/flight/aircraft/airframe.js';
import { GROUPS } from '../../src/flight/aircraft/lights.js';
import { createCabin, cabinMaterials } from '../../src/flight/cabin/cabin.js';
import { createHeadRig, attachHeadInput, DEFAULT_LOOK, verticalFov } from '../../src/flight/cabin/headRig.js';
import { seat as seatOf } from '../../src/flight/cabin/lopa.js';
import { createFlightLayers } from '../../src/flight/view/layers.js';
import cities from '../../data/cities.json';

const log = document.getElementById('log');
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('scene');
const scene = new Scene();
const { renderer, backend, reason } = await createRenderer({ canvas, scene, search: location.search });
renderer.shadowMap.enabled = false;
const camera = new PerspectiveCamera(50, 1, 1, 1000);
const SUN_LUX = 100000, MOON_LUX = 0.1, SKY_LUX = 15000, NIGHT_SKY_LUX = 0.03;
// by night about the app's own pre-exposure over a lit city (src/render/exposure.js: EV100 near 1, key near 0.03)
const K_DAY = 3.2 / SUN_LUX, K_NIGHT = 0.1;

// --- sky and ground
const uNight = uniform(0);
const daySky = mix(vec3(0.78, 0.83, 0.88), vec3(0.18, 0.36, 0.72), pow(max(positionWorldDirection.y, 0), 0.45));
scene.backgroundNode = mix(daySky, vec3(0.0008, 0.0012, 0.0025), uNight);
const ground = new Group();
{
  const g = new PlaneGeometry(400000, 400000, 320, 320).rotateX(-Math.PI / 2);
  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  m.positionNode = positionLocal.sub(vec3(0, dot(positionLocal.xz, positionLocal.xz).div(2 * EFFECTIVE_RADIUS), 0));
  const p = positionWorld.xz, l = positionLocal.xz;
  const h = fract(sin(dot(floor(p.div(400)), vec2(12.9898, 78.233))).mul(43758.5453));
  const field = mix(vec3(0.36, 0.30, 0.22), vec3(0.22, 0.26, 0.15), h.mul(h));
  // the runway along the group's -Z (the track's heading), 45 m wide, a white centre line, 4 km each way
  const runway = step(abs(l.x), float(22.5)).mul(step(abs(l.y), float(4000)));
  const centre = step(abs(l.x), float(0.45)).mul(step(0.5, fract(l.y.div(60)))).mul(runway);
  m.colorNode = mix(mix(field, vec3(0.08, 0.08, 0.09), runway), vec3(0.8, 0.8, 0.8), centre);
  ground.add(new Mesh(g, m));
}
scene.add(ground);
const sun = new DirectionalLight(0xfff4e6, 1);
sun.position.set(-0.5, 0.75, 0.45).multiplyScalar(1000);
const hemi = new HemisphereLight(0xb8cde8, 0x6b5a45, 1);
scene.add(sun, sun.target, hemi);
function setNight(night) {
  uNight.value = night ? 1 : 0;
  exposure.value = night ? K_NIGHT : K_DAY;
  // lux x exposure. By day the cabin harness's sun (3.2) and fill (1.6), which make the sun 100,000 lux; by night a
  // quarter moon and starlight's fill in the same proportion to the day's sky
  sun.intensity = night ? MOON_LUX * K_NIGHT : SUN_LUX * K_DAY;
  hemi.intensity = night ? NIGHT_SKY_LUX * K_NIGHT * (1.6 / (SKY_LUX * K_DAY)) : 1.6;
}

// --- the flight
const frame = createFrame(cities.lv);
const header = await (await fetch('../fixtures/flight/synthetic-19.json')).json();
const track = parseTrack(header, await (await fetch('../fixtures/flight/synthetic-19.bin')).arrayBuffer(), { frame });
const tdState = track.sample(track.touchdownT);
const nodes = createEnvNodes({ state: null });
const airframe = createModelledAirframe({ nodes });
const cabinMats = cabinMaterials();
let currentSeat = seatOf(q.get('seat') || '22F');
let cabin = createCabin({ seat: currentSeat, materials: cabinMats });
const rig = createHeadRig({ seat: currentSeat });
const layers = createFlightLayers({ scene, camera, airframe, cabin, rig }).attach();

let view = { t: Number(q.get('t') ?? 200), set: {}, night: q.get('night') === '1', wallS: 0, reducedMotion: false, outside: null };
let state = null, outsideCam = null, updateMs = 0, lastInfo = null;

function setSeat(id) {
  if (id === currentSeat.id) return;
  currentSeat = seatOf(id);
  const next = createCabin({ seat: currentSeat, materials: cabinMats });
  layers.setCabin(next);
  cabin.dispose();
  cabin = next;
  rig.setSeat(currentSeat);
}

function size() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  return w / h;
}

/** The ground under the aircraft: the runway's level at touchdown, or under the wheels once on the runway. */
function placeGround(s) {
  const at = s.onGround ? s : tdState;
  ground.position.set(at.position.x, s.onGround ? s.position.y : tdState.position.y, at.position.z);
  ground.rotation.set(0, -tdState.heading, 0);
}

function pose() {
  state = Object.assign(track.sample(view.t), view.set);
  setNight(view.night);
  placeGround(state);
  const aspect = size();
  layers.update(state, { aspect, heightAboveGround: state.position.y - ground.position.y });
  const opts = { wallS: view.wallS, reducedMotion: view.reducedMotion, hasLightsChannel: true, night: view.night, flex: view.flex !== false };
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) airframe.update(state, opts);
  updateMs = (performance.now() - t0) / 50;
  outsideCam = null;
  if (view.outside) {
    const { azimuth = 45, elevation = 15, distance = 60, lens = 35, target = [0, 3, 0] } = view.outside;
    const cam = new PerspectiveCamera(verticalFov(lens, aspect), aspect, 0.3, 200000);
    const RAD = Math.PI / 180, a = azimuth * RAD, e = elevation * RAD;
    const tgt = new Vector3(...target).applyQuaternion(state.quaternion).add(state.position);
    const off = new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).multiplyScalar(distance).applyQuaternion(state.quaternion);
    cam.position.copy(tgt).add(off);
    cam.up.set(0, 1, 0).applyQuaternion(state.quaternion);
    cam.lookAt(tgt);
    outsideCam = cam;
  }
}

function draw() {
  pose();
  renderer.render(scene, outsideCam ?? camera);
  const m = airframe.model;
  log.textContent = `${backend} · t ${view.t.toFixed(0)} · flap ${state.flap.toFixed(1)} slat ${state.slat.toFixed(1)} gear ${state.gear.toFixed(1)} gsp ${state.groundSpoiler.toFixed(1)} rev ${state.reverser.toFixed(1)} · lights ${state.lights} · ${view.night ? 'night' : 'day'} · ${m ? `tip ${m.flex.tipR.toFixed(2)} m` : 'stand-in'} · ${currentSeat.id}`;
}

/** Draw calls and triangles of this view with and without the airframe (rendered to completion, so every pipeline
 * is ready and counted), then the view drawn again. */
async function measure() {
  const cam = outsideCam ?? camera, info = renderer.info;
  const count = async () => {
    renderer.render(scene, cam); // once to have every pipeline ready
    await frameDone();
    info.autoReset = false;
    info.reset();
    renderer.render(scene, cam);
    const r = { calls: info.render.drawCalls, triangles: info.render.triangles };
    info.autoReset = true;
    return r;
  };
  const withIt = await count();
  airframe.group.visible = false;
  const without = await count();
  airframe.group.visible = true;
  renderer.render(scene, cam);
  await frameDone();
  lastInfo = { with: withIt, without, airframeCalls: withIt.calls - without.calls, airframeTriangles: withIt.triangles - without.triangles };
}

const frameDone = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

attachHeadInput(canvas, rig, { onChange: () => { view.outside = null; draw(); } });
const KEYS = { 1: { t: 200 }, 2: { t: 320 }, 3: { t: 390 }, 4: { t: 440 }, 5: { t: 480 }, 6: { t: 541.5 }, 7: { t: 552 }, 8: { t: 600, set: { flap: 5, slat: 1, groundSpoiler: 0, reverser: 0 } }, 9: { t: 600, set: { flap: 0, slat: 0, groundSpoiler: 0, reverser: 0 } } };
addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') { layers.cleanView(); draw(); }
  if (e.key === 'n' || e.key === 'N') { view.night = !view.night; draw(); }
  if (KEYS[e.key]) { view = { ...view, set: {}, ...KEYS[e.key] }; draw(); }
});
addEventListener('resize', draw);
// the flashing lamps on presentation time while nobody drives the page
let auto = true;
(function tick() { if (auto) { view.wallS = performance.now() / 1000; if (airframe.model) draw(); } requestAnimationFrame(tick); })();

let gpu = '';
try { const a = await navigator.gpu?.requestAdapter(); gpu = a?.info ? `${a.info.vendor} ${a.info.architecture}` : ''; } catch { /* none */ }

const ready = airframe.ready.then(async (m) => { draw(); await frameDone(); return !!m; });
window.__af = {
  ready,
  get info() { return { backend, reason, gpu, model: airframe.model ? true : String(airframe.error) }; },
  async view({ t = 200, set = {}, seat = '22F', look = {}, night = false, wallS = 0, reducedMotion = false, clean = false, outside = null, flex = true } = {}) {
    auto = false;
    view = { t, set, night, wallS, reducedMotion, outside, flex };
    setSeat(seat);
    rig.reset().look({ ...DEFAULT_LOOK, ...look });
    layers.cleanView(clean);
    draw();
    await frameDone();
    await measure();
    return this.stats();
  },
  /** Show or hide a named object of the airframe (debugging): returns whether it was found. */
  toggle(name, visible) {
    const o = airframe.group.getObjectByName(name);
    if (o) o.visible = visible;
    return !!o;
  },
  stats() {
    const m = airframe.model;
    const levels = m ? Object.fromEntries(GROUPS.map((g, i) => [g, +m.levels[i].toFixed(3)])) : null;
    return {
      triangles: airframe.triangles, drawCalls: airframe.drawCalls, scene: lastInfo, updateMs: +updateMs.toFixed(4),
      tipL: m?.flex.tipL, tipR: m?.flex.tipR, levels, seat: currentSeat.id,
      state: state && Object.fromEntries(['t', 'flap', 'slat', 'gear', 'speedbrake', 'groundSpoiler', 'reverser', 'lights', 'onGround', 'pitch', 'ias', 'turbulence'].map((k) => [k, typeof state[k] === 'number' ? +state[k].toFixed(3) : state[k]])),
    };
  },
};

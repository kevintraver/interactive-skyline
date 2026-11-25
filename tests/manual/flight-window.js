// The window-pane harness (see flight-window.html): the modelled cabin with the pane of src/flight/window/ on the
// app's renderer and pipeline, without the app. Light is in the app's units, as in flight-cabin.js: lux and cd/m^2
// times the pre-exposure uniform the environment's nodes read; the sun 100,000 lux by day (its disc drawn in the sky
// at the right luminance, so it can be looked at through the glass), a quarter moon's 0.1 lux by night, when the
// ground has a field of lamps round the runway.
//
// The cabin and the pane are composed as in the app (F3.9): the cabin in its own scene through the cabin stage
// (src/flight/view/cabinStage.js) after the scene pass, the pane reading the stage's finished outside picture. The
// cabin is lit by its own light (cabin.js createCabinLight), fed here from the harness's sun and sky.
import { Scene, PerspectiveCamera, PlaneGeometry, Mesh, DirectionalLight, HemisphereLight, Vector3, BoxGeometry, InstancedMesh, Matrix4, Color } from 'three';
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { positionLocal, positionWorld, positionWorldDirection, vec2, vec3, float, floor, fract, sin, dot, mix, step, max, abs, pow, uniform, smoothstep, acos, exp, min } from 'three/tsl';
import { createRenderer } from '../../src/render/renderer.js';
import { createPipeline } from '../../src/render/pipeline.js';
import { createPerf } from '../../src/render/perf.js';
import { EFFECTIVE_RADIUS } from '../../src/core/earth.js';
import { createFrame } from '../../src/world/frame.js';
import { exposure } from '../../src/render/materials/shared.js';
import { createEnvNodes } from '../../src/env/nodes.js';
import { parseTrack } from '../../src/flight/track.js';
import { createModelledAirframe } from '../../src/flight/aircraft/airframe.js';
import { createModelledCabin, windowLuminance } from '../../src/flight/cabin/cabin.js';
import { createCabinStage } from '../../src/flight/view/cabinStage.js';
import { createHeadRig, attachHeadInput } from '../../src/flight/cabin/headRig.js';
import { seat as seatOf, defaultSeat } from '../../src/flight/cabin/lopa.js';
import { createFlightLayers } from '../../src/flight/view/layers.js';
import { FUSELAGE, bodyZ } from '../../src/flight/aircraft/dimensions.js';
import { createWindowPane } from '../../src/flight/window/index.js';
import { RING } from '../../src/flight/window/paneFrame.js';
import { syntheticArrival } from '../helpers/flightTrack.js';
import cities from '../../data/cities.json';

const log = document.getElementById('log');
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('scene');
const scene = new Scene();
const { renderer, backend, reason } = await createRenderer({ canvas, scene, search: location.search });
renderer.shadowMap.enabled = false;
const camera = new PerspectiveCamera(50, 1, 1, 1000);
const pipeline = createPipeline({ renderer, scene, camera, exposure });
pipeline.configure({ toneMapping: 'aces', bloom: 0 });
const SUN_LUX = 100000, MOON_LUX = 0.1, SKY_LUX = 15000, NIGHT_SKY_LUX = 0.03;
const K_DAY = 3.2 / SUN_LUX, K_NIGHT = 0.1;
const RAD = Math.PI / 180;

// --- sky (with the sun's disc and aureole) and ground
const uNight = uniform(0);
const uSun = uniform(new Vector3(0, 1, 0));
const uK = uniform(K_DAY);
const daySky = mix(vec3(0.78, 0.83, 0.88), vec3(0.18, 0.36, 0.72), pow(max(positionWorldDirection.y, 0), 0.45));
const cs = dot(positionWorldDirection, uSun);
const ang = acos(min(cs, 1)).div(RAD); // degrees from the sun
// the disc: 100,000 lux over its 6.8e-5 sr, 1.5e9 cd/m^2; the aureole: a bright glow a few degrees across
const disc = smoothstep(0.30, 0.25, ang).mul(1.47e9);
const aureole = exp(ang.mul(-0.55)).mul(9000).add(exp(ang.mul(-0.08)).mul(2500));
const sunSky = vec3(1, 0.97, 0.9).mul(disc.add(aureole)).mul(uK).mul(uNight.oneMinus());
scene.backgroundNode = mix(daySky, vec3(0.0008, 0.0012, 0.0025), uNight).add(sunSky);
{
  const g = new PlaneGeometry(400000, 400000, 320, 320).rotateX(-Math.PI / 2);
  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  m.positionNode = positionLocal.sub(vec3(0, dot(positionLocal.xz, positionLocal.xz).div(2 * EFFECTIVE_RADIUS), 0));
  const p = positionWorld.xz;
  const cell = floor(p.div(400));
  const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const field = mix(vec3(0.36, 0.30, 0.22), vec3(0.22, 0.26, 0.15), h.mul(h));
  const road = max(step(0.992, fract(p.x.div(1600))), step(0.992, fract(p.y.div(1600))));
  const runway = step(abs(p.x), float(22.5)).mul(step(abs(p.y), float(1500)));
  m.colorNode = mix(mix(field, vec3(0.12, 0.12, 0.12), road), vec3(0.08, 0.08, 0.09), runway);
  scene.add(new Mesh(g, m));
  const box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const n = 3000, blocks = new InstancedMesh(box, new MeshStandardNodeMaterial({ color: 0x9a9690, roughness: 0.9 }), n);
  const mat = new Matrix4();
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * 12000 + 3000, z = (rnd() - 0.5) * 12000 - 2000;
    if (Math.abs(x) < 200 && Math.abs(z) < 1700) { mat.makeScale(0, 0, 0); blocks.setMatrixAt(i, mat); continue; }
    const w = 15 + rnd() * 40, hgt = 20 + rnd() * 60;
    mat.makeScale(w, hgt, w).setPosition(x, -(x * x + z * z) / (2 * EFFECTIVE_RADIUS), z);
    blocks.setMatrixAt(i, mat);
  }
  scene.add(blocks);
  // the lamps: a street grid round the runway (warm sodium, 40 m apart along streets 160 m apart), 3 m cubes at
  // 2,000 cd/m^2 by night: about 18,000 cd each, a street light's peak (seen from a kilometre, a pixel or two)
  const lampMat = new MeshBasicNodeMaterial();
  const lampColor = uniform(new Color(1, 0.72, 0.42));
  lampMat.colorNode = lampColor.mul(uNight).mul(2000).mul(uK);
  const N = 24000, lamps = new InstancedMesh(new BoxGeometry(3, 3, 3), lampMat, N);
  let k = 0;
  for (let gx = -40; gx <= 40 && k < N; gx++) for (let gz = -60; gz <= 60 && k < N; gz++) {
    for (const along of [0, 1, 2, 3]) {
      if (k >= N) break;
      if (rnd() < 0.25) continue;
      const x = gx * 160 + (along % 2 ? along * 40 : 0) + 1373, z = gz * 160 + (along % 2 ? 0 : along * 40) + 1885;
      if (Math.abs(x) < 120 && Math.abs(z) < 1800) continue;
      mat.makeTranslation(x, 6 - (x * x + z * z) / (2 * EFFECTIVE_RADIUS), z);
      lamps.setMatrixAt(k++, mat);
    }
  }
  lamps.count = k;
  scene.add(lamps);
}
const sun = new DirectionalLight(0xfff4e6, 1);
const hemi = new HemisphereLight(0xb8cde8, 0x6b5a45, 1);
scene.add(sun, sun.target, hemi);
function setLight(night, sunDir) {
  uNight.value = night ? 1 : 0;
  exposure.value = uK.value = night ? K_NIGHT : K_DAY;
  sun.intensity = night ? MOON_LUX * K_NIGHT : SUN_LUX * K_DAY;
  hemi.intensity = night ? NIGHT_SKY_LUX * K_NIGHT * (1.6 / (SKY_LUX * K_DAY)) : 1.6;
  uSun.value.copy(sunDir);
  sun.position.copy(sunDir).multiplyScalar(1000);
}

// --- the aircraft, the cabin, the pane
const frame = createFrame(cities.lv);
// the whole synthetic arrival from cruise (the committed fixture is its last ten minutes)
const synthetic = syntheticArrival();
const track = parseTrack(synthetic.header, synthetic.buffer, { frame });
const ev = (id) => track.events.find((e) => e.id === id).t;
/** The states: journey times of the synthetic arrival. */
const STATES = { cruise: 10, descent: ev('10000') - 40, approach: ev('ft1000') + 10, taxi: track.durationS - 8 };
const nodes = createEnvNodes({ state: null });
const airframe = createModelledAirframe({ nodes });
let currentSeat = q.get('seat') ? seatOf(q.get('seat')) : defaultSeat();
const cabin = createModelledCabin({ nodes, seat: currentSeat });
const rig = createHeadRig({ seat: currentSeat });
const layers = createFlightLayers({ scene, camera, airframe, cabin, rig }).attach();
const level = q.get('quality') || 'high';
const stage = createCabinStage({ renderer, pipeline, layers }).setStaged(true);
const pane = createWindowPane({ nodes, cabin, quality: level, renderer, pipeline, outside: stage.outside });
stage.useOutside(() => pane.enabled && !!pane.mesh);
pane.setTrack(track);
let stateName = q.get('state') || 'cruise';
let state = track.sample(STATES[stateName]);
let view = { night: q.get('night') === '1', cabinLight: null, sun: { angle: 35, az: 0 }, paneOn: true, wallS: 0, reducedMotion: false };
const sunDir = new Vector3(0, 1, 0);

function setSeat(id) {
  if (id === currentSeat.id) return;
  currentSeat = seatOf(id);
  cabin.setSeat(currentSeat);
  rig.setSeat(currentSeat);
  pane.setSeat(currentSeat);
}

/** The sun `angle` degrees from the line of sight through the own window's centre (above it), turned `az` about up. */
function placeSun() {
  const lay = cabin.model?.layout;
  const r = 1.8368;
  const sign = currentSeat.sign;
  const station = lay?.own ?? currentSeat.nearest[0].station;
  const win = new Vector3(sign * r * Math.cos(RING), FUSELAGE.axisY + r * Math.sin(RING), bodyZ(station)).applyQuaternion(state.quaternion).add(state.position);
  const eye = camera.position.clone();
  const axis = win.sub(eye).normalize();
  const up = new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(axis, up).normalize();
  const d = axis.clone().applyAxisAngle(side, view.sun.angle * RAD).applyAxisAngle(up, (view.sun.az || 0) * RAD);
  if (d.y < 0.03) d.y = 0.03;
  sunDir.copy(d.normalize());
}

function size() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  return w / h;
}

function draw() {
  const aspect = size();
  const cabinLight = view.cabinLight ?? (view.night ? 0.3 : 1);
  airframe.update(state, { night: view.night, hasLightsChannel: false });
  layers.update(state, { aspect, heightAboveGround: state.position.y });
  stage.setShown(layers.cabinShown);
  placeSun();
  const sunAltDeg = Math.asin(Math.min(1, sunDir.y)) / RAD;
  cabin.update(state, { cabinLight, night: view.night, reducedMotion: true, outside: view.night
    ? { windowL: windowLuminance({ sunLux: 0, ambientLux: NIGHT_SKY_LUX, sunAltDeg: -30 }), sunLux: 0, sunWorld: sunDir }
    : { windowL: windowLuminance({ sunLux: SUN_LUX, ambientLux: SKY_LUX, sunAltDeg }), sunLux: SUN_LUX, sunColor: { r: 1, g: 0.97, b: 0.92 }, sunWorld: sunDir } });
  setLight(view.night, sunDir);
  pane.setEnabled(view.paneOn);
  pane.update(state, {
    sun: view.night ? null : { dir: sunDir, illuminanceLux: SUN_LUX, color: { r: 1, g: 0.97, b: 0.92 } },
    wallS: view.wallS, night: view.night, cabinLight, reducedMotion: view.reducedMotion, exposure: exposure.value,
    // the harness's sky reads about 0.5 to 0.8 in buffer units by day: its diffuse light at the pane, in lux
    ambientLux: view.night ? NIGHT_SKY_LUX : 50000,
  });
  pipeline.render();
  const s = pane.stats();
  log.textContent = `${backend} · ${level} · ${stateName} t ${state.t.toFixed(0)} s ${(state.altMsl / 0.3048).toFixed(0)} ft · ${view.night ? 'night' : 'day'} · ${currentSeat.id} · pane ${view.paneOn ? 'on' : 'off'} · frost ${s.pane.frost.toFixed(2)} fog ${s.pane.fog.toFixed(2)} wet ${s.pane.wet.toFixed(2)} · sun ${view.sun.angle} deg · focus ${s.focus}${layers.clean ? ' · clean' : ''}`;
}
const frameDone = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

attachHeadInput(canvas, rig, { onChange: () => draw(), onShade: () => { cabin.toggleShade(); draw(); }, onFocus: () => { pane.setFocus(pane.focus === 'far' ? 'pane' : 'far'); draw(); } });
addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') { layers.cleanView(); draw(); }
  if (e.key === 'g' || e.key === 'G') { view.paneOn = !view.paneOn; draw(); }
  if (e.key === 'n' || e.key === 'N') { view.night = !view.night; draw(); }
  const n = { 1: 'cruise', 2: 'descent', 3: 'approach', 4: 'taxi' }[e.key];
  if (n) { stateName = n; state = track.sample(STATES[n]); draw(); }
});
addEventListener('resize', draw);
// by hand the drops run on the wall clock
(function tick() { if (!window.__winDriven) { view.wallS = performance.now() / 1000; draw(); } requestAnimationFrame(tick); })();

let gpu = '';
try { const a = await navigator.gpu?.requestAdapter(); gpu = a?.info ? `${a.info.vendor} ${a.info.architecture}` : ''; } catch { /* none */ }
await Promise.all([airframe.ready, cabin.ready, pane.ready, pane.textures.ready]);
draw();
await frameDone();
const perf = createPerf({ renderer, scene, camera, pipeline });
window.__winParts = { cabin, rig, layers, pane, pipeline, renderer, stage };
window.__win = {
  info: { backend, reason, gpu, level, cabinModel: !!cabin.model, textures: pane.textures.loaded, textureErrors: pane.textures.errors },
  async view({ state: s = 'cruise', t = null, seat: id = defaultSeat().id, look = null, night = false, cabinLight = null, sun: sn = { angle: 35, az: 0 }, pane: p = null,
    paneOn = true, focus = 'far', effects = null, wallS = 100, reducedMotion = false, shade = 0, clean = false, debug = 0 } = {}) {
    window.__winDriven = true;
    stateName = s; state = track.sample(t ?? STATES[s]);
    view = { night, cabinLight, sun: sn, paneOn, wallS, reducedMotion };
    setSeat(id);
    rig.reset();
    if (look) rig.look(look);
    layers.cleanView(clean);
    cabin.setShade(shade);
    pane.setOverride(p);
    pane.setFocus(focus);
    if (pane.uniforms) pane.uniforms.debug.value = debug;
    pane.setEffects({ frost: true, condensation: true, droplets: true, scratches: true, reflections: true, transmission: true, ...(effects || {}) });
    draw(); // the reflection's cube is drawn on the first frame of a new look
    draw();
    await frameDone();
    return this.stats();
  },
  /** Throughput of the current view with the pane on or off (back-to-back frames, then a GPU sync). */
  async cost({ frames = 90, paneOn = true } = {}) {
    view.paneOn = paneOn;
    draw();
    await frameDone();
    const r = await perf.throughput(frames, 15);
    return r;
  },
  stats() {
    draw();
    const s = pane.stats();
    return { ...s, drawCalls: renderer.info?.render?.drawCalls ?? null, seat: currentSeat.id, state: stateName, t: state.t, sunDir: sunDir.toArray().map((v) => +v.toFixed(3)), look: rig.state };
  },
};

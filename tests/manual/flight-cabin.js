// The window-seat harness (see flight-cabin.html): the modelled airframe, the modelled cabin (F3.5), the head rig in
// its finished form (F3.7), the layers and the seat map (F3.6) on the app's renderer, without the app. Light is in the
// app's units, as in flight-airframe.js: lux and cd/m^2 times the pre-exposure uniform that the environment's nodes
// read, the sun at 100,000 lux by day and a quarter moon's 0.1 lux by night. The ground and sky are deliberately
// plain: a field pattern that shows scale, motion and the horizon's tilt, lowered by the earth's curve.
import { Scene, PerspectiveCamera, PlaneGeometry, Mesh, DirectionalLight, HemisphereLight, Vector3, BoxGeometry, InstancedMesh, Matrix4 } from 'three';
import { MeshStandardNodeMaterial, WebGPURenderer, ACESFilmicToneMapping } from 'three/webgpu';
import { positionLocal, positionWorld, positionWorldDirection, vec2, vec3, float, floor, fract, sin, dot, mix, step, max, abs, pow, uniform } from 'three/tsl';
import { createRenderer } from '../../src/render/renderer.js';
import { EFFECTIVE_RADIUS } from '../../src/core/earth.js';
import { createFrame } from '../../src/world/frame.js';
import { exposure } from '../../src/render/materials/shared.js';
import { createEnvNodes } from '../../src/env/nodes.js';
import { parseTrack } from '../../src/flight/track.js';
import { bodyQuaternion } from '../../src/flight/kinematics.js';
import { createModelledAirframe } from '../../src/flight/aircraft/airframe.js';
import { createModelledCabin } from '../../src/flight/cabin/cabin.js';
import { createHeadRig, attachHeadInput, lensToHfov, verticalFov } from '../../src/flight/cabin/headRig.js';
import { seat as seatOf, defaultSeat, seatFor } from '../../src/flight/cabin/lopa.js';
import { createSeatMap } from '../../src/flight/ui/seatMap.js';
import { createFlightLayers } from '../../src/flight/view/layers.js';
import cities from '../../data/cities.json';

const log = document.getElementById('log');
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('scene');
const scene = new Scene();
// ?depth=log: the WebGL2 backend as it runs where the browser has no clip control (no reversed depth, a logarithmic
// buffer instead), which this machine's browser would otherwise never take
const { renderer, backend, reason } = q.get('depth') === 'log' ? await (async () => {
  const r = new WebGPURenderer({ canvas, antialias: true, forceWebGL: true, reversedDepthBuffer: false });
  await r.init();
  r.logarithmicDepthBuffer = true;
  r.toneMapping = ACESFilmicToneMapping;
  r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  return { renderer: r, backend: 'webgl2-logdepth', reason: '?depth=log' };
})() : await createRenderer({ canvas, scene, search: location.search });
renderer.shadowMap.enabled = false;
const camera = new PerspectiveCamera(50, 1, 1, 1000);
const SUN_LUX = 100000, MOON_LUX = 0.1, SKY_LUX = 15000, NIGHT_SKY_LUX = 0.03;
const K_DAY = 3.2 / SUN_LUX, K_NIGHT = 0.1;

// --- sky and ground
const RAD = Math.PI / 180;
const uNight = uniform(0);
const daySky = mix(vec3(0.78, 0.83, 0.88), vec3(0.18, 0.36, 0.72), pow(max(positionWorldDirection.y, 0), 0.45));
scene.backgroundNode = mix(daySky, vec3(0.0008, 0.0012, 0.0025), uNight);
{
  const g = new PlaneGeometry(400000, 400000, 320, 320).rotateX(-Math.PI / 2);
  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  // lowered onto the refraction-adjusted sphere, as the app's terrain is
  m.positionNode = positionLocal.sub(vec3(0, dot(positionLocal.xz, positionLocal.xz).div(2 * EFFECTIVE_RADIUS), 0));
  const p = positionWorld.xz;
  const cell = floor(p.div(400));
  const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const field = mix(vec3(0.36, 0.30, 0.22), vec3(0.22, 0.26, 0.15), h.mul(h));
  const road = max(step(0.992, fract(p.x.div(1600))), step(0.992, fract(p.y.div(1600))));
  // a runway at the origin, 3 km long, 45 m wide, for scale
  const runway = step(abs(p.x), float(22.5)).mul(step(abs(p.y), float(1500)));
  m.colorNode = mix(mix(field, vec3(0.12, 0.12, 0.12), road), vec3(0.08, 0.08, 0.09), runway);
  // by night the field's lamps: a speckle of warm points where the roads cross, so the window has something to show
  const lamp = step(0.985, fract(p.x.div(1600))).mul(step(0.985, fract(p.y.div(1600))));
  m.emissiveNode = vec3(1.0, 0.75, 0.45).mul(lamp).mul(uNight).mul(2000).mul(exposure);
  scene.add(new Mesh(g, m));
  // a few thousand blocks near the origin: something with height at a known size (20 to 80 m)
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
}
const sun = new DirectionalLight(0xfff4e6, 1);
sun.position.set(-0.5, 0.75, 0.45).multiplyScalar(1000);
const hemi = new HemisphereLight(0xb8cde8, 0x6b5a45, 1);
scene.add(sun, sun.target, hemi);
function setNight(night) {
  uNight.value = night ? 1 : 0;
  exposure.value = night ? K_NIGHT : K_DAY;
  sun.intensity = night ? MOON_LUX * K_NIGHT : SUN_LUX * K_DAY;
  hemi.intensity = night ? NIGHT_SKY_LUX * K_NIGHT * (1.6 / (SKY_LUX * K_DAY)) : 1.6;
}

// --- the aircraft
const frame = createFrame(cities.lv);
const header = await (await fetch('../fixtures/flight/synthetic-19.json')).json();
const track = parseTrack(header, await (await fetch('../fixtures/flight/synthetic-19.bin')).arrayBuffer(), { frame });
/** The states the harness shows. The track's give a real approach's speeds; bankRight20 is written by hand. */
const STATES = {
  level: () => track.sample(400),
  bankLeft: () => track.sample(410),
  bankRight20: () => {
    const position = new Vector3(4000, 600, -3000);
    return { position, quaternion: bodyQuaternion(position.x, position.z, 200 * RAD, 2 * RAD, 20 * RAD), gs: 70, roll: 20 * RAD };
  },
};
const nodes = createEnvNodes({ state: null });
const useModel = q.get('model') !== '0';
const airframe = createModelledAirframe({ nodes, ...(useModel ? {} : { load: () => Promise.reject(new Error('?model=0')) }) });
let currentSeat = q.get('seat') ? seatOf(q.get('seat')) : defaultSeat();
const cabin = createModelledCabin({ nodes, seat: currentSeat, ...(useModel ? {} : { load: () => Promise.reject(new Error('?model=0')) }) });
const rig = createHeadRig({ seat: currentSeat });
const layers = createFlightLayers({ scene, camera, airframe, cabin, rig }).attach();
let stateName = q.get('state') || 'level';
let state = STATES[stateName]();
let outsideCam = null;
let view = { night: q.get('night') === '1', cabinLight: null };

function setSeat(id) {
  if (id === currentSeat.id) return;
  currentSeat = seatOf(id);
  cabin.setSeat(currentSeat);
  rig.setSeat(currentSeat);
}

function size() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  return w / h;
}

function draw() {
  const aspect = size();
  setNight(view.night);
  const cabinLight = view.cabinLight ?? (view.night ? 0.3 : 1);
  airframe.update(state, { night: view.night, hasLightsChannel: false });
  cabin.update(state, { cabinLight, night: view.night, reducedMotion: true });
  if (outsideCam) {
    outsideCam.aspect = aspect;
    outsideCam.updateProjectionMatrix();
    layers.update(state, { aspect, heightAboveGround: state.position.y });
    renderer.render(scene, outsideCam);
  } else {
    layers.update(state, { aspect, heightAboveGround: state.position.y });
    renderer.render(scene, camera);
  }
  const l = rig.state;
  log.textContent = `${backend} · ${stateName} · ${view.night ? 'night' : 'day'} · ${currentSeat.id} · ${cabin.model ? 'cabin model' : 'cabin v0'} · yaw ${l.yaw.toFixed(1)} pitch ${l.pitch.toFixed(1)} ${l.lens.toFixed(0)} mm · lean ${l.lean.toFixed(2)} slide ${l.slide.toFixed(2)} rise ${l.rise.toFixed(2)}${layers.clean ? ' · clean' : ''} · shade ${cabin.shade.toFixed(2)}`;
}
const frameDone = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

attachHeadInput(canvas, rig, { onChange: () => { outsideCam = null; draw(); }, onShade: () => { cabin.toggleShade(); draw(); } });
addEventListener('keydown', (e) => {
  if (e.target.closest?.('#seatmap')) return;
  if (e.key === 'c' || e.key === 'C') { layers.cleanView(); draw(); }
  if (e.key === 'n' || e.key === 'N') { view.night = !view.night; draw(); }
  if (e.key === 'm' || e.key === 'M') { seatMap.choose().then((id) => { if (id) { setSeat(id); draw(); } }); }
  const n = { 1: 'level', 2: 'bankLeft', 3: 'bankRight20' }[e.key];
  if (n) { stateName = n; state = STATES[n](); draw(); }
});
addEventListener('resize', draw);

const seatMap = createSeatMap({ parent: document.body, stripSide: 'right', current: currentSeat.id });

let gpu = '';
try { const a = await navigator.gpu?.requestAdapter(); gpu = a?.info ? `${a.info.vendor} ${a.info.architecture}` : ''; } catch { /* none */ }

await Promise.all([airframe.ready, cabin.ready]);
draw();
await frameDone();
window.__cabinParts = { cabin, rig, layers };
window.__cabin = {
  ready: Promise.resolve(true),
  info: { backend, reason, reversedDepth: !!renderer.reversedDepthBuffer, logDepth: !!renderer.logarithmicDepthBuffer, gpu, cabinModel: !!cabin.model, airframeModel: !!airframe.model, cabinError: cabin.error?.message ?? null },
  /** Seats for the shots: the default, and ahead of, over and behind the wing on a side. */
  seats(side = 'right') { return { default: defaultSeat(side).id, ahead: seatFor('ahead', side).id, over: seatFor('over', side).id, behind: seatFor('behind', side).id }; },
  /** A view from a seat. Without `look` the seat's default look (the window centred); with one, that look over it. */
  async view({ state: s = 'level', seat: id = defaultSeat().id, look = null, clean = false, night = false, cabinLight = null, shade = 0, panes = false } = {}) {
    seatMap.close();
    outsideCam = null;
    stateName = s; state = STATES[s]();
    view = { night, cabinLight };
    setSeat(id);
    rig.reset();
    if (look) rig.look(look);
    layers.cleanView(clean);
    cabin.setShade(shade);
    cabin.model?.showPanes(panes);
    draw();
    await frameDone();
    return this.stats();
  },
  /** A camera outside: azimuth from the nose clockwise seen from above (degrees), elevation, distance from the wing root. */
  async outside({ state: s = 'level', azimuth = 45, elevation = 15, distance = 60, lens = 35, night = false } = {}) {
    seatMap.close();
    stateName = s; state = STATES[s]();
    view = { night, cabinLight: null };
    const cam = new PerspectiveCamera(verticalFov(lens, size()), size(), 0.5, 200000);
    cam.layers.enable(11);
    const target = new Vector3(0, 3, 0).applyQuaternion(state.quaternion).add(state.position);
    const a = azimuth * RAD, e = elevation * RAD;
    const off = new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).multiplyScalar(distance).applyQuaternion(state.quaternion);
    cam.position.copy(target).add(off);
    cam.up.set(0, 1, 0).applyQuaternion(state.quaternion);
    cam.lookAt(target);
    outsideCam = cam;
    draw();
    await frameDone();
    return { hfov: lensToHfov(lens) };
  },
  /** Open the seat map over the view; resolves when it is drawn. Keyboard and pointer work on it by hand. */
  async seatMap({ stripSide = 'right', current = currentSeat.id, focus = null } = {}) {
    seatMap.setStripSide(stripSide).setCurrent(current).show();
    if (focus) document.querySelector(`#seatmap [data-seat="${focus}"]`)?.focus();
    await frameDone();
    return { open: seatMap.open, shortcuts: seatMap.model.shortcuts, defaultId: seatMap.model.defaultId };
  },
  stats() {
    const p = rig.pose({ clean: layers.clean });
    return {
      airframeTriangles: airframe.triangles, cabinTriangles: cabin.triangles, cabinDrawCalls: cabin.drawCalls, cabinModel: !!cabin.model,
      near: camera.near, far: camera.far, fov: camera.fov, look: rig.state,
      eye: p.eye.toArray().map((v) => +v.toFixed(3)), seat: currentSeat.id, window: currentSeat.nearest[0],
      drawCalls: renderer.info?.render?.drawCalls ?? renderer.info?.render?.calls ?? null,
    };
  },
};

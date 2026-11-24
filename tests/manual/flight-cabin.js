// The window-seat harness (see flight-cabin.html): the flight's airframe, cabin, head rig and layers on the app's
// renderer, without the app. The ground and sky are deliberately plain: a field pattern that shows scale, motion and
// the horizon's tilt, lowered by the earth's curve so the horizon sits where it should.
import { Scene, PerspectiveCamera, PlaneGeometry, Mesh, DirectionalLight, HemisphereLight, Vector3, BoxGeometry, InstancedMesh, Matrix4 } from 'three';
import { MeshStandardNodeMaterial, WebGPURenderer, ACESFilmicToneMapping } from 'three/webgpu';
import { positionLocal, positionWorld, positionWorldDirection, vec2, vec3, float, floor, fract, sin, dot, mix, step, max, abs, pow } from 'three/tsl';
import { createRenderer } from '../../src/render/renderer.js';
import { EFFECTIVE_RADIUS } from '../../src/core/earth.js';
import { createFrame } from '../../src/world/frame.js';
import { parseTrack } from '../../src/flight/track.js';
import { bodyQuaternion } from '../../src/flight/kinematics.js';
import { createAirframe } from '../../src/flight/aircraft/airframe.js';
import { createCabin, cabinMaterials } from '../../src/flight/cabin/cabin.js';
import { createHeadRig, attachHeadInput, DEFAULT_LOOK, lensToHfov, verticalFov } from '../../src/flight/cabin/headRig.js';
import { seat as seatOf, defaultSeat } from '../../src/flight/cabin/lopa.js';
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

// --- sky and ground
const RAD = Math.PI / 180;
scene.backgroundNode = mix(vec3(0.78, 0.83, 0.88), vec3(0.18, 0.36, 0.72), pow(max(positionWorldDirection.y, 0), 0.45));
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
const sun = new DirectionalLight(0xfff4e6, 3.2);
sun.position.set(-0.5, 0.75, 0.45).multiplyScalar(1000);
scene.add(sun, sun.target);
scene.add(new HemisphereLight(0xb8cde8, 0x6b5a45, 1.6));

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
const airframe = createAirframe();
const cabinMats = cabinMaterials();
let currentSeat = q.get('seat') ? seatOf(q.get('seat')) : defaultSeat();
let cabin = createCabin({ seat: currentSeat, materials: cabinMats });
const rig = createHeadRig({ seat: currentSeat });
const layers = createFlightLayers({ scene, camera, airframe, cabin, rig }).attach();
let stateName = q.get('state') || 'level';
let state = STATES[stateName]();
let outsideCam = null;

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

function draw() {
  const aspect = size();
  if (outsideCam) {
    outsideCam.aspect = aspect;
    outsideCam.updateProjectionMatrix();
    renderer.render(scene, outsideCam);
  } else {
    layers.update(state, { aspect, heightAboveGround: state.position.y });
    renderer.render(scene, camera);
  }
  const l = rig.state;
  log.textContent = `${backend} · ${stateName} · ${currentSeat.id} · yaw ${l.yaw.toFixed(0)} pitch ${l.pitch.toFixed(0)} ${l.lens.toFixed(0)} mm · lean ${l.lean.toFixed(2)} slide ${l.slide.toFixed(2)} rise ${l.rise.toFixed(2)}${layers.clean ? ' · clean' : ''} · near ${camera.near} far ${(camera.far / 1000).toFixed(0)} km`;
}
const frameDone = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

attachHeadInput(canvas, rig, { onChange: () => { outsideCam = null; draw(); } });
addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') { layers.cleanView(); draw(); }
  const n = { 1: 'level', 2: 'bankLeft', 3: 'bankRight20' }[e.key];
  if (n) { stateName = n; state = STATES[n](); draw(); }
});
addEventListener('resize', draw);

let gpu = '';
try { const a = await navigator.gpu?.requestAdapter(); gpu = a?.info ? `${a.info.vendor} ${a.info.architecture}` : ''; } catch { /* none */ }

draw();
await frameDone();
window.__cabin = {
  ready: Promise.resolve(true),
  info: { backend, reason, reversedDepth: !!renderer.reversedDepthBuffer, logDepth: !!renderer.logarithmicDepthBuffer, gpu },
  async view({ state: s = 'level', seat: id = defaultSeat().id, look = {}, clean = false } = {}) {
    outsideCam = null;
    stateName = s; state = STATES[s]();
    setSeat(id);
    rig.reset().look({ ...DEFAULT_LOOK, ...look });
    layers.cleanView(clean);
    draw();
    await frameDone();
    return this.stats();
  },
  /** A camera outside: azimuth from the nose clockwise seen from above (degrees), elevation, distance from the wing root. */
  async outside({ state: s = 'level', azimuth = 45, elevation = 15, distance = 60, lens = 35 } = {}) {
    stateName = s; state = STATES[s]();
    layers.update(state, { aspect: size(), heightAboveGround: state.position.y });
    const cam = new PerspectiveCamera(verticalFov(lens, size()), size(), 0.5, 200000);
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
  stats() {
    const p = rig.pose({ clean: layers.clean });
    return { airframeTriangles: airframe.triangles, cabinTriangles: cabin.triangles, near: camera.near, far: camera.far, fov: camera.fov,
      eye: p.eye.toArray().map((v) => +v.toFixed(3)), seat: currentSeat.id, window: currentSeat.nearest[0] };
  },
};

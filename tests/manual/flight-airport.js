// The airport harness (see flight-airport.html): the drawn airport alone on a planar ground, on the app's renderer,
// without the app. Light is in the app's units as flight-airframe.js has it: lux and cd/m^2 times the pre-exposure
// uniform (src/render/materials/shared.js `exposure`), the sun at 100,000 lux by day and a quarter moon's 0.1 lux by
// night. The ground is the plane through the eight runway ends' elevations (least squares), handed to the airport as
// its terrain; near the field it is drawn on a 12 m grid along the airport's own height model, 0.5 m under it, so the
// sloping runways never sink into it.
import { Scene, PerspectiveCamera, BufferGeometry, BufferAttribute, Mesh, DirectionalLight, HemisphereLight, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { positionWorld, positionWorldDirection, vec2, vec3, floor, fract, sin, dot, mix, max, pow, uniform } from 'three/tsl';
import { createRenderer } from '../../src/render/renderer.js';
import { createPerf } from '../../src/render/perf.js';
import { createFrame } from '../../src/world/frame.js';
import { exposure } from '../../src/render/materials/shared.js';
import { createEnvNodes } from '../../src/env/nodes.js';
import { createAirport } from '../../src/flight/airport/index.js';
import { runwayFrames } from '../../src/flight/airport/geometry.js';
import cities from '../../data/cities.json';

const log = document.getElementById('log');
const canvas = document.getElementById('scene');
const scene = new Scene();
const { renderer, backend, reason } = await createRenderer({ canvas, scene, search: location.search });
renderer.shadowMap.enabled = false;
const camera = new PerspectiveCamera(40, 16 / 9, 0.5, 200000);
const SUN_LUX = 100000, MOON_LUX = 0.1, SKY_LUX = 15000, NIGHT_SKY_LUX = 0.03;
const K_DAY = 3.2 / SUN_LUX, K_NIGHT = 0.1;
const FT = 0.3048, DEG = Math.PI / 180;

const city = cities.lv;
const frame = createFrame(city);
const data = await (await fetch('../../public/data/lv/airport.json')).json();
const { ends } = runwayFrames(data);

// --- the plane through the runway ends: z = a + b x + c y (least squares)
const pts = Object.values(data.ends).map((e) => e.end);
const plane = (() => {
  // normal equations for [1 x y]
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  for (const [x, y, z] of pts) {
    const v = [1, x, y];
    for (let i = 0; i < 3; i++) { r[i] += v[i] * z; for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j]; }
  }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(S);
  const sol = [0, 1, 2].map((k) => det(S.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))) / D);
  return (x, y) => sol[0] + sol[1] * x + sol[2] * y;
})();

const nodes = createEnvNodes({ state: null });
const t0 = performance.now();
const airport = createAirport({ data, frame, terrain: { surfaceAt: plane }, nodes, quality: 'high' });
const buildMs = performance.now() - t0;
scene.add(airport.group);

// --- sky and ground
const uNight = uniform(0);
const daySky = mix(vec3(0.78, 0.83, 0.88), vec3(0.18, 0.36, 0.72), pow(max(positionWorldDirection.y, 0), 0.45));
scene.backgroundNode = mix(daySky, vec3(0.0008, 0.0012, 0.0025), uNight);
const groundMat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
{
  const p = positionWorld.xz;
  const h = fract(sin(dot(floor(p.div(150)), vec2(12.9898, 78.233))).mul(43758.5453));
  const h2 = fract(sin(dot(floor(p.div(23)), vec2(39.3468, 11.135))).mul(24634.6345));
  groundMat.colorNode = mix(vec3(0.36, 0.30, 0.22), vec3(0.30, 0.27, 0.20), h.mul(0.7).add(h2.mul(0.3)));
}
function gridMesh(x0, y0, x1, y1, step, z) {
  const nx = Math.ceil((x1 - x0) / step), ny = Math.ceil((y1 - y0) / step);
  const pos = new Float32Array((nx + 1) * (ny + 1) * 3);
  const idx = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx, y = y0 + ((y1 - y0) * j) / ny;
    pos.set([x, frame.sceneY(z(x, y), x, y), -y], 3 * (j * (nx + 1) + i));
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new Mesh(g, groundMat);
}
const FIELD = [-400, -5000, 5100, -1300];
const groundNear = gridMesh(...FIELD, 12, (x, y) => airport.heightAt(x, y) - 0.5);
const groundFar = gridMesh(-60000, -60000, 60000, 60000, 400, (x, y) => {
  const inside = x > FIELD[0] && x < FIELD[2] && y > FIELD[1] && y < FIELD[3];
  return plane(x, y) - (inside ? 3 : 0.8);
});
scene.add(groundNear, groundFar);
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

// --- views (map metres, metres above sea level)
/** On the approach to `end`: `dist` m before the threshold on a `deg` path crossing at 50 ft, looking at the aim. */
function onFinal(end, dist, deg = 3) {
  const e = ends[end];
  const [x, y] = e.toMap(-dist, 0);
  const z = e.thr[2] + 50 * FT + dist * Math.tan(deg * DEG);
  const [tx, ty] = e.toMap(300, 0);
  return { eye: [x, y, z], target: [tx, ty, e.zAt(300)], fov: 40 };
}
/** A right-hand window: from the fuselage's right side, looking `yaw` degrees right of the heading, `pitch` down. */
function rightWindow(end, s, height, yaw = 60, pitch = -10, fov = 50) {
  const e = ends[end];
  const [x, y] = e.toMap(s, 1.8);
  const z = e.zAt(s) + height;
  const h = Math.atan2(e.L[0], e.L[1]) + yaw * DEG;
  const d = [Math.sin(h) * Math.cos(pitch * DEG), Math.cos(h) * Math.cos(pitch * DEG), Math.sin(pitch * DEG)];
  return { eye: [x, y, z], target: [x + d[0] * 100, y + d[1] * 100, z + d[2] * 100], fov };
}
const e19 = ends['19R'];
// the runway holding position nearest the 19R threshold, seen from 25 m up and 70 m off
const hold = data.holdingPositions.filter((h) => h.type === 'runway').sort((a, b) => Math.hypot(a.x - e19.thr[0], a.y - e19.thr[1]) - Math.hypot(b.x - e19.thr[0], b.y - e19.thr[1]))[0];
const holdZ = airport.heightAt(hold.x, hold.y);
const VIEWS = {
  'final-19R': onFinal('19R', 5000),
  'final-26L': onFinal('26L', 5000),
  'final-26L-20km': onFinal('26L', 20000),
  'final-19R-zoom': { ...onFinal('19R', 5000), fov: 10 },
  'final-26L-zoom': { ...onFinal('26L', 5000), fov: 10 },
  'final-26L-20km-zoom': { ...onFinal('26L', 20000), fov: 6 },
  'threshold-19R': (() => { const e = e19; const [x, y] = e.toMap(-30, 0); const [tx, ty] = e.toMap(1500, 0); return { eye: [x, y, e.thr[2] + 50 * FT + 1.6], target: [tx, ty, e.zAt(1500)], fov: 45 }; })(),
  'touchdown-19R-right': rightWindow('19R', 420, 4.5, 55, -8),
  'window-19R-1km-right': rightWindow('19R', -1000, 70, 50, -12),
  'hold-close': { eye: [hold.x + 50, hold.y + 50, holdZ + 25], target: [hold.x, hold.y, holdZ], fov: 50 },
  'above-field': { eye: [2200, -7200, 640 + 2600], target: [2200, -3300, 640], fov: 50 },
  'above-terminal': { eye: [3200, -4700, 640 + 700], target: [2200, -3300, 640], fov: 50 },
};

let view = { view: 'final-19R', night: false, wallS: 0, reducedMotion: false };
let lastInfo = null, lastFlashT = null;

function size() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  return w / h;
}
function place(v) {
  const s = typeof v === 'string' ? VIEWS[v] : v;
  const toScene = ([x, y, z]) => new Vector3(x, frame.sceneY(z, x, y), -y);
  camera.position.copy(toScene(s.eye));
  camera.up.set(0, 1, 0);
  camera.lookAt(toScene(s.target));
  camera.fov = s.fov ?? 40;
  camera.aspect = size();
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
function pose() {
  setNight(view.night);
  place(view.view);
  airport.update({ camera, wallS: view.wallS, night: view.night, reducedMotion: view.reducedMotion });
}
function draw() {
  pose();
  renderer.render(scene, camera);
  const name = typeof view.view === 'string' ? view.view : 'custom';
  log.textContent = `${backend} · ${name} · ${view.night ? 'night' : 'day'} · t ${view.wallS.toFixed(2)}${view.reducedMotion ? ' · reduced motion' : ''} · ${airport.stats().flashGroupsInView.join(' ')}`;
}
const frameDone = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Draw calls and triangles of this view with and without the airport. */
async function measure() {
  const info = renderer.info;
  const count = async () => {
    renderer.render(scene, camera);
    await frameDone();
    info.autoReset = false;
    info.reset();
    renderer.render(scene, camera);
    const r = { calls: info.render.drawCalls, triangles: info.render.triangles };
    info.autoReset = true;
    return r;
  };
  const withIt = await count();
  airport.group.visible = false;
  const without = await count();
  airport.group.visible = true;
  renderer.render(scene, camera);
  await frameDone();
  lastInfo = { with: withIt, without, airportCalls: withIt.calls - without.calls, airportTriangles: withIt.triangles - without.triangles };
}

/** A presentation time at which a flasher in view is near its peak (searched from `from`). */
function findFlash(from = 0) {
  for (let t = from; t < from + 8; t += 0.005) {
    view.wallS = t;
    pose();
    const st = airport.stats();
    if (st.flashGroupsInView.length === 0) return from;
    if (st.flashMax > 0.9) return t;
  }
  return from;
}

const KEYS = Object.keys(VIEWS);
addEventListener('keydown', (e) => {
  if (e.key === 'n' || e.key === 'N') { view.night = !view.night; draw(); }
  if (e.key === 'r' || e.key === 'R') { view.reducedMotion = !view.reducedMotion; draw(); }
  const k = Number(e.key);
  if (k >= 1 && k <= KEYS.length) { view.view = KEYS[k - 1]; draw(); }
});
addEventListener('resize', draw);
let auto = true;
(function tick() { if (auto) { view.wallS = performance.now() / 1000; draw(); } requestAnimationFrame(tick); })();

let gpu = '';
try { const a = await navigator.gpu?.requestAdapter(); gpu = a?.info ? `${a.info.vendor} ${a.info.architecture}` : ''; } catch { /* none */ }
const perf = createPerf({ renderer, scene, camera, loop: null, pipeline: null });

draw();
await frameDone();
window.__ap = {
  ready: Promise.resolve(true),
  views: KEYS,
  get info() { return { backend, reason, gpu, buildMs: +buildMs.toFixed(0) }; },
  async view({ view: v = 'final-19R', night = false, wallS = 0, reducedMotion = false, flash = false } = {}) {
    auto = false;
    view = { view: v, night, wallS, reducedMotion };
    if (flash && !reducedMotion) view.wallS = findFlash(wallS);
    lastFlashT = view.wallS;
    draw();
    await frameDone();
    await measure();
    return this.stats();
  },
  /**
   * GPU throughput with and without the airport (ms per frame, perf.js), the current view: `rounds` alternations of
   * `n` frames each way, and the median of the differences (the machine is shared, so single runs are noise).
   */
  async cost({ n = 120, rounds = 7 } = {}) {
    const diffs = [], withs = [], withouts = [];
    await perf.throughput(30, 20);
    for (let i = 0; i < rounds; i++) {
      airport.group.visible = true;
      const a = await perf.throughput(n, 5);
      airport.group.visible = false;
      const b = await perf.throughput(n, 5);
      withs.push(a.msPerFrame); withouts.push(b.msPerFrame); diffs.push(a.msPerFrame - b.msPerFrame);
    }
    airport.group.visible = true;
    renderer.render(scene, camera);
    const med = (v) => v.slice().sort((x, y) => x - y)[Math.floor(v.length / 2)];
    return { withMs: +med(withs).toFixed(3), withoutMs: +med(withouts).toFixed(3), airportMs: +med(diffs).toFixed(3), spreadMs: +(Math.max(...diffs) - Math.min(...diffs)).toFixed(3), rounds, method: 'throughput, median of interleaved differences' };
  },
  stats() {
    const s = airport.stats();
    return { view: typeof view.view === 'string' ? view.view : 'custom', night: view.night, wallS: lastFlashT, scene: lastInfo, flashGroupsInView: s.flashGroupsInView, airport: { lights: s.lights, triangles: s.triangles, drawCalls: s.drawCalls, updateMs: s.updateMs, buildMs: s.buildMs } };
  },
  /** For debugging: hide or show the airport's meshes by name. */
  toggle(name, visible) { const o = airport.group.getObjectByName(name); if (o) o.visible = visible; return !!o; },
  ends: Object.keys(ends),
};

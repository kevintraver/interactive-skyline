// The regional terrain harness (see flight-terrain.html): src/flight/terrain with the map's near and far grids, alone,
// on the app's renderer. Light is in the app's units, as in flight-airframe.js: lux times the pre-exposure uniform
// (src/render/materials/shared.js `exposure`), the sun at 100,000 lux and the sky's fill in proportion; the sky a plain
// gradient. The camera is placed for each view by flight-terrain-views.js, its near and far planes by the flight's own
// rule (src/flight/view/layers.js nearFar), as the mode sets them.
import { Scene, PerspectiveCamera, DirectionalLight, HemisphereLight, Quaternion, Euler, Vector3 } from 'three';
import { positionWorldDirection, vec3, mix, max, pow, uniform, Fn, output, vec4, positionView, exp, float } from 'three/tsl';
import { createRenderer } from '../../src/render/renderer.js';
import { exposure } from '../../src/render/materials/shared.js';
import { createEnvNodes } from '../../src/env/nodes.js';
import { createFrame } from '../../src/world/frame.js';
import { createTerrain } from '../../src/world/terrain/index.js';
import { heightField, terrainMesh } from '../../src/city/terrain.js';
import { nearFar } from '../../src/flight/view/layers.js';
import { createRegionTerrain } from '../../src/flight/terrain/index.js';
import { VIEWS, placeCamera } from './flight-terrain-views.js';
import cities from '../../data/cities.json';

const DATA = '/data/lv';
const log = document.getElementById('log');
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('scene');
const scene = new Scene();
const { renderer, backend, reason } = await createRenderer({ canvas, scene, search: location.search });
renderer.shadowMap.enabled = false;
const camera = new PerspectiveCamera(48, 1, 1, 1000);
const city = cities.lv;
const frame = createFrame(city);

// --- light and sky (flight-airframe.js's day)
const SUN_LUX = 100000, K_DAY = 3.2 / SUN_LUX;
exposure.value = K_DAY;
const sun = new DirectionalLight(0xfff4e6, SUN_LUX * K_DAY);
const hemi = new HemisphereLight(0xb8cde8, 0x6b5a45, 1.6);
// a winter morning's sun (the recorded arrival is at 08:00 local in February): 30 degrees up, from the south-east
{
  const RAD = Math.PI / 180, el = 30 * RAD, az = 140 * RAD;
  sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(1000);
}
scene.add(sun, sun.target, hemi);
const HORIZON = vec3(0.78, 0.83, 0.88);
scene.backgroundNode = mix(HORIZON, vec3(0.18, 0.36, 0.72), pow(max(positionWorldDirection.y, 0), 0.45));
// a haze for judging what the app's legacy fog would leave of the far ground: exponential-squared at its density
const uHaze = uniform(0), uDensity = uniform(0.000014);
scene.fogNode = Fn(() => {
  const d = positionView.z.negate().mul(uDensity);
  const f = float(1).sub(exp(d.mul(d).negate())).mul(uHaze);
  return vec4(mix(output.rgb, HORIZON, f), output.a);
})();

// --- the map's near and far grids, as the map builds them
const fetchBuf = async (f) => { const r = await fetch(`${DATA}/${f}`); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.arrayBuffer(); };
const fetchBitmap = async (f) => {
  const r = await fetch(`${DATA}/${f}`);
  if (!r.ok) throw new Error(`${f}: ${r.status}`);
  return createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
};
const meta = await (await fetch(`${DATA}/terrain.json`)).json();
const [nearBuf, farBuf, nearBmp, farBmp] = await Promise.all([fetchBuf(meta.grids.near.file), fetchBuf(meta.grids.far.file), fetchBitmap('ground-near.jpg'), fetchBitmap('ground-far.jpg')]);
const { Texture, SRGBColorSpace } = await import('three');
const tex = (b) => { const t = new Texture(b); t.flipY = false; t.colorSpace = SRGBColorSpace; t.anisotropy = 8; t.needsUpdate = true; return t; };
const nearHF = heightField(nearBuf, meta.grids.near), farHF = heightField(farBuf, meta.grids.far);
const farMesh = terrainMesh(farHF, nearHF, tex(farBmp), city.base), nearMesh = terrainMesh(nearHF, null, tex(nearBmp), city.base);
farMesh.name = 'map-far'; nearMesh.name = 'map-near';
scene.add(farMesh, nearMesh);
const terrain = createTerrain({ meta, buffers: { near: nearBuf, far: farBuf }, base: city.base, fetchBinary: fetchBuf });

// --- the regional terrain
const nodes = createEnvNodes({ state: null });
const level = q.get('quality') || 'high';
const region = createRegionTerrain({ meta, baseUrl: DATA, frame, terrain, nodes, quality: { level } });
scene.add(region.group);

// --- tints, one per grid, for telling them apart
const TINTS = { region: [1.0, 0.55, 0.55], approaches: [0.55, 1.0, 0.55], valley: [0.55, 0.65, 1.0] };
function applyTint(on, photo) {
  region.group.traverse((o) => {
    if (!o.isGroup || !o.name.startsWith('flight-terrain-')) return;
    const name = o.name.slice('flight-terrain-'.length), t = TINTS[name];
    const m = o.children[0]?.material;
    if (!m || !t) return;
    if (!m.userData.tint) m.userData.tint = uniform(new Vector3(...t));
    const base = photo && m.userData.photo ? m.userData.photo : m.userData.plain;
    m.colorNode = on ? base.mul(m.userData.tint) : base;
    m.needsUpdate = true;
  });
}

let view = { name: q.get('view') || 'cruise', tint: false, haze: false, photo: true };

function place() {
  const v = VIEWS[view.name];
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  placeCamera(camera, v, { base: city.base, Quaternion, Euler });
  const { near, far } = nearFar(v.agl);
  camera.near = near; camera.far = far;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  uHaze.value = view.haze ? 1 : 0;
  return v;
}

let lastUpdate = null;
function draw() {
  place();
  lastUpdate = region.update({ camera, renderer });
  renderer.render(scene, camera);
  const s = lastUpdate;
  log.textContent = `${backend} · ${view.name} · ${s.triangles.toLocaleString('en')} tris · ${s.drawCalls} draws · target ${s.targetPx} px · needs ${s.needed.join(', ')}${view.haze ? ' · haze' : ''}`;
}

const frameDone = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** Draw calls and triangles with and without the region, and the frame's cost. */
async function measure(frames = 20) {
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
  region.group.visible = false;
  const without = await count();
  region.group.visible = true;
  // the frame: region.update and the render, CPU; the GPU's time where the backend can say
  const cpu = [], gpu = [], upd = [];
  const gl = backend === 'webgl2' ? renderer.backend.gl : null;
  const px = new Uint8Array(4);
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    region.update({ camera, renderer });
    const t1 = performance.now();
    renderer.render(scene, camera);
    const t2 = performance.now();
    upd.push(t1 - t0);
    cpu.push(t2 - t0);
    if (backend === 'webgpu' && renderer.backend.trackTimestamp) {
      const d = await renderer.resolveTimestampsAsync('render');
      if (Number.isFinite(d) && d > 0) gpu.push(d);
    } else if (backend === 'webgpu') {
      await renderer.backend.device.queue.onSubmittedWorkDone();
      gpu.push(performance.now() - t0);
    } else {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gpu.push(performance.now() - t0);
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(3) : null; };
  return { with: withIt, without, regionCalls: withIt.calls - without.calls, regionTriangles: withIt.triangles - without.triangles,
    cpuMs: med(cpu), updateMs: med(upd), gpuMs: med(gpu), gpuMethod: backend === 'webgpu' && renderer.backend.trackTimestamp ? 'timestamp' : 'wall to sync' };
}

const NAMES = Object.keys(VIEWS);
addEventListener('keydown', (e) => {
  const k = Number(e.key);
  if (k >= 1 && k <= NAMES.length) { view.name = NAMES[k - 1]; region.whenSettled().then(draw); draw(); }
  if (e.key === 'g' || e.key === 'G') { view.tint = !view.tint; applyTint(view.tint, view.photo); draw(); }
  if (e.key === 'h' || e.key === 'H') { view.haze = !view.haze; draw(); }
  if (e.key === 'p' || e.key === 'P') { view.photo = !view.photo; region.setImagery(view.photo); applyTint(view.tint, view.photo); draw(); }
});
addEventListener('resize', draw);

let gpuName = '';
try { const a = await navigator.gpu?.requestAdapter(); gpuName = a?.info ? `${a.info.vendor} ${a.info.architecture}` : ''; } catch { /* none */ }

draw();
const ready = region.whenSettled().then(async () => { draw(); await frameDone(); return true; });
window.__ft = {
  ready,
  get info() { return { backend, reason, gpu: gpuName }; },
  async view(name, { tint = false, haze = false, photo = true, frames = 20 } = {}) {
    view = { name, tint, haze, photo };
    region.setImagery(photo);
    draw();
    await region.whenSettled();
    region.setImagery(photo);
    applyTint(tint, photo); // after the photo setting, and after every grid has arrived
    draw();
    await frameDone();
    draw();
    await frameDone();
    const m = await measure(frames);
    draw();
    await frameDone();
    return { ...this.stats(), frame: m };
  },
  stats() { return { view: view.name, update: lastUpdate, region: region.stats(), camera: { far: camera.far, near: camera.near, fov: camera.fov } }; },
  region,
};

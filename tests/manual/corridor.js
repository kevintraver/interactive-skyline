// Dev page for the buildings beyond the core (plan 02, D7.6): the real terrain (wide, far and near grids,
// with their photos), the real road, and the corridor part, from the driver's eye or from above.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { heightField, terrainMesh } from '../../src/city/terrain.js';
import { createTerrain } from '../../src/world/terrain/index.js';
import { buildWideMesh } from '../../src/world/terrain/widemesh.js';
import { createFrame, EARTH_R } from '../../src/world/frame.js';
import { loadRoutes } from '../../src/drive/routes.js';
import { createRoadMaterials } from '../../src/drive/roadnet/material.js';
import { createRoadChunks } from '../../src/drive/roadnet/chunks.js';
import { createJourney } from '../../src/drive/journey.js';
import { createRig } from '../../src/drive/vehicle/rig.js';
import { createLegacySky } from '../../src/sky/legacySky.js';
import { createCorridor } from '../../src/drive/corridor/index.js';

const DATA = '/public/data/lv';
const params = new URLSearchParams(location.search);
let view = params.get('view') || 'driver';
let km = +(params.get('km') ?? 0.5);
let isNight = params.get('night') === '1';
let yaw = +(params.get('yaw') ?? 0);
const pitch = +(params.get('pitch') ?? 0), lens = +(params.get('lens') ?? 0) || undefined;
const alt = +(params.get('alt') ?? 3000);
const at = params.get('at')?.split(',').map(Number);
const hud = document.getElementById('hud');

const getJson = (f) => fetch(`${DATA}/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); });
const getBin = (f) => fetch(`${DATA}/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.arrayBuffer(); });
const getBitmap = (f) => fetch(`${DATA}/${f}`).then((r) => r.blob())
  .then((b) => createImageBitmap(b, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));

const cities = await fetch('/data/cities.json').then((r) => r.json());
const city = cities.lv;
const meta = await getJson('terrain.json');
const [nearBuf, farBuf, net, corridorIndex, nearBmp, farBmp, wideBmp] = await Promise.all([
  getBin(meta.grids.near.file), getBin(meta.grids.far.file),
  loadRoutes({ fetchJson: getJson, fetchBinary: getBin }), getJson('corridor/index.json'),
  getBitmap('ground-near.jpg'), getBitmap('ground-far.jpg'), getBitmap('ground-wide.jpg'),
]);
const terrain = createTerrain({ meta, buffers: { near: nearBuf, far: farBuf }, base: city.base, fetchBinary: getBin });
await terrain.loadWide();

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const sky = createLegacySky().init({ scene, city, invalidate: () => {} });
const camera = new THREE.PerspectiveCamera(50, 1, 1, 200000);
const controls = new OrbitControls(camera, canvas);

const tex = (bmp) => {
  const t = new THREE.Texture(bmp);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.needsUpdate = true;
  return t;
};
const near = heightField(nearBuf, meta.grids.near), far = heightField(farBuf, meta.grids.far);
const ground = [{ mesh: terrainMesh(far, near, tex(farBmp), city.base) }, { mesh: terrainMesh(near, null, tex(nearBmp), city.base) }];
scene.add(ground[0].mesh, ground[1].mesh, buildWideMesh({ wide: terrain.grid('wide'), hole: far, base: city.base, map: tex(wideBmp) }));

const roads = new THREE.Group();
scene.add(roads);
const chunks = createRoadChunks({ roadnet: net.roadnet, base: city.base, earthR: EARTH_R, parent: roads, materials: createRoadMaterials({ anisotropy: renderer.capabilities.getMaxAnisotropy() }) });
const corridor = createCorridor({
  index: corridorIndex, fetchBinary: (f) => getBin(`corridor/${f}`), heightAt: terrain.heightAt,
  base: city.base, earthR: EARTH_R, parent: scene, anisotropy: renderer.capabilities.getMaxAnisotropy(),
});

const route = net.route('i15n');
const journey = createJourney({ route, road: net.roadOf(route), frame: createFrame(city), departMs: 0, startS: route.s0 ?? 0, city: 'lv' });
const rig = createRig();
const updateTimes = [];

function applyNight() {
  sky.apply({ night: isNight, imagery: true, terrain: ground });
  scene.background = new THREE.Color(isNight ? 0x3b3850 : 0xd3dee8);
  chunks.setNight(isNight);
  corridor.setLook({ night: isNight, dusk: isNight ? 1 : 0 });
}

function place() {
  const s = Math.min(journey.s1, Math.max(journey.s0, km * 1000));
  const pose = journey.poseAtS(s);
  controls.enabled = view === 'orbit';
  if (view === 'driver') {
    rig.look({ yaw, pitch, ...(lens ? { lens } : {}) });
    rig.apply(camera, pose, { width: innerWidth, height: innerHeight });
  } else {
    // from above: straight down over `at` (or the car), north up
    const x = at ? at[0] : pose.position.x, y = at ? at[1] : -pose.position.z;
    const gy = terrain.groundY(x, y);
    camera.near = 10; camera.far = 200000; camera.fov = 40; camera.aspect = innerWidth / innerHeight;
    if (view === 'above') {
      camera.position.set(x, gy + alt, -y + alt * 0.0001);
      camera.up.set(0, 0, -1);
      camera.lookAt(x, gy, -y);
    } else {
      controls.target.set(x, gy, -y);
      camera.position.set(x + alt * 0.4, gy + alt * 0.6, -y + alt * 0.6);
      controls.update();
    }
    camera.updateProjectionMatrix();
  }
  // from above over `at`, the corridor loads around that point, as if the car were there
  const frame = { pose: view !== 'driver' && at ? { position: { x: at[0], z: -at[1] } } : pose };
  const t0 = performance.now();
  corridor.update(frame);
  updateTimes.push(performance.now() - t0);
  chunks.update({ x: pose.position.x, y: -pose.position.z });
  return pose;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  place();
}
addEventListener('resize', resize);
addEventListener('keydown', (e) => {
  if (e.key === 'v') view = { driver: 'above', above: 'orbit', orbit: 'driver' }[view];
  else if (e.key === 'n') { isNight = !isNight; applyNight(); }
  else if (e.key === 'ArrowUp') km += 0.2;
  else if (e.key === 'ArrowDown') km -= 0.2;
  else if (e.key === 'a') yaw += 15;
  else if (e.key === 'd') yaw -= 15;
  else return;
  place();
});

applyNight();
resize();
renderer.setAnimationLoop(() => {
  if (view === 'orbit') controls.update();
  sky.dome.position.copy(camera.position); // the dome follows the camera, as in the drive
  renderer.render(scene, camera);
  const st = corridor.stats(), info = renderer.info.render;
  hud.textContent = `${view}  km ${km.toFixed(2)}  ${isNight ? 'night' : 'day'}\n`
    + `corridor: ${st.cells} cells${st.tall ? ' + tall' : ''}, ${st.buildings} buildings, ${st.drawCalls} draw calls, ${st.triangles.toLocaleString()} triangles, `
    + `slowest mesh ${st.meshMsMax.toFixed(1)} ms, loading ${st.loading}\nframe: ${info.calls} draw calls, ${info.triangles.toLocaleString()} triangles`;
});
await Promise.all([corridor.whenSettled(), chunks.whenSettled()]);
// the part's update when nothing loads: the same pose again, many times
place();
const still = { pose: view !== 'driver' && at ? { position: { x: at[0], z: -at[1] } } : journey.poseAtS(km * 1000) };
const t0 = performance.now();
for (let i = 0; i < 2000; i++) corridor.update(still);
window.__updateUs = ((performance.now() - t0) / 2000) * 1000;
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
window.__stats = corridor.stats();
window.__ready = true;

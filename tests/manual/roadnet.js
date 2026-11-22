// Dev page for the road ribbon: the synthetic fixture through the real worker, materials and chunk manager.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { decodeRoadNet } from '../../src/drive/roadnet/format.js';
import { createRoadMaterials } from '../../src/drive/roadnet/material.js';
import { createRoadChunks } from '../../src/drive/roadnet/chunks.js';
import { reflineOf } from '../../src/drive/roadnet/mesher.js';

const BASE = 620, EARTH_R = (6371000 * 7) / 6;
const params = new URLSearchParams(location.search);
let view = params.get('view') || 'orbit';
let s = +(params.get('s') ?? 400);
let isNight = params.get('night') === '1';
const look = THREE.MathUtils.degToRad(+(params.get('look') ?? 0));
const hud = document.getElementById('hud');

const [json, bin] = await Promise.all([
  fetch('/tests/fixtures/roadnet/roadnet.json').then((r) => r.json()),
  fetch('/tests/fixtures/roadnet/roadnet.bin').then((r) => r.arrayBuffer()),
]);
const roadnet = decodeRoadNet(json, bin);
const road = roadnet.roads[0];
const ref = reflineOf(road);
const scenePos = (x, y, h, out = new THREE.Vector3()) => out.set(x, h - BASE - (x * x + y * y) / (2 * EARTH_R), -y);

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
// the app's two looks (src/main.js DAY and NIGHT)
const DAY = { haze: 0xd3dee8, skyLight: 0xdbe8ff, groundLight: 0x8d8371, hemi: 0.8, sun: 0xfff0dc, sunPower: 2.7 };
const NIGHT = { haze: 0x3b3850, skyLight: 0x33426e, groundLight: 0x4a3a2a, hemi: 0.38, sun: 0x93a8d9, sunPower: 0.2 };
scene.fog = new THREE.FogExp2(DAY.haze, 0.000014);
const hemi = new THREE.HemisphereLight();
const sun = new THREE.DirectionalLight();
sun.position.set(-0.8, 0.53, 0.3);
scene.add(hemi, sun);

const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 60000);
const controls = new OrbitControls(camera, canvas);

// a crude ground below the road: 789 m with gentle swells, always under the 790 m+ pavement
const p0 = ref.at(1500);
const groundOrigin = scenePos(Math.round(p0.x), Math.round(p0.y), 789);
const gsize = 7000, gseg = 280;
const ground = new THREE.PlaneGeometry(gsize, gsize, gseg, gseg).rotateX(-Math.PI / 2);
const gp = ground.attributes.position;
for (let i = 0; i < gp.count; i++) {
  const x = Math.round(p0.x) + gp.getX(i), y = Math.round(p0.y) - gp.getZ(i);
  const h = 789 - 3 + 3 * Math.sin(x / 300) * Math.cos(y / 410) - Math.max(0, 0.002 * (Math.hypot(x - p0.x, y - p0.y) - 2000));
  gp.setY(i, h - BASE - (x * x + y * y) / (2 * EARTH_R) - groundOrigin.y);
}
ground.computeVertexNormals();
const groundMesh = new THREE.Mesh(ground, new THREE.MeshLambertMaterial({ color: 0xa89274 }));
groundMesh.position.copy(groundOrigin);
scene.add(groundMesh);

const materials = createRoadMaterials({ anisotropy: renderer.capabilities.getMaxAnisotropy() });
const roads = createRoadChunks({ roadnet, base: BASE, earthR: EARTH_R, parent: scene, materials });

function applyNight() {
  const L = isNight ? NIGHT : DAY;
  scene.background = new THREE.Color(L.haze);
  scene.fog.color.set(L.haze);
  hemi.color.set(L.skyLight); hemi.groundColor.set(L.groundLight); hemi.intensity = L.hemi;
  sun.color.set(L.sun); sun.intensity = L.sunPower;
  roads.setNight(isNight);
}

function place() {
  const p = ref.at(s);
  const dir = new THREE.Vector3(Math.cos(p.heading), 0, -Math.sin(p.heading));
  const at = scenePos(p.x, p.y, p.h);
  controls.enabled = view === 'orbit';
  if (view === 'driver') {
    // middle lane centre, 1.2 m up, looking along the road (and `look` to the left)
    camera.near = 0.5;
    camera.position.copy(at).y += 1.2;
    const yaw = p.heading + look;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.cos(yaw), p.grade - 0.02, -Math.sin(yaw))));
  } else if (view === 'hill') {
    camera.near = 2;
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    camera.position.copy(at).addScaledVector(side, 1500).addScaledVector(dir, -800).y += 250;
    camera.lookAt(at);
  } else {
    camera.near = 1;
    controls.target.copy(at);
    camera.position.copy(at).addScaledVector(dir, -60).add(new THREE.Vector3(30, 45, 0));
    controls.update();
  }
  camera.updateProjectionMatrix();
  roads.update({ x: p.x, y: p.y });
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
addEventListener('keydown', (e) => {
  if (e.key === 'v') view = { orbit: 'driver', driver: 'hill', hill: 'orbit' }[view];
  else if (e.key === 'n') { isNight = !isNight; applyNight(); }
  else if (e.key === 'ArrowUp') s = Math.min(ref.length, s + 20);
  else if (e.key === 'ArrowDown') s = Math.max(0, s - 20);
  else return;
  place();
});

resize();
applyNight();
place();
renderer.setAnimationLoop(() => {
  if (view === 'orbit') controls.update(); // it would turn the other views towards its target
  renderer.render(scene, camera);
  const st = roads.stats();
  hud.textContent = `${view}  s ${s.toFixed(0)} m  ${isNight ? 'night' : 'day'}\nL0 ${st.lod0}  L1 ${st.lod1}  batches ${st.batches}  draw calls ${st.drawCalls}  in flight ${st.inFlight}`;
});
await roads.whenSettled();
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
window.__ready = true;

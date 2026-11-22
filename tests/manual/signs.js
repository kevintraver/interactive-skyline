// Dev page for the roadside signs: the real roadnet, terrain and signs.json, the road modules and
// createRoadside, seen from the driver's eye at a chainage given in the address.
//   ?s=<chainage>&night=1&lane=<1-based from the left>&yaw=<deg, left positive>&pitch=<deg>&lens=<mm>
//   &view=driver|side   (side: 40 m off the road, looking back at the signs at s)
// keys: n toggles night, arrows drive 50 m.
import * as THREE from 'three';
import { decodeRoadNet } from '../../src/drive/roadnet/format.js';
import { createRoadMaterials } from '../../src/drive/roadnet/material.js';
import { createRoadChunks } from '../../src/drive/roadnet/chunks.js';
import { createRefline } from '../../src/drive/roadnet/refline.js';
import { edgesAt } from '../../src/drive/roadnet/crosssection.js';
import { heightField } from '../../src/world/terrain/heightfield.js';
import { createRoadside } from '../../src/drive/roadside/index.js';

const DATA = '/data/lv';
const BASE = 620, EARTH_R = (6371000 * 7) / 6;
const q = new URLSearchParams(location.search);
let s = +(q.get('s') ?? 41000);
let isNight = q.get('night') === '1';
const lane = +(q.get('lane') ?? 2), view = q.get('view') || 'driver';
const yaw = THREE.MathUtils.degToRad(+(q.get('yaw') ?? 0)), pitch = THREE.MathUtils.degToRad(+(q.get('pitch') ?? 0));
const lens = +(q.get('lens') ?? 50);
const hud = document.getElementById('hud');

const getJson = (n) => fetch(`${DATA}/${n}`).then((r) => r.json());
const getBin = (n) => fetch(`${DATA}/${n}`).then((r) => r.arrayBuffer());
const [json, bin, signs, terrainMeta] = await Promise.all([getJson('roadnet.json'), getBin('roadnet.bin'), getJson('signs.json'), getJson('terrain.json')]);
const grids = Object.fromEntries(await Promise.all(['near', 'far', 'wide'].map(async (n) => [n, heightField(await getBin(terrainMeta.grids[n].file), terrainMeta.grids[n])])));
const heightAt = (x, y) => (grids.near.contains(x, y) ? grids.near : grids.far.contains(x, y) ? grids.far : grids.wide).sample(x, y);
const roadnet = decodeRoadNet(json, bin);
const road = roadnet.roads.find((r) => r.id === 'i15n.main');
const ref = createRefline(road);
const scenePos = (x, y, h, out = new THREE.Vector3()) => out.set(x, h - BASE - (x * x + y * y) / (2 * EARTH_R), -y);

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: false });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const DAY = { haze: 0xd3dee8, skyLight: 0xdbe8ff, groundLight: 0x8d8371, hemi: 0.8, sun: 0xfff0dc, sunPower: 2.7 };
const NIGHT = { haze: 0x3b3850, skyLight: 0x33426e, groundLight: 0x4a3a2a, hemi: 0.38, sun: 0x93a8d9, sunPower: 0.2 };
scene.fog = new THREE.FogExp2(DAY.haze, 0.000014);
const hemi = new THREE.HemisphereLight();
const sun = new THREE.DirectionalLight();
sun.position.set(-0.8, 0.53, 0.3);
scene.add(hemi, sun);
const camera = new THREE.PerspectiveCamera(30, 1, 1, 60000);

// the ground around the camera from the app's own grids, curvature baked, relative to its centre
let groundMesh = null;
function buildGround(cx, cy) {
  if (groundMesh) { scene.remove(groundMesh); groundMesh.geometry.dispose(); }
  const size = 6000, seg = 300;
  cx = Math.round(cx); cy = Math.round(cy);
  const o = scenePos(cx, cy, heightAt(cx, cy));
  const g = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = cx + p.getX(i), y = cy - p.getZ(i);
    p.setY(i, scenePos(x, y, heightAt(x, y)).y - o.y);
  }
  g.computeVertexNormals();
  groundMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xb09a7c }));
  groundMesh.position.copy(o);
  scene.add(groundMesh);
}

const roadsGroup = new THREE.Group();
scene.add(roadsGroup);
const materials = createRoadMaterials({ anisotropy: renderer.capabilities.getMaxAnisotropy() });
const roads = createRoadChunks({ roadnet, base: BASE, earthR: EARTH_R, parent: roadsGroup, materials });
const roadside = createRoadside({ signs, roadnet, base: BASE, earthR: EARTH_R, parent: scene, anisotropy: renderer.capabilities.getMaxAnisotropy() });
window.__roadside = roadside;

function applyNight() {
  const L = isNight ? NIGHT : DAY;
  scene.background = new THREE.Color(L.haze);
  scene.fog.color.set(L.haze);
  hemi.color.set(L.skyLight); hemi.groundColor.set(L.groundLight); hemi.intensity = L.hemi;
  sun.color.set(L.sun); sun.intensity = L.sunPower;
  roads.setNight(isNight);
  roadside.setNight(isNight);
}

function place() {
  const p = ref.at(s);
  const cs = edgesAt(road, s);
  const strip = cs.strips.find((x) => x.kind === 'lane' && x.lane === lane - 1) || cs.strips.find((x) => x.kind === 'lane');
  const d = (strip.left + strip.right) / 2;
  const mx = p.x - Math.sin(p.heading) * d, my = p.y + Math.cos(p.heading) * d;
  const eye = scenePos(mx, my, p.h + p.crossfall * d);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = (2 * Math.atan(18 / lens / camera.aspect) * 180) / Math.PI;
  if (view === 'side') {
    const right = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
    camera.position.copy(eye).addScaledVector(right, 40).add(new THREE.Vector3(Math.cos(p.heading), 0, -Math.sin(p.heading)).multiplyScalar(60)).y += 6;
    camera.lookAt(eye.clone().addScaledVector(right, 12));
  } else {
    camera.position.copy(eye).y += 1.2;
    const h = p.heading + yaw;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.cos(h) * Math.cos(pitch), Math.sin(pitch) + p.grade * 0, -Math.sin(h) * Math.cos(pitch))));
  }
  camera.near = 1;
  camera.updateProjectionMatrix();
  buildGround(mx, my);
  roads.update({ x: mx, y: my });
  roadside.update({ x: mx, y: my });
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  place();
}
addEventListener('resize', resize);
addEventListener('keydown', (e) => {
  if (e.key === 'n') { isNight = !isNight; applyNight(); } else if (e.key === 'ArrowUp') s += 50; else if (e.key === 'ArrowDown') s -= 50; else return;
  place();
});

resize();
applyNight();
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  const a = roadside.stats(), b = roads.stats();
  hud.textContent = `s ${s.toFixed(0)} m  ${isNight ? 'night' : 'day'}  lens ${lens} mm\nsigns shown ${a.shown}/${a.signs}  faces ${a.faces}  atlas ${a.pages} page(s) at ${a.ppm} px/m\nsign draw calls ${a.drawCalls}  triangles ${a.triangles}  road draw calls ${b.drawCalls}`;
});
// the road is another module's; do not hang the page if it never settles
await Promise.all([Promise.race([roads.whenSettled(), new Promise((r) => setTimeout(r, 15000))]), roadside.whenSettled()]);
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
window.__ready = true;

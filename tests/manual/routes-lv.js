// Dev page for any of the Las Vegas routes (a copy of roadnet-lv.js that goes through the route
// loader): routes.json and the chosen route's own RoadNet (from public/data/lv, or the folder in
// ?data=), the app's terrain grids as a plain ground, the road modules through the real worker.
// Signs and barriers are drawn where the route has them. Views: driver (1.2 m above a lane of the
// route's road at s), chase (40 m up, 120 m behind), side (60 m off the road), top (north up).
//   ?route=i15n|i15s|us93&s=<chainage>&view=driver|chase|side|top&lane=<1-based from the left>&yaw=<deg>
//   &pitch=<deg>&lens=<mm>&alt=<m, top view>&back=&up=&off=&ahead=<m, chase view>&night=1&data=<url>
// keys: n toggles night, arrows drive 50 m.
import * as THREE from 'three';
import { createRoadMaterials } from '../../src/drive/roadnet/material.js';
import { createRoadChunks } from '../../src/drive/roadnet/chunks.js';
import { createRefline } from '../../src/drive/roadnet/refline.js';
import { edgesAt } from '../../src/drive/roadnet/crosssection.js';
import { heightField } from '../../src/world/terrain/heightfield.js';
import { createRoadside } from '../../src/drive/roadside/index.js';
import { loadRoutes } from '../../src/drive/routes.js';

const q = new URLSearchParams(location.search);
const DATA = q.get('data') || '/data/lv';
const BASE = 620, EARTH_R = (6371000 * 7) / 6;
const ROUTE = q.get('route') || 'i15n';
let isNight = q.get('night') === '1';
const lane = +(q.get('lane') ?? 2), view = q.get('view') || 'driver';
const yaw = THREE.MathUtils.degToRad(+(q.get('yaw') ?? 0)), pitch = THREE.MathUtils.degToRad(+(q.get('pitch') ?? 0));
const lens = +(q.get('lens') ?? 28), alt = +(q.get('alt') ?? 900);
const hud = document.getElementById('hud');

const getJson = (base, n) => fetch(`${base}/${n}`).then((r) => r.json());
const getBin = (base, n) => fetch(`${base}/${n}`).then((r) => r.arrayBuffer());
const opt = (n) => (q.get('furniture') === '0' ? Promise.resolve(null) : getJson(DATA, n).catch(() => null));
const net = await loadRoutes({ fetchJson: (n) => getJson(DATA, n), fetchBinary: (n) => getBin(DATA, n) }, { route: ROUTE });
const files = net.filesOf(ROUTE);
const [terrainMeta, signsDoc, barriersDoc] = await Promise.all([getJson('/data/lv', 'terrain.json'), opt(files.signs),
  opt(files.roadnet === 'roadnet.json' ? 'barriers.json' : `barriers-${ROUTE}.json`)]);
let s = +(q.get('s') ?? net.route(ROUTE).starts.reveal);
const grids = Object.fromEntries(await Promise.all(['near', 'far', 'wide'].map(async (n) => [n, heightField(await getBin('/data/lv', terrainMeta.grids[n].file), terrainMeta.grids[n])])));
const heightAt = (x, y) => (grids.near.contains(x, y) ? grids.near : grids.far.contains(x, y) ? grids.far : grids.wide).sample(x, y);
const { roadnet, road } = await net.loadRoute(ROUTE);
const ref = createRefline(road);
const scenePos = (x, y, h, out = new THREE.Vector3()) => out.set(x, h - BASE - (x * x + y * y) / (2 * EARTH_R), -y);

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
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
const camera = new THREE.PerspectiveCamera(40, 1, 1, 60000);

let groundMesh = null;
function buildGround(cx, cy) {
  if (groundMesh) { scene.remove(groundMesh); groundMesh.geometry.dispose(); }
  const size = 8000, seg = 400;
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
const roads = createRoadChunks({ roadnet, base: BASE, earthR: EARTH_R, parent: roadsGroup, materials, barriers: barriersDoc });
const roadside = signsDoc && createRoadside({ signs: signsDoc, barriers: barriersDoc, roadnet, base: BASE, earthR: EARTH_R, parent: roadsGroup, anisotropy: renderer.capabilities.getMaxAnisotropy() });

function applyNight() {
  const L = isNight ? NIGHT : DAY;
  scene.background = new THREE.Color(L.haze);
  scene.fog.color.set(L.haze);
  hemi.color.set(L.skyLight); hemi.groundColor.set(L.groundLight); hemi.intensity = L.hemi;
  sun.color.set(L.sun); sun.intensity = L.sunPower;
  roads.setNight(isNight);
  roadside?.setNight(isNight);
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
  const fwd = new THREE.Vector3(Math.cos(p.heading), 0, -Math.sin(p.heading));
  const right = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
  camera.up.set(0, 1, 0);
  if (view === 'top') {
    camera.position.copy(eye).y += alt;
    camera.up.set(0, 0, -1); // north up
    camera.lookAt(eye);
  } else if (view === 'chase') {
    const back = +(q.get('back') ?? 120), up = +(q.get('up') ?? 40), side = +(q.get('off') ?? 0);
    camera.position.copy(eye).addScaledVector(fwd, -back).addScaledVector(right, side).y += up;
    camera.lookAt(eye.clone().addScaledVector(fwd, +(q.get('ahead') ?? 150)));
  } else if (view === 'side') {
    camera.position.copy(eye).addScaledVector(right, 60).addScaledVector(fwd, 80).y += 8;
    camera.lookAt(eye.clone().addScaledVector(right, 15));
  } else {
    camera.position.copy(eye).y += 1.2;
    const h = p.heading + yaw;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.cos(h) * Math.cos(pitch), Math.sin(pitch), -Math.sin(h) * Math.cos(pitch))));
  }
  camera.near = view === 'top' ? 10 : 1;
  camera.updateProjectionMatrix();
  buildGround(mx, my);
  roads.update({ x: mx, y: my });
  roadside?.update({ x: mx, y: my });
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
  const b = roads.stats();
  const rs = roadside?.stats();
  hud.textContent = `${ROUTE}  ${view}  s ${s.toFixed(0)} m  ${isNight ? 'night' : 'day'}  lens ${lens} mm\nroads ${roadnet.roads.length}  junctions ${roadnet.junctions.length}  structures ${roadnet.structures.length}\nroad draw calls ${b.drawCalls}  triangles ${Math.round(b.triangles)}  L0 ${b.lod0}  L1 ${b.lod1}` +
    (rs ? `\nroadside draw calls ${rs.drawCalls}  triangles ${Math.round(rs.triangles)}  signs ${rs.shown}  delineators ${rs.delineators ?? 0}` : '');
  window.__stats = { roads: b, roadside: rs };
});
await Promise.race([Promise.all([roads.whenSettled(), roadside?.whenSettled()]), new Promise((r) => setTimeout(r, 30000))]);
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
window.__ready = true;

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { loadCustomModels, placeModel } from './customModels.js';
import { night, lightAtNight } from './night.js';
import { initAttractions } from './attractions.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Which city to show: ?city=<id> in the address, else the one used last time.
const CITY_STORE = 'skyline-city';
const cities = await fetch('/data/cities.json').then((r) => r.json());
let cityId = new URLSearchParams(location.search).get('city');
if (!cities[cityId]) { try { cityId = localStorage.getItem(CITY_STORE); } catch { /* no storage */ } }
if (!cities[cityId]) cityId = Object.keys(cities)[0];
try { localStorage.setItem(CITY_STORE, cityId); } catch { /* no storage */ }
const city = cities[cityId];
const DATA = `/data/${cityId}`;
document.title = `Interactive Skyline · ${city.name}`;

// World units are meters. x = east, y = up, z = south, origin at the city's reference point.
const BASE = city.base; // elevation subtracted from everything to keep numbers small
const EARTH_R = 6371000 * (7 / 6); // standard refraction
const LENS_HFOV = 39.6; // horizontal field of view of a 50 mm lens on full frame
const M_TO_FT = 3.28084;

const SOURCE = {
  'osm-height': 'height tagged in OpenStreetMap',
  lidar: `measured from ${city.lidar.year} USGS LiDAR`,
  'osm-levels': 'estimated from floor count',
  guess: 'height unknown, assumed',
};

// User-adjustable behaviour, kept between visits. `cutoff` is in meters.
const DEFAULTS = { cutoff: 35, highlight: true, click: 'select', markers: true, units: 'ft', imagery: true, night: false, fountain: true, wheel: true };
const STORE = 'slc-skyline-settings';
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE)) || {};
    return Object.fromEntries(Object.keys(DEFAULTS).filter((k) => typeof saved[k] === typeof DEFAULTS[k]).map((k) => [k, saved[k]]));
  } catch { return {}; }
}
const settings = { ...DEFAULTS, ...loadSettings() };
function saveSettings() { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* private window: settings last for this visit only */ } }

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;

// Sky, haze and light, by day and by night. `street` is how strongly the ground glows from street lighting
// (near grid, far grid); the moon stands in for the sun so shadows stay where they are.
const DAY = { haze: 0xd3dee8, zenith: 0x4f86c9, skyLight: 0xdbe8ff, groundLight: 0x8d8371, hemi: 0.8, sun: 0xfff0dc, sunPower: 2.7, tint: 0.45, street: [0, 0] };
const NIGHT = { haze: 0x3b3850, zenith: 0x05070f, skyLight: 0x33426e, groundLight: 0x4a3a2a, hemi: 0.38, sun: 0x93a8d9, sunPower: 0.2, tint: 0.16, street: [0.07, 0.26] };
const STREET_GLOW = 0xffa858;
const HAZE = new THREE.Color(DAY.haze), ZENITH = new THREE.Color(DAY.zenith);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(HAZE, 0.000014);

const camera = new THREE.PerspectiveCamera(27, 1, 5, 150000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.zoomToCursor = true;
// Map-style: drag slides the ground, Cmd/Ctrl/Shift-drag (or right-drag) turns and tilts the view.
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI * 0.52;
controls.minDistance = 150;
controls.maxDistance = 30000;

let dirty = true;
const invalidate = () => { dirty = true; };
controls.addEventListener('change', invalidate);

// ------------------------------------------------------------------ sky + light
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(120000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { horizon: { value: HAZE }, zenith: { value: ZENITH } },
    vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; varying vec3 d;
      void main(){ float t = pow(clamp(d.y, 0.0, 1.0), 0.45); gl_FragColor = vec4(mix(horizon, zenith, t), 1.0); }`,
  }),
));

const hemi = new THREE.HemisphereLight(DAY.skyLight, DAY.groundLight, DAY.hemi);
scene.add(hemi);
const sun = new THREE.DirectionalLight(DAY.sun, DAY.sunPower);
// afternoon sun in the west-southwest, 32 degrees up
const az = THREE.MathUtils.degToRad(245), el = THREE.MathUtils.degToRad(32);
// the shadow map covers a square around the towers, sized per city
const shade = city.shadow;
sun.target.position.set(shade.x, 0, -shade.y);
sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(shade.half * 2.5).add(sun.target.position);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -shade.half, right: shade.half, top: shade.half, bottom: -shade.half, near: shade.half * 0.5, far: shade.half * 4.5 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 1.2;
scene.add(sun, sun.target);

// ------------------------------------------------------------------ terrain
const curveDrop = (x, z) => (x * x + z * z) / (2 * EARTH_R);
const lerp = THREE.MathUtils.lerp;

function heightField(buf, g) {
  const raw = new Uint16Array(buf);
  const at = (i, j) => raw[j * g.nx + i] * g.scale;
  return {
    ...g, at,
    sample(x, y) {
      const fx = THREE.MathUtils.clamp((x - g.x0) / g.step, 0, g.nx - 1.001);
      const fy = THREE.MathUtils.clamp((y - g.y0) / g.step, 0, g.ny - 1.001);
      const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j;
      return lerp(lerp(at(i, j), at(i + 1, j), ax), lerp(at(i, j + 1), at(i + 1, j + 1), ax), ay);
    },
    contains(x, y, inset = 0) {
      return x > g.x0 + inset && x < g.x0 + (g.nx - 1) * g.step - inset
        && y > g.y0 + inset && y < g.y0 + (g.ny - 1) * g.step - inset;
    },
  };
}

function terrainMesh(hf, hole, map) {
  const { nx, ny, step, x0, y0, at } = hf;
  const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3, x = x0 + i * step, y = y0 + j * step, h = at(i, j);
      // inside the fine grid's footprint the coarse grid sits just underneath it
      const sink = hole && hole.contains(x, y) ? 8 : 0;
      pos[k] = x; pos[k + 1] = h - BASE - curveDrop(x, y) - sink; pos[k + 2] = -y;
      const dx = (at(Math.min(i + 1, nx - 1), j) - at(Math.max(i - 1, 0), j)) / (2 * step);
      const dy = (at(i, Math.min(j + 1, ny - 1)) - at(i, Math.max(j - 1, 0))) / (2 * step);
      const l = Math.hypot(dx, 1, dy);
      nor[k] = -dx / l; nor[k + 1] = 1 / l; nor[k + 2] = dy / l;
      uv[(j * nx + i) * 2] = i / (nx - 1); uv[(j * nx + i) * 2 + 1] = j / (ny - 1);
    }
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (hole && hole.contains(x0 + i * step, y0 + j * step, step) && hole.contains(x0 + (i + 1) * step, y0 + (j + 1) * step, step)) continue;
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map }));
  mesh.receiveShadow = !hole;
  return mesh;
}

// ------------------------------------------------------------------ buildings
function ring(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(flat[i], flat[i + 1]));
  return pts;
}

/** Append one extruded footprint (walls + flat roof) to the output arrays. */
function extrude(vol, out, tint) {
  const outer = ring(vol.o);
  if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse();
  const holes = vol.h.map(ring).map((h) => (THREE.ShapeUtils.isClockWise(h) ? h : h.reverse()));
  const bot = vol.b - BASE, roofTop = vol.t - BASE;
  const top = vol.r ? roofTop - vol.r[1] : roofTop; // where the walls stop
  const push = (x, y, mapY, nx, ny, nz, shade) => {
    out.pos.push(x, y, -mapY); out.nor.push(nx, ny, nz);
    out.col.push(tint[0] * shade, tint[1] * shade, tint[2] * shade);
  };
  for (const r of vol.u ? [] : [outer, ...holes]) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
      const nx = dy / l, nz = dx / l; // outward normal of a counter-clockwise ring, in world axes
      push(p.x, bot, p.y, nx, 0, nz, 1); push(q.x, bot, q.y, nx, 0, nz, 1); push(q.x, top, q.y, nx, 0, nz, 1);
      push(p.x, bot, p.y, nx, 0, nz, 1); push(q.x, top, q.y, nx, 0, nz, 1); push(p.x, top, p.y, nx, 0, nz, 1);
    }
  }
  if (vol.u) {
    // Hand-modelled piece: the walls run from the footprint to a second outline at the top,
    // so it can lean or taper.
    const up = ring(vol.u);
    if (THREE.ShapeUtils.isClockWise(up)) up.reverse();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3();
    const tri = (a, ya, b, yb, c, yc) => {
      A.set(a.x, ya, -a.y); B.set(b.x, yb, -b.y); C.set(c.x, yc, -c.y);
      n.subVectors(B, A).cross(C.sub(A));
      if (n.lengthSq() < 1e-6) return;
      n.normalize();
      push(a.x, ya, a.y, n.x, n.y, n.z, 1); push(b.x, yb, b.y, n.x, n.y, n.z, 1); push(c.x, yc, c.y, n.x, n.y, n.z, 1);
    };
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      tri(outer[i], bot, outer[j], bot, up[j], roofTop);
      tri(outer[i], bot, up[j], roofTop, up[i], roofTop);
    }
    for (const t of THREE.ShapeUtils.triangulateShape(up, [])) for (const i of t) push(up[i].x, roofTop, up[i].y, 0, 1, 0, 0.86);
    for (const t of THREE.ShapeUtils.triangulateShape(outer, [])) for (const i of [t[2], t[1], t[0]]) push(outer[i].x, bot, outer[i].y, 0, -1, 0, 0.8);
    return;
  }
  if (vol.r) {
    // Pyramid or dome: shrink the footprint toward its center in steps as it rises.
    const [kind, rh] = vol.r, steps = kind === 'd' ? 7 : 1;
    const cx = outer.reduce((a, p) => a + p.x, 0) / outer.length, cy = outer.reduce((a, p) => a + p.y, 0) / outer.length;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3();
    const tri = (a, ya, b, yb, c, yc) => {
      A.set(a.x, ya, -a.y); B.set(b.x, yb, -b.y); C.set(c.x, yc, -c.y);
      n.subVectors(B, A).cross(C.sub(A));
      if (n.lengthSq() < 1e-6) return;
      n.normalize();
      push(a.x, ya, a.y, n.x, n.y, n.z, 0.93); push(b.x, yb, b.y, n.x, n.y, n.z, 0.93); push(c.x, yc, c.y, n.x, n.y, n.z, 0.93);
    };
    let prev = outer, prevY = top;
    for (let s = 1; s <= steps; s++) {
      const a = (s / steps) * Math.PI / 2;
      const k = kind === 'd' ? Math.cos(a) : 0, y = top + rh * (kind === 'd' ? Math.sin(a) : 1);
      const cur = outer.map((p) => new THREE.Vector2(cx + (p.x - cx) * k, cy + (p.y - cy) * k));
      for (let i = 0; i < outer.length; i++) {
        const j = (i + 1) % outer.length;
        tri(prev[i], prevY, prev[j], prevY, cur[j], y);
        tri(prev[i], prevY, cur[j], y, cur[i], y);
      }
      prev = cur; prevY = y;
    }
    return;
  }
  const all = [outer, ...holes].flat();
  for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) {
    for (const i of tri) push(all[i].x, top, all[i].y, 0, 1, 0, 0.86);
  }
}

function toGeometry(out) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
  // night light baked into a hand-made model; extruded buildings have none and read as zero
  if (out.glow) geo.setAttribute('glow', new THREE.Float32BufferAttribute(out.glow, 3));
  if (out.win) geo.setAttribute('windows', new THREE.Float32BufferAttribute(out.win, 1));
  if (out.led) geo.setAttribute('led', new THREE.Float32BufferAttribute(out.led, 1));
  return geo;
}

const fresh = () => ({ pos: [], nor: [], col: [] });
const inFeet = (m) => `${Math.round(m * M_TO_FT).toLocaleString()} ft`;
const inMeters = (m) => `${Math.round(m * 10) / 10} m`;
const fmt = (m) => (settings.units === 'm' ? inMeters(m) : inFeet(m));
const fmtOther = (m) => (settings.units === 'm' ? inFeet(m) : inMeters(m));
const label = (b) => b.name || 'Unnamed building';

// ------------------------------------------------------------------ load
const [terrainMeta, model, customModels] = await Promise.all([
  fetch(`${DATA}/terrain.json`).then((r) => r.json()),
  fetch(`${DATA}/buildings.json`).then((r) => r.json()),
  loadCustomModels(cityId),
]);
const [farBuf, nearBuf] = await Promise.all(
  ['far', 'near'].map((k) => fetch(`${DATA}/${terrainMeta.grids[k].file}`).then((r) => r.arrayBuffer())),
);
const near = heightField(nearBuf, terrainMeta.grids.near);
const far = heightField(farBuf, terrainMeta.grids.far);
const loadTexture = (url) => new THREE.TextureLoader().loadAsync(url).then((t) => {
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
});
const [farMap, nearMap] = await Promise.all([loadTexture(`${DATA}/ground-far.jpg`), loadTexture(`${DATA}/ground-near.jpg`)]);
const terrain = [{ mesh: terrainMesh(far, near, farMap), map: farMap }, { mesh: terrainMesh(near, null, nearMap), map: nearMap }];
scene.add(terrain[0].mesh, terrain[1].mesh);

const lowMat = lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true }));
const tall = []; // removable buildings, tallest first: { data, mesh, marker, row, offset }
let low = null; // every other building, merged into one mesh
const tallGroup = new THREE.Group();
const markerGroup = new THREE.Group();
scene.add(tallGroup, markerGroup);
// Removable towers wear their own color so they read at a glance against the gray city.
const REMOVABLE = new THREE.Color(0x6fb0ea);
const GRAY = new THREE.Color().setRGB(0.80, 0.775, 0.74);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x16324d, transparent: true, opacity: 0.7 });
const outlineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });

/** Flat footprint on the ground where a tower really stands, shown once it is hidden or moved away. */
function groundMarker(b) {
  const y = b.ground - BASE + 1.2, fill = [], line = [];
  // only what touches the ground: a pod or an upper setback is not part of the footprint
  const grounded = b.v.filter((v) => v.b <= b.ground + 1);
  for (const v of grounded.length ? grounded : b.v) {
    const outer = ring(v.o), holes = v.h.map(ring), all = [outer, ...holes].flat();
    for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) for (const i of tri) fill.push(all[i].x, y, -all[i].y);
    for (const r of [outer, ...holes]) {
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        line.push(p.x, y + 0.3, -p.y, q.x, y + 0.3, -q.y);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
  const marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: REMOVABLE, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, fog: false,
  }));
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
  marker.add(new THREE.LineSegments(lineGeo, outlineMat));
  marker.visible = false;
  return marker;
}

function disposeGeometry(obj) {
  obj.traverse((o) => { if (o.geometry) { o.geometry.disposeBoundsTree(); o.geometry.dispose(); } });
}

/** Split the city at the height cutoff: one mesh per removable tower, one merged mesh for the rest. */
function buildCity() {
  const wasHidden = new Set(tall.filter((t) => !t.mesh.visible).map((t) => t.data.id));
  const wasMoved = new Map(tall.map((t) => [t.data.id, t.offset]));
  for (const t of tall) {
    disposeGeometry(t.mesh); t.mesh.material.dispose();
    disposeGeometry(t.marker); t.marker.material.dispose();
  }
  tallGroup.clear();
  markerGroup.clear();
  if (low) { scene.remove(low); disposeGeometry(low); }
  tall.length = 0;

  const lowOut = fresh();
  for (const b of model.buildings) {
    if (b.h >= settings.cutoff || customModels.has(b.id)) {
      const out = fresh(), custom = customModels.get(b.id);
      if (custom) placeModel(custom, b.c[0], b.c[1], b.ground - BASE, out);
      else for (const v of b.v) extrude(v, out, [1, 1, 1]);
      const geo = toGeometry(out);
      geo.computeBoundsTree();
      // a little self-light keeps the shaded faces blue instead of near-black
      const mesh = new THREE.Mesh(geo, lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a5f96 }), { windows: !custom }));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.visible = !wasHidden.has(b.id);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat));
      const marker = groundMarker(b);
      // offset: how far the user has dragged it from where it really stands
      mesh.userData.entry = marker.userData.entry = { data: b, mesh, marker, row: null, offset: wasMoved.get(b.id) || new THREE.Vector3() };
      tall.push(mesh.userData.entry);
      tallGroup.add(mesh);
      markerGroup.add(marker);
    } else {
      // a little per-building variation so blocks of houses read as separate roofs
      const n = Math.sin(b.c[0] * 12.9898 + b.c[1] * 78.233) * 43758.5453;
      const k = 0.93 + 0.07 * (n - Math.floor(n));
      for (const v of b.v) extrude(v, lowOut, [GRAY.r * k, GRAY.g * k, GRAY.b * k]);
    }
  }
  const lowGeo = toGeometry(lowOut);
  lowGeo.computeBoundsTree();
  low = new THREE.Mesh(lowGeo, lowMat);
  low.castShadow = low.receiveShadow = true;
  scene.add(low);
}

// ------------------------------------------------------------------ viewpoints
const groundY = (x, y) => (near.contains(x, y) ? near.sample(x, y) : far.sample(x, y)) - BASE - curveDrop(x, y);

function summit(p, radius = 120) {
  let best = { ...p, h: -Infinity };
  for (let dx = -radius; dx <= radius; dx += 10) {
    for (let dy = -radius; dy <= radius; dy += 10) {
      const h = near.sample(p.x + dx, p.y + dy);
      if (h > best.h) best = { x: p.x + dx, y: p.y + dy, h };
    }
  }
  return best;
}
// Each city lists its viewpoints in local meters: an eye (above ground, or at a fixed elevation,
// optionally snapped to the nearest summit) and the point it looks at.
const VIEWS = {};
const viewBar = document.querySelector('.views');
for (const v of city.views) {
  const e = v.eye.summit ? summit(v.eye, v.eye.summit) : v.eye;
  const eyeY = v.eye.elev !== undefined ? v.eye.elev - BASE : groundY(e.x, e.y) + v.eye.agl;
  VIEWS[v.id] = {
    pos: new THREE.Vector3(e.x, eyeY, -e.y),
    target: new THREE.Vector3(v.target.x, groundY(v.target.x, v.target.y) + v.target.agl, -v.target.y),
  };
  const btn = Object.assign(document.createElement('button'), { textContent: v.label });
  btn.dataset.view = v.id;
  viewBar.append(btn);
}
let activeView = null;
function setView(name) {
  activeView = name;
  camera.position.copy(VIEWS[name].pos);
  controls.target.copy(VIEWS[name].target);
  // updating once with damping off discards any leftover spin from the last drag
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
  for (const btn of document.querySelectorAll('.views button')) btn.classList.toggle('active', btn.dataset.view === name);
  invalidate();
}
for (const btn of document.querySelectorAll('.views button')) btn.addEventListener('click', () => setView(btn.dataset.view));
controls.addEventListener('change', () => {
  if (activeView && camera.position.distanceTo(VIEWS[activeView].pos) > 1) {
    activeView = null;
    document.querySelectorAll('.views button').forEach((b) => b.classList.remove('active'));
  }
  // keep the camera out of the ground
  const floor = groundY(camera.position.x, -camera.position.z) + 1.7;
  if (camera.position.y < floor) camera.position.y = floor;
});

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // hold the horizontal field of view of a 50 mm lens, whatever the window shape
  const v = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(LENS_HFOV) / 2) / camera.aspect);
  camera.fov = Math.min(THREE.MathUtils.radToDeg(v), 60);
  // on a wide window, shift the picture right so its center is the middle of the area the panel leaves free
  if (w > 720) camera.setViewOffset(w, h, -158, 0, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  invalidate();
}
addEventListener('resize', resize);

// ------------------------------------------------------------------ hide / show
const list = document.getElementById('list');
const count = document.getElementById('count');
const showAll = document.getElementById('show-all');
const hideAll = document.getElementById('hide-all');
const resetAll = document.getElementById('reset-all');
const search = document.getElementById('search');
const empty = document.getElementById('empty');
const card = document.getElementById('card');
const menu = document.getElementById('menu');
const toast = document.getElementById('toast');
const tip = document.getElementById('tip');

const HOVER = new THREE.Color(0xa9d6ff), SELECT = new THREE.Color(0xf0623c), WHITE = new THREE.Color(0xffffff);
let hovered = null, selected = null;
const history = []; // undo stack: { done, undone, revert() }

const isHidden = (e) => !e.mesh.visible;
const isMoved = (e) => e.offset.lengthSq() > 0.01;
const details = (b) => `${fmt(b.h)} · ${fmtOther(b.h)}${b.levels ? ` · ${b.levels} floors` : ''}`;
const visibleTaller = (e) => tall.filter((t) => !isHidden(t) && t.data.h > e.data.h);
const plural = (n) => `${n} building${n === 1 ? '' : 's'}`;

/** Bring one building's color, marker and list row in line with the current state and settings. */
function paint(e) {
  const m = e.mesh.material;
  m.color.copy(e === selected ? SELECT : e === hovered ? (settings.highlight ? HOVER : WHITE) : settings.highlight ? REMOVABLE : GRAY);
  m.emissiveIntensity = settings.highlight && e !== selected ? (settings.night ? NIGHT : DAY).tint : 0;
  e.mesh.children[0].visible = settings.highlight;
  e.mesh.position.copy(e.offset);
  e.marker.visible = settings.markers && (isHidden(e) || isMoved(e));
  e.marker.material.opacity = e === hovered ? 0.75 : 0.42;
}

function refresh() {
  const hidden = tall.filter(isHidden).length, moved = tall.filter(isMoved).length;
  count.textContent = hidden || moved
    ? [hidden && `${hidden} hidden`, moved && `${moved} moved`].filter(Boolean).join(' · ') + ` of ${tall.length}`
    : `${tall.length} over ${fmt(settings.cutoff)}`;
  showAll.disabled = hidden === 0;
  hideAll.disabled = hidden === tall.length;
  resetAll.disabled = hidden === 0 && moved === 0;
  renderer.shadowMap.needsUpdate = true;
  invalidate();
}

function setHover(entry) {
  if (hovered === entry) return;
  const prev = hovered;
  hovered = entry;
  if (prev) { paint(prev); prev.row.classList.remove('hover'); }
  if (entry) { paint(entry); entry.row.classList.add('hover'); }
  canvas.classList.toggle('hot', !!entry);
  invalidate();
}

function select(entry) {
  const prev = selected;
  selected = entry && !isHidden(entry) ? entry : null;
  if (prev) { paint(prev); prev.row.classList.remove('selected'); }
  card.hidden = !selected;
  if (selected) {
    paint(selected);
    selected.row.classList.add('selected');
    selected.row.scrollIntoView({ block: 'nearest' });
    hideToast();
    updateCard();
  }
  invalidate();
}
function updateCard() {
  if (!selected) return;
  const b = selected.data, taller = visibleTaller(selected).length;
  card.querySelector('b').textContent = label(b);
  card.querySelector('.meta').textContent = `${details(b)} · ${isMoved(selected) ? 'moved from its real spot' : 'drag it to move it'}`;
  const more = card.querySelector('[data-act="taller"]');
  more.hidden = taller === 0;
  more.textContent = `Hide this and ${taller} taller`;
  card.querySelector('[data-act="back"]').hidden = !isMoved(selected);
}

function syncRow(e) {
  const hidden = isHidden(e);
  e.row.classList.toggle('off', hidden);
  const act = e.row.querySelector('.act');
  act.textContent = hidden ? 'Show' : 'Hide';
  act.setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} ${label(e.data)}`);
  e.row.classList.toggle('moved', isMoved(e));
  e.row.querySelector('.back').hidden = !isMoved(e);
}

/** Hide or restore a set of buildings as one undoable step. */
function apply(entries, hidden, record = true) {
  const changed = entries.filter((e) => isHidden(e) !== hidden);
  if (!changed.length) return;
  for (const e of changed) {
    e.mesh.visible = !hidden;
    if (hovered === e) setHover(null);
    paint(e);
    syncRow(e);
  }
  if (hidden && changed.includes(selected)) select(null);
  if (record) {
    const what = changed.length === 1 ? label(changed[0].data) : plural(changed.length);
    remember(`${hidden ? 'Hidden' : 'Restored'}: ${what}`, `${hidden ? 'Restored' : 'Hidden again'}: ${what}`, () => apply(changed, !hidden, false));
  }
  refresh();
}

// ------------------------------------------------------------------ moving buildings
/** Put a building `x` meters east and `z` meters south of its real spot, standing on the ground there. */
function place(e, x, z) {
  const [cx, cy] = e.data.c;
  if (!near.contains(cx + x, cy - z, 40)) return false; // stay on the detailed terrain
  e.offset.set(x, groundY(cx + x, cy - z) - groundY(cx, cy), z);
  paint(e);
  syncRow(e);
  return true;
}
/** Send buildings back to where they really stand, as one undoable step. */
function moveBack(entries) {
  const moved = entries.filter(isMoved);
  if (!moved.length) return;
  const was = moved.map((e) => e.offset.clone());
  moved.forEach((e) => place(e, 0, 0));
  const what = moved.length === 1 ? label(moved[0].data) : plural(moved.length);
  remember(`Position reset: ${what}`, `Moved again: ${what}`, () => moved.forEach((e, i) => place(e, was[i].x, was[i].z)));
  updateCard();
  refresh();
}
/** Everything back as it really is: nothing hidden, nothing moved. */
function resetEverything() {
  const hidden = tall.filter(isHidden), moved = tall.filter(isMoved);
  if (!hidden.length && !moved.length) return;
  const was = moved.map((e) => e.offset.clone());
  apply(hidden, false, false);
  moved.forEach((e) => place(e, 0, 0));
  remember('Reset every building', 'Put your changes back', () => {
    apply(hidden, true, false);
    moved.forEach((e, i) => place(e, was[i].x, was[i].z));
  });
  updateCard();
  refresh();
}

function remember(done, undone, revert) {
  history.push({ undone, revert });
  showToast(done, true);
}
function undo() {
  const last = history.pop();
  if (!last) return;
  last.revert();
  updateCard();
  refresh();
  showToast(`Undone. ${last.undone}`, false);
}

let toastTimer = 0;
function showToast(text, undoable) {
  toast.querySelector('span').textContent = text;
  toast.querySelector('button').hidden = !undoable;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 7000);
}
function hideToast() { toast.hidden = true; clearTimeout(toastTimer); }
toast.querySelector('button').addEventListener('click', undo);

card.querySelector('[data-act="hide"]').addEventListener('click', () => selected && apply([selected], true));
card.querySelector('[data-act="taller"]').addEventListener('click', () => selected && apply([selected, ...visibleTaller(selected)], true));
card.querySelector('[data-act="center"]').addEventListener('click', () => selected && focusOn(selected));
card.querySelector('[data-act="back"]').addEventListener('click', () => selected && moveBack([selected]));
card.querySelector('.x').addEventListener('click', () => select(null));
showAll.addEventListener('click', () => apply(tall, false));
hideAll.addEventListener('click', () => apply(tall, true));
resetAll.addEventListener('click', resetEverything);

// ------------------------------------------------------------------ jump to a building
let flight = null;
/** Glide the camera so one building sits in the middle of the view, keeping the current viewing direction. */
function focusOn(entry) {
  const b = entry.data;
  const target = new THREE.Vector3(b.c[0], b.ground - BASE + b.h * 0.5, -b.c[1]).add(entry.offset);
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.28) { dir.y = 0.28; dir.normalize(); } // from a little above, so neighbours don't block it
  const dist = THREE.MathUtils.clamp(b.h * 7 + 550, 800, 1700); // far enough to see it among its neighbours
  flight = {
    t0: performance.now(), dur: 750,
    p0: camera.position.clone(), q0: controls.target.clone(),
    p1: target.clone().addScaledVector(dir, dist), q1: target,
  };
}
controls.addEventListener('start', () => { flight = null; });
function stepFlight(now) {
  if (!flight) return;
  const t = Math.min((now - flight.t0) / flight.dur, 1), k = t * t * (3 - 2 * t);
  camera.position.lerpVectors(flight.p0, flight.p1, k);
  controls.target.lerpVectors(flight.q0, flight.q1, k);
  if (t === 1) flight = null;
  invalidate();
}

// ------------------------------------------------------------------ list + search
function buildList() {
  list.replaceChildren();
  tall.forEach((entry, i) => {
    const b = entry.data;
    const li = document.createElement('li');
    const est = b.src === 'osm-levels' || b.src === 'guess';
    li.innerHTML = `<button class="go"><span class="rank">${i + 1}</span><span class="name"></span><span class="ht">${fmt(b.h)}${est ? '<span class="est">est.</span>' : ''}</span></button><button class="back" title="Reset to its original position" hidden>Reset</button><button class="act"></button>`;
    li.querySelector('.name').textContent = label(b);
    const go = li.querySelector('.go');
    go.title = `${label(b)}: ${details(b)}, ${SOURCE[b.src]}. Click to center the view on it.`;
    go.addEventListener('click', () => { focusOn(entry); select(entry); });
    li.querySelector('.act').addEventListener('click', () => apply([entry], !isHidden(entry)));
    li.querySelector('.back').addEventListener('click', () => moveBack([entry]));
    li.addEventListener('pointerenter', () => setHover(entry));
    li.addEventListener('pointerleave', () => setHover(null));
    entry.row = li;
    list.append(li);
    syncRow(entry);
  });
  filterList();
}
function matches() {
  const q = search.value.trim().toLowerCase();
  return tall.filter((e) => !q || label(e.data).toLowerCase().includes(q));
}
function filterList() {
  const shown = new Set(matches());
  for (const e of tall) e.row.hidden = !shown.has(e);
  empty.hidden = shown.size > 0;
  empty.textContent = `No building over ${fmt(settings.cutoff)} matches "${search.value.trim()}".`;
}
search.addEventListener('input', filterList);
search.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { const first = matches()[0]; if (first) { focusOn(first); select(first); } }
  if (ev.key === 'Escape' && search.value) { search.value = ''; filterList(); ev.stopPropagation(); }
});

// ------------------------------------------------------------------ context menu
function openMenu(entry, x, y) {
  const b = entry.data, hidden = isHidden(entry);
  const items = [];
  if (hidden) {
    items.push(['Restore this building', () => apply([entry], false)]);
    const n = tall.filter(isHidden).length;
    if (n > 1) items.push([`Restore all ${n} hidden`, () => apply(tall, false)]);
  } else {
    items.push(['Hide this building', () => apply([entry], true)]);
    const taller = visibleTaller(entry);
    if (taller.length) items.push([`Hide this and ${taller.length} taller`, () => apply([entry, ...taller], true)]);
    if (entry !== selected) items.push(['Move this building', () => { select(entry); showToast('Drag the orange building to move it.', false); }]);
  }
  if (isMoved(entry)) items.push(['Reset position', () => moveBack([entry])]);
  items.push(['Center view on this', () => { focusOn(entry); select(entry); }]);
  menu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = '<b></b><span></span>';
  head.querySelector('b').textContent = label(b);
  head.querySelector('span').textContent = hidden ? `${details(b)} · hidden` : details(b);
  menu.append(head);
  for (const [text, run] of items) {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'menuitem');
    btn.textContent = text;
    btn.addEventListener('click', () => { closeMenu(); run(); });
    menu.append(btn);
  }
  menu.hidden = false;
  tip.hidden = true;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelector('button').focus();
}
function closeMenu() { menu.hidden = true; }
addEventListener('pointerdown', (ev) => { if (!menu.hidden && !menu.contains(ev.target)) closeMenu(); }, true);
controls.addEventListener('start', closeMenu);

addEventListener('keydown', (ev) => {
  const typing = ev.target instanceof HTMLInputElement;
  if (ev.key === 'Escape') { if (!menu.hidden) closeMenu(); else select(null); }
  else if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); undo(); }
  else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && menu.hidden && !typing) { ev.preventDefault(); apply([selected], true); }
});

// ------------------------------------------------------------------ picking
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const ndc = new THREE.Vector2();

/**
 * What is under the pointer: a standing tower, or the ground footprint of one that is hidden or moved away.
 * Returns { entry, onMarker, point } or null.
 */
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [];
  for (const t of tall) {
    if (!isHidden(t)) targets.push(t.mesh);
    if (t.marker.visible) targets.push(t.marker);
  }
  const hit = ray.intersectObjects(targets, false)[0];
  if (!hit) return null;
  // a low building in front blocks the click, as it blocks the view
  const blocker = ray.intersectObject(low, false)[0];
  if (blocker && blocker.distance < hit.distance) return null;
  const entry = hit.object.userData.entry;
  return { entry, onMarker: hit.object === entry.marker, point: hit.point };
}

const dragPlane = new THREE.Plane(), dragPoint = new THREE.Vector3();
let down = null, dragging = false;
let move = null; // a building being dragged: { entry, start, grab }
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
// Capture phase, so this runs before the camera controls and can claim the drag for a building.
canvas.addEventListener('pointerdown', (ev) => {
  down = { x: ev.clientX, y: ev.clientY, ctrl: ev.ctrlKey };
  dragging = false;
  if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || !selected) return;
  const hit = pick(ev);
  if (!hit || hit.entry !== selected || hit.onMarker) return;
  // slide the building on a level plane through the point where it was grabbed
  dragPlane.set(new THREE.Vector3(0, 1, 0), -hit.point.y);
  move = { entry: selected, start: selected.offset.clone(), grab: hit.point.clone() };
  controls.enabled = false;
  canvas.setPointerCapture(ev.pointerId);
  canvas.classList.add('grabbing');
}, true);
canvas.addEventListener('pointermove', (ev) => {
  if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) dragging = true;
  if (move) {
    if (!dragging) return;
    tip.hidden = true;
    hideToast();
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (ray.ray.intersectPlane(dragPlane, dragPoint)) {
      place(move.entry, move.start.x + dragPoint.x - move.grab.x, move.start.z + dragPoint.z - move.grab.z);
      renderer.shadowMap.needsUpdate = true;
      invalidate();
    }
    return;
  }
  if ((down && dragging) || !menu.hidden) { setHover(null); tip.hidden = true; canvas.classList.remove('grab'); return; }
  const hit = pick(ev), entry = hit && hit.entry;
  setHover(entry);
  const grabbable = !!hit && entry === selected && !hit.onMarker;
  canvas.classList.toggle('grab', grabbable);
  tip.hidden = !entry;
  if (entry) {
    const b = entry.data;
    tip.innerHTML = '<b></b><i></i><span></span>';
    tip.querySelector('b').textContent = label(b);
    tip.querySelector('i').textContent = details(b);
    tip.querySelector('span').textContent = isHidden(entry) ? 'Hidden. Click to restore.'
      : hit.onMarker ? 'Where it really stands. Click to reset its position.'
        : grabbable ? 'Drag to move it'
          : `Click to ${settings.click === 'hide' ? 'hide' : 'select'} · right-click for options`;
    tip.style.left = `${Math.min(ev.clientX + 16, innerWidth - 280)}px`;
    tip.style.top = `${ev.clientY + 18}px`;
  }
});
canvas.addEventListener('pointerup', (ev) => {
  const start = down, wasDrag = dragging;
  down = null; dragging = false;
  if (move) {
    const { entry, start: from } = move;
    move = null;
    controls.enabled = true;
    canvas.classList.remove('grabbing');
    if (entry.offset.distanceTo(from) > 0.5) {
      remember(`Moved: ${label(entry.data)}`, `Position reset: ${label(entry.data)}`, () => place(entry, from.x, from.z));
      updateCard();
      refresh();
    }
    return;
  }
  if (wasDrag || !start) return;
  const hit = pick(ev), entry = hit && hit.entry;
  // right-click, two-finger click, or ctrl-click: the menu
  if (ev.button === 2 || (ev.button === 0 && start.ctrl)) {
    if (entry) openMenu(entry, ev.clientX, ev.clientY);
    return;
  }
  if (ev.button !== 0) return;
  tip.hidden = true;
  if (!entry) select(null);
  else if (isHidden(entry)) apply([entry], false);
  else if (hit.onMarker) moveBack([entry]);
  else if (settings.click === 'hide') apply([entry], true);
  else select(entry);
});
canvas.addEventListener('pointerleave', () => { setHover(null); tip.hidden = true; });

// ------------------------------------------------------------------ settings
const panel = document.getElementById('panel');
const form = document.getElementById('settings');
const toggle = document.getElementById('settings-toggle');
const lede = document.getElementById('lede');
const cutoffOut = document.getElementById('cutoff-out');

/** Rebuild the towers and the list after the cutoff changes. Hidden towers that are still removable stay hidden. */
function rebuild() {
  hovered = selected = null;
  card.hidden = true;
  canvas.classList.remove('grab');
  history.length = 0;
  hideToast();
  buildCity();
  buildList();
  tall.forEach(paint);
  refresh();
}

function describeCutoff(m) {
  const n = model.buildings.filter((b) => b.h >= m).length;
  cutoffOut.textContent = `${fmt(m)} · ${plural(n)}`;
}

/** Switch sky, haze, light and street glow between day and night. Buildings follow the shared `night` uniform. */
function applyNight() {
  const look = settings.night ? NIGHT : DAY;
  night.value = settings.night ? 1 : 0;
  HAZE.set(look.haze);
  scene.fog.color.copy(HAZE); // the fog keeps its own copy of the haze color
  ZENITH.set(look.zenith);
  hemi.color.set(look.skyLight);
  hemi.groundColor.set(look.groundLight);
  hemi.intensity = look.hemi;
  sun.color.set(look.sun);
  sun.intensity = look.sunPower;
  terrain.forEach((t, i) => {
    t.mesh.material.emissive.set(STREET_GLOW);
    // without the photo there is no street pattern to light, so keep the plain ground dim
    t.mesh.material.emissiveIntensity = look.street[i] * (settings.imagery ? 1 : 0.3);
  });
  invalidate();
}

/** Push the settings into the scene and the panel. `changed` is the key that just changed, or null for all. */
function applySettings(changed = null) {
  if (changed === null || changed === 'cutoff') rebuild();
  if (changed === 'units') { buildList(); if (selected) select(selected); }
  if (changed === null || changed === 'imagery') {
    for (const t of terrain) {
      t.mesh.material.map = t.mesh.material.emissiveMap = settings.imagery ? t.map : null;
      t.mesh.material.color.set(settings.imagery ? 0xffffff : 0xbdb9ad);
      t.mesh.material.needsUpdate = true;
    }
  }
  if (changed === null || changed === 'night' || changed === 'imagery') applyNight();
  tall.forEach(paint);
  lede.replaceChildren();
  if (settings.highlight) lede.append(Object.assign(document.createElement('span'), { className: 'swatch' }));
  lede.append(`${settings.highlight ? 'Blue buildings' : `Buildings over ${fmt(settings.cutoff)}`} can be hidden or moved. `
    + (settings.click === 'hide' ? 'Click one to hide it; right-click for more, including moving it.'
      : 'Click one to select it, then drag it to move it. Right-click for options.'));
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = settings[el.name];
    else if (el.type === 'radio') el.checked = settings[el.name] === el.value;
    else el.value = settings[el.name];
  }
  describeCutoff(settings.cutoff);
  refresh();
}

function setSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  saveSettings();
  applySettings(key);
}
form.addEventListener('input', (ev) => { if (ev.target.name === 'cutoff') describeCutoff(Number(ev.target.value)); });
form.addEventListener('change', (ev) => {
  const el = ev.target;
  if (!el.name) return;
  setSetting(el.name, el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value);
});
document.getElementById('settings-reset').addEventListener('click', () => {
  Object.assign(settings, DEFAULTS);
  saveSettings();
  applySettings();
});
toggle.addEventListener('click', () => {
  const open = panel.classList.toggle('settings-open');
  toggle.textContent = open ? 'Done' : 'Settings';
  toggle.setAttribute('aria-expanded', String(open));
});

// ------------------------------------------------------------------ go
const counts = model.buildings.reduce((a, b) => ((a[b.src] = (a[b.src] || 0) + 1), a), {});
document.getElementById('about').textContent =
  `${model.buildings.length.toLocaleString()} footprints from OpenStreetMap. Heights: ${(counts.lidar || 0).toLocaleString()} measured from USGS 3DEP LiDAR (${city.lidar.year}), `
  + `${counts['osm-height'] || 0} tagged, ${((counts['osm-levels'] || 0) + (counts.guess || 0)).toLocaleString()} estimated. Terrain: USGS 3DEP, imagery USGS NAIP. True scale, 50 mm lens.`;

// city switcher: each city is its own page load, so its terrain and buildings start clean
const cityBar = document.getElementById('cities');
for (const [id, c] of Object.entries(cities)) {
  const a = Object.assign(document.createElement('a'), { textContent: c.name, href: `?city=${id}` });
  if (id === cityId) { a.className = 'active'; a.setAttribute('aria-current', 'page'); }
  cityBar.append(a);
}

resize();
setView(city.views[0].id);
applySettings();
document.getElementById('loading').classList.add('done');

renderer.setAnimationLoop((now) => {
  stepFlight(now);
  controls.update();
  if (!dirty) return;
  dirty = false;
  renderer.render(scene, camera);
});

// hooks for automated checks
window.__skyline = {
  tall, renderer, scene, camera, controls, sun, invalidate, settings, setSetting, focusOn,
  flying: () => !!flight,
  setView,
  select: (id) => select(tall.find((e) => e.data.id === id) || null),
  selectedId: () => selected && selected.data.id,
  /** Screen position of a building: near its top while standing, its ground marker once hidden. */
  screen(id) {
    const t = tall.find((e) => e.data.id === id);
    const box = new THREE.Box3().setFromObject(isHidden(t) ? t.marker : t.mesh);
    const p = box.getCenter(new THREE.Vector3());
    if (!isHidden(t)) p.y = lerp(box.min.y, box.max.y, 0.8);
    p.project(camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, visible: t.mesh.visible };
  },
  place, movedIds: () => tall.filter(isMoved).map((t) => t.data.id),
  hiddenIds: () => tall.filter((t) => !t.mesh.visible).map((t) => t.data.id),
};

// extras, the fountain show and animated LED surfaces (skyline-integration v5, src/attractions.js)
initAttractions({ cityId, scene, camera, renderer, settings, invalidate, groundY, tall });

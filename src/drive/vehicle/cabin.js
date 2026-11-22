// The cabin (plan 02, D4.2 and D4.5): a drive part that draws the car's interior after the world, in its own
// scene and camera (near 0.05 m, far 6 m) with the depth buffer cleared first, so it never fights the world's
// depth whatever the world's near plane is. The model is public/models/drive/cabin.glb (or cabin-low.glb on
// small or slow devices), placed by cabin.json: cabin coordinates are +X right, +Y up, -Z forward, origin on
// the road under the driver's eye. The rig (rig.js) works out where the body and the head are each frame;
// this part only follows it: the cabin camera is the head in cabin coordinates, so the cabin is drawn near
// the origin, in full float precision, however far the car is from the city's base.
//
// Light. The cabin copies the scene's own sky light and sun (src/sky/legacySky.js, as the look sets them),
// turned into cabin coordinates, so it is lit as the world is: by day the sun's direction and the sky's tone,
// at night dim with the displays glowing. A small light at the instrument cluster stands for the displays'
// spill onto the wheel and dash, by night only. Inside is matte and dark; the hood takes a neutral paint.
//
// For the parts that come next (mirrors, windshield), the part exposes cabinScene, cabinCamera, mirrors
// { left, right, center } (each the mesh and its plane, size and corners from cabin.json, in cabin
// coordinates) and windshield { corners }.
//
// The glass (D4.3, D4.4) is attached here rather than as parts of its own, because both draw within the cabin's
// pass: the mirror passes (mirrors.js) run in afterRender just before the cabin is drawn, and the windshield layer
// (windshield.js) is a mesh of the cabin scene. Their sizes and rates come from glassPresets.js by the cabin's
// model. The part exposes them as `glass` { options, mirrors, windshield }.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { localUp } from '../../world/frame.js';
import { instrumentText, screenText, createInstrumentCanvas, createScreenCanvas } from './displays.js';
import { createTimings } from '../timing.js';
import { createMirrors } from './mirrors.js';
import { createWindshield } from './windshield.js';
import { glassPresetFor } from './glassPresets.js';

export const CABIN_NEAR = 0.05;
export const CABIN_FAR = 6;
const MODELS = '/models/drive/';
/** The interior fill: this share of the sky light's strength reaches inside from all round (assumed). */
const FILL = 1.3;
/** The displays redraw at most this often (real time), and at once when the pose jumps. */
const REDRAW_MS = 100;

/**
 * Which model a device gets. Low on a software renderer, on a device that reports 4 GB of memory or less or 4
 * logical cores or fewer, and on a phone (a coarse pointer and a screen under 768 px on its short side).
 * @param {{ software?: boolean, deviceMemory?: number, cores?: number, coarse?: boolean, minScreen?: number }} d
 * @returns {'high'|'low'}
 */
export function chooseCabinModel({ software = false, deviceMemory, cores, coarse = false, minScreen } = {}) {
  if (software) return 'low';
  if (Number.isFinite(deviceMemory) && deviceMemory <= 4) return 'low';
  if (Number.isFinite(cores) && cores <= 4) return 'low';
  if (coarse && Number.isFinite(minScreen) && minScreen < 768) return 'low';
  return 'high';
}

/** What chooseCabinModel needs, read from the browser and the renderer. */
export function probeDevice(renderer) {
  let software = false;
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    software = /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch { /* unknown: not software */ }
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const minScreen = typeof screen === 'undefined' ? undefined : Math.min(screen.width, screen.height);
  return { software, deviceMemory: nav.deviceMemory, cores: nav.hardwareConcurrency, coarse, minScreen };
}

// Linear base colours. Matte and dark inside, as interiors are (a dashboard is about 4 % reflective); the
// darker the part sits under the roof, the darker it is drawn, which stands in for the roof's shade.
const PAINT = {
  CabinDash: { color: [0.030, 0.031, 0.034], roughness: 0.92 },
  CabinTrim: { color: [0.050, 0.051, 0.055], roughness: 0.85 },
  CabinPillar: { color: [0.090, 0.090, 0.087], roughness: 0.95 },
  Hood: { color: [0.32, 0.32, 0.31], roughness: 0.38 }, // a neutral mid-grey paint
  MirrorHousing: { color: [0.035, 0.036, 0.04], roughness: 0.6 },
};

/** The cabin part. ctx is the part context (see parts.js). */
export async function createCabin(ctx) {
  const { app, session, env } = ctx;
  const rig = session.rig;
  const { renderer, scene, settings, city } = app;
  const metaRes = await fetch(`${MODELS}cabin.json`);
  if (!metaRes.ok) throw new Error(`cabin.json: HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const model = chooseCabinModel(probeDevice(renderer));
  const gltf = await new GLTFLoader().loadAsync(`${MODELS}${meta.files[model]}`);
  rig.setCabin(meta);

  const cabinScene = new THREE.Scene();
  cabinScene.name = 'cabin';
  const root = gltf.scene;
  cabinScene.add(root);
  root.updateMatrixWorld(true);

  // ---------------------------------------------------------------- materials
  const materials = {};
  const paint = (name) => {
    if (!materials[name]) {
      const p = PAINT[name] || PAINT.CabinTrim;
      materials[name] = new THREE.MeshStandardMaterial({ name, color: new THREE.Color(...p.color), roughness: p.roughness, metalness: 0, side: THREE.DoubleSide });
    }
    return materials[name];
  };
  const instruments = createInstrumentCanvas();
  const screenCanvas = createScreenCanvas();
  const textureOf = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // glTF texture coordinates: v runs down the image
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  };
  const instrumentsTex = textureOf(instruments.canvas), screenTex = textureOf(screenCanvas.canvas);
  const displayMat = (map) => new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
  const instrumentsMat = displayMat(instrumentsTex), screenMat = displayMat(screenTex);
  /** The mirrors' stand-in until the mirror pass: a plain dark sky. */
  const mirrorMat = () => new THREE.MeshBasicMaterial({ color: 0x1c2330, side: THREE.DoubleSide });
  const mirrorMats = [];

  const byNode = {};
  root.traverse((o) => {
    if (o.name) byNode[o.name] = byNode[o.name] || o;
    if (!o.isMesh) return;
    o.frustumCulled = false; // a handful of meshes, all within a few metres: culling saves nothing
    const owner = o.name in NODE_ROLES ? o.name : o.parent?.name;
    const role = NODE_ROLES[owner];
    const old = o.material;
    if (role === 'instruments') o.material = instrumentsMat;
    else if (role === 'screen') o.material = screenMat;
    else if (role === 'mirror') { o.material = mirrorMat(); mirrorMats.push(o.material); }
    else o.material = paint(old?.name);
    old?.dispose?.();
  });

  const v3 = (a) => new THREE.Vector3(...a);
  const corners = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v3(v)]));
  const face = (m) => {
    const normal = v3(m.normal).normalize();
    const center = v3(m.center);
    return {
      mesh: meshOf(byNode[m.node]), node: m.node, center, normal, right: v3(m.right), up: v3(m.up),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center),
      width: m.width, height: m.height, corners: corners(m.corners), kind: m.kind || 'flat',
      ...(m.radiusM ? { radiusM: m.radiusM } : {}), ...(m.minFovDeg ? { minFovDeg: m.minFovDeg } : {}),
    };
  };
  const mirrors = { left: face(meta.mirrors.left), right: face(meta.mirrors.right), center: face(meta.mirrors.center) };
  const windshield = { corners: corners(meta.windshield.corners) };

  // the steering wheel turns about its own axis; its node sits at the pivot with no rotation
  const wheel = byNode[meta.wheel.node];
  const wheelAxis = v3(meta.wheel.axis).normalize();
  const wheelRest = wheel ? wheel.quaternion.clone() : null;
  const _wq = new THREE.Quaternion();

  // ---------------------------------------------------------------- light
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.target.position.set(0, 1, 0);
  const glow = new THREE.PointLight(0xbcd4ff, 0, 1.2, 2); // the displays' spill, by night
  glow.position.set(0.15, 0.95, -0.7);
  // Light that reaches the inside through the glass from every side, bounced off the road and the seats: the
  // sky light's own tone, a share of its strength, from no direction. Without it whatever faces away from
  // the sky (the header, the pillars' inner faces) would be black by day.
  const fill = new THREE.AmbientLight(0xffffff, 0);
  cabinScene.add(hemi, sun, sun.target, glow, fill);
  // the scene's own lights, as the sky module made them
  let worldHemi = null, worldSun = null;
  for (const o of scene.children) {
    if (o.isHemisphereLight && !worldHemi) worldHemi = o;
    if (o.isDirectionalLight && o.castShadow && !worldSun) worldSun = o;
  }

  const cabinCamera = new THREE.PerspectiveCamera(50, 16 / 9, CABIN_NEAR, CABIN_FAR);
  cabinCamera.matrixAutoUpdate = false;

  // ---------------------------------------------------------------- the glass: mirrors and windshield
  const glassOptions = glassPresetFor(model);
  let mirrorPass = null, windshieldLayer = null;
  try {
    const strides = glassOptions.mirrors.groundStride || {};
    const ground = [...(ctx.ground || []).map(([mesh, grid]) => [mesh, strides[grid] || 1]), ...(ctx.wideMesh ? [[ctx.wideMesh, strides.wide || 1]] : [])];
    mirrorPass = createMirrors({ renderer, scene, session, cabinScene, faces: mirrors, options: glassOptions.mirrors, lights: [hemi, sun, glow, fill], ground });
    mirrorMats.length = 0; // the stand-ins are replaced by the mirror faces' own material
  } catch (e) { console.warn(`cabin mirrors left out: ${e && e.message ? e.message : e}`); }
  try {
    if (glassOptions.windshield.enabled) windshieldLayer = createWindshield({ cabinScene, corners: windshield.corners, options: glassOptions.windshield, env });
  } catch (e) { console.warn(`cabin windshield left out: ${e && e.message ? e.message : e}`); }
  const _sunDir = new THREE.Vector3();

  // ---------------------------------------------------------------- displays
  let look = { night: false, dusk: 0 };
  let route = null; // the journey whose line the screen shows
  const drawn = { real: -Infinity, simMs: null, s: null, units: null, text: null, screen: null, dusk: null };
  const readout = { speed: null, unit: null, clock: null, temp: null, next: null, dist: null, drawnAt: null, s: null, simMs: null };

  function temperature() {
    // the stand-in environment's weather has a placeholder temperature; only a real one is shown
    const w = env?.weather;
    if (!w || w.hasTemperature !== true) return null;
    const t = w.state?.().tempC;
    return Number.isFinite(t) ? t : null;
  }

  function updateDisplays(frame, force) {
    const now = performance.now();
    const journey = session.journey;
    if (!journey || !frame.pose) return;
    if (route !== journey) {
      route = journey;
      let road = null;
      try { road = session.net.roadOf(journey.route); } catch { /* no line, the text still shows */ }
      screenCanvas.setRoute(road, { s0: journey.s0, s1: journey.s1 });
      force = true;
    }
    const units = settings.units;
    // a jump: paused (a seek or a scrub), or simulation time moved further than the clock's own step
    const expected = drawn.simMs === null ? 0 : (now - drawn.real) * (frame.rate || 1);
    const jumped = drawn.simMs === null || (!frame.playing && frame.simMs !== drawn.simMs)
      || Math.abs(frame.simMs - drawn.simMs - expected) > 2000 || units !== drawn.units || look.dusk !== drawn.dusk;
    if (!force && !jumped && now - drawn.real < REDRAW_MS) return;
    const held = session.locked || session.arrived;
    const it = instrumentText({ speed: held ? 0 : frame.pose.speed, simMs: frame.simMs, tz: city.tz || 'UTC', units, tempC: temperature() });
    const st = screenText({ s: frame.pose.s, s1: journey.s1, markers: journey.markers, to: journey.route.to, units });
    const key = `${it.speed}|${it.unit}|${it.clock}|${it.temp}|${look.dusk}`;
    if (key !== drawn.text) { instruments.draw(it, look.dusk); instrumentsTex.needsUpdate = true; drawn.text = key; }
    const sKey = `${st.title}|${st.dist}|${Math.round(frame.pose.s / 25)}|${look.dusk}`;
    if (sKey !== drawn.screen) { screenCanvas.draw(st, frame.pose.s, look.dusk); screenTex.needsUpdate = true; drawn.screen = sKey; }
    Object.assign(drawn, { real: now, simMs: frame.simMs, s: frame.pose.s, units, dusk: look.dusk });
    Object.assign(readout, { speed: it.speed, unit: it.unit, clock: it.clock, temp: it.temp, next: st.title, dist: st.dist, drawnAt: now, s: frame.pose.s, simMs: frame.simMs });
  }

  // ---------------------------------------------------------------- light, each frame
  const _inv = new THREE.Matrix4(), _dir = new THREE.Vector3(), _up = new THREE.Vector3(), _c = new THREE.Color();
  function updateLight(body, eyeWorld) {
    _inv.copy(body).invert();
    const toCabin = (v) => v.transformDirection(_inv);
    if (worldHemi) {
      hemi.color.copy(worldHemi.color);
      hemi.groundColor.copy(worldHemi.groundColor);
      hemi.intensity = worldHemi.intensity;
      fill.color.copy(worldHemi.color).lerp(worldHemi.groundColor, 0.5);
      fill.intensity = FILL * worldHemi.intensity;
    }
    hemi.position.copy(toCabin(localUp(eyeWorld.x, eyeWorld.z, _up)));
    if (worldSun) {
      sun.color.copy(worldSun.color);
      sun.intensity = worldSun.intensity;
      _dir.copy(worldSun.position).sub(worldSun.target.position).normalize();
      sun.position.copy(toCabin(_dir)).multiplyScalar(10).add(sun.target.position);
    }
    const d = look.dusk;
    // displays: full brightness by day, dimmed for the dark (a screen in a dark car is turned well down)
    const bright = 1 - 0.68 * d;
    instrumentsMat.color.setScalar(bright);
    screenMat.color.setScalar(bright * 0.95);
    glow.intensity = 0.02 * d;
    // the mirrors' stand-in takes the haze's tone, darkened
    if (scene.fog) {
      _c.copy(scene.fog.color).multiplyScalar(0.3);
      for (const m of mirrorMats) m.color.copy(_c);
    }
  }

  let renders = 0;
  const timing = createTimings(); // the part's own JavaScript per drawn frame, the cabin's draw call excluded
  const part = {
    name: 'cabin',
    model,
    meta,
    cabinScene,
    cabinCamera,
    mirrors,
    windshield,
    wheel,
    /** The values the displays last drew (for tests and the next builders). */
    get readout() { return { ...readout }; },
    setLook(l) { look = { night: !!l.night, dusk: Number.isFinite(l.dusk) ? l.dusk : l.night ? 1 : 0 }; mirrorPass?.setLook(look); },
    /** The mirrors and the windshield layer (mirrors.js, windshield.js) and the options they were made with. */
    glass: { options: glassOptions, mirrors: mirrorPass, windshield: windshieldLayer },
    update(frame) { if (rig.view === 'cabin') updateDisplays(frame, false); },
    afterRender(frame) {
      const L = rig.last;
      if (!L || L.view !== 'cabin' || rig.view !== 'cabin') return;
      const t0 = performance.now();
      updateDisplays(frame, false);
      cabinCamera.matrixWorld.copy(L.head);
      cabinCamera.matrixWorldInverse.copy(L.head).invert();
      cabinCamera.fov = L.fov;
      cabinCamera.aspect = L.aspect;
      cabinCamera.updateProjectionMatrix();
      if (wheel) wheel.quaternion.copy(wheelRest).multiply(_wq.setFromAxisAngle(wheelAxis, L.wheel));
      root.updateMatrixWorld(true);
      updateLight(L.body, frame.camera.position);
      const info = renderer.info.render;
      const calls = info.calls, triangles = info.triangles; // the world's draw, before the mirror passes
      if (windshieldLayer) {
        _sunDir.copy(sun.position).sub(sun.target.position).normalize();
        const traffic = session.part?.('traffic');
        windshieldLayer.update({
          frame, L, sunDir: _sunDir, sunColor: worldSun?.color, sunIntensity: worldSun?.intensity ?? 0, hemi: worldHemi,
          lampPoints: traffic?.lampPoints ? traffic.lampPoints() : null, eyeWorld: frame.camera.position,
        });
      }
      let mirrorJs = 0;
      if (mirrorPass) {
        mirrorPass.shade(worldHemi, worldSun);
        mirrorJs = mirrorPass.render(frame, L);
      }
      const tm = performance.now();
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      const t2 = performance.now();
      renderer.render(cabinScene, cabinCamera);
      const t3 = performance.now();
      renderer.autoClear = auto;
      part.lastCalls = info.calls;
      info.calls += calls; // the world's draw and the cabin's, both in the stats
      info.triangles += triangles;
      renders++;
      // the part's own JavaScript: the mirror passes' own share counts, their renderer.render work does not (as the
      // cabin's own draw call does not)
      timing.add(tm - t0 - (mirrorPass ? mirrorPass.lastPassMs : 0) + mirrorJs + (t2 - tm) + (performance.now() - t3));
    },
    stats: () => ({
      model, renders, calls: part.lastCalls ?? 0, js: timing.summary(),
      mirrors: mirrorPass ? mirrorPass.stats() : null, windshield: windshieldLayer ? windshieldLayer.stats() : null,
    }),
    dispose() {
      root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      mirrorPass?.dispose();
      windshieldLayer?.dispose();
      for (const m of [...Object.values(materials), instrumentsMat, screenMat, ...mirrorMats]) m.dispose();
      instrumentsTex.dispose(); screenTex.dispose();
    },
  };
  return part;
}

const NODE_ROLES = {
  Instruments: 'instruments', CenterScreen: 'screen', MirrorLeft: 'mirror', MirrorRight: 'mirror', MirrorCenter: 'mirror',
};

/** The mesh of a node (a node with several primitives is a group of meshes: its first). */
function meshOf(node) {
  if (!node) return null;
  if (node.isMesh) return node;
  let m = null;
  node.traverse((o) => { if (!m && o.isMesh) m = o; });
  return m;
}

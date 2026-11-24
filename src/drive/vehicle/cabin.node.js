// The cabin on plan 01's renderer (plan 02, D4.2, D4.5; third stretch, decisions 2, 3, 6, 7 and 8): cabin.js's part with
// three/webgpu and three/tsl. The model, the paint, the faces, the displays' logic and the glass's model are shared with
// the classic renderer (cabinCommon.js, veil.js, mirrorGeometry.js, glassRainFeed.js, drops.js, wipers.js, displays.js).
//
// Where it differs from cabin.js, on purpose:
//   - One pass (decisions 3 and 7). The car is a group of the drive's scene group, placed each frame at the body's
//     matrix (rig.last.body: cabin coordinates to scene coordinates; the renderer composes model-view matrices in double
//     precision, so the cabin is as steady as in its own pass), and drawn by the pipeline's scene pass with the world,
//     on the app's camera with the session's 0.1 m near plane (session.js NEAR_M). Every mesh of the model is drawn
//     first (renderOrder CABIN_ORDER), so the world behind the dashboard, the pillars and the roof fails the depth test
//     instead of being shaded: cabin.js's depth silhouette is not needed. tests/manual/cabin-depth.mjs holds it: with
//     reversed depth (both backends on the reference Apple M4) the cabin drawn at near 0.1 m and at 0.01 m differ by at
//     most 3 pixels of 921,600 at ten head poses out to the rig's limits, so nothing of it is clipped and nothing
//     fights. On a tiled GPU the order saves nothing measurable (its hidden-surface removal rejects the world behind
//     anyway: cabin-cost.mjs, case `last`). Where the renderer has no reversed depth (WebGL2 without EXT_clip_control:
//     a logarithmic buffer, chosen when the renderer is created) the same one-pass draw is used; that case could not be
//     produced on the reference machine, and stats().depth reports which buffer is in use. Decision 3's `afterWorld`
//     fallback is not built.
//   - Light. The cabin's materials have their own light list (material.lightsNode): the scene's own sky light, sun and
//     city light (the very lights the world is drawn with, pre-exposed in the shipped look), plus the interior fill
//     and the displays' spill. cabin.js copied the scene's lights into its own scene; here they are the same objects.
//     No fog inside (the scene's fog node would otherwise reach the dashboard).
//   - The displays emit in cd/m^2 (decision 6): DISPLAY_CD by day, dimmed with the dusk toward night, times the
//     pre-exposure in the shipped look (not the lights-out slider: they are the car's, not the city's). At the classic
//     display they keep cabin.js's display values (1 - 0.68 dusk), since the classic renderer's displays were not
//     authored in physical units and the parity tool compares against them.
//   - The mirrors are a pipeline stage at `beforeScene` (mirrors.node.js); the windshield's veil a mesh of the car and
//     a stage at `afterBloom` (windshield.node.js); the rain on the glass a layer drawn after the scene pass from the
//     scene's colour, composited at `beforeBloom` (glassRain.node.js), which replaces the frame copy.
//   - Exposure: the cabin gives plan 01's exposure a metering mask (env.exposure.setMeteringMask), the screen's share
//     seen through the glass, so a meter reads the road and the sky, not the dashboard.
//   - Quality (decision 8): app.quality's level picks the model (cabin-low.glb on Low), the mirrors' sizes and rates
//     and the rain's detail (glassPresets.js); a level change rebuilds the cabin with the new preset.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { lights, texture, uniform, vec4 } from 'three/tsl';
import { localUp } from '../../world/frame.js';
import { createInstrumentCanvas, createScreenCanvas } from './displays.js';
import { createTimings } from '../timing.js';
import { createMirrors } from './mirrors.node.js';
import { createWindshield } from './windshield.node.js';
import { createGlassRain } from './glassRain.node.js';
import { glassPresetForLevel } from './glassPresets.js';
import { MODELS, FILL, PAINT, cabinModelForLevel, roleOf, loadCabinMeta, cabinGlass, createDisplayDriver } from './cabinCommon.js';
import { photometryContext, lightScale } from '../lights/photometry.node.js';
import { sunOnGlass, glassFrame } from './veil.js';

/** Draw order of the cabin's meshes: before everything of the world (three sorts opaque objects by it first). */
export const CABIN_ORDER = -1000;
/** A display's luminance (cd/m^2) by day and fully dimmed at night (assumed: a car display at full brightness, and turned
 * down for night driving as automatic dimming does). The dimming follows the look's dusk geometrically. */
export const DISPLAY_CD = Object.freeze({ day: 1000, night: 6, screen: 0.95 });

/** A display's luminance (cd/m^2) at a dusk (0 by day .. 1 at night). Pure. */
export const displayLuminance = (dusk) => DISPLAY_CD.day * (DISPLAY_CD.night / DISPLAY_CD.day) ** Math.min(1, Math.max(0, dusk));
/** The classic renderer's display value at a dusk (cabin.js: full by day, 0.32 at night). Pure. */
export const classicDisplay = (dusk) => 1 - 0.68 * Math.min(1, Math.max(0, dusk));

/**
 * How much of the sun reaches the cabin's inside, 0..1, for the direction toward the sun in cabin coordinates (+X right,
 * +Y up, -Z forward): through the windshield (veil.js sunOnGlass on its outward normal) or a front side window (low,
 * from the side, not from behind), and nothing from behind or overhead, where the roof, the rear of the body and the
 * seats shade the dashboard. A model (assumed), for the shipped look: the cabin has no shadows of its own, and the
 * physical sun stays strong down to the horizon, where it lit the driver's side of the dashboard through a body the
 * model does not have. Pure.
 * @param {{ x: number, y: number, z: number }} d unit, toward the sun  @param {{ x: number, y: number, z: number }} glassOut
 */
export function sunIntoCabin(d, glassOut) {
  const s = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const front = sunOnGlass(d.x * glassOut.x + d.y * glassOut.y + d.z * glassOut.z);
  const side = s(0.2, 0.5, Math.abs(d.x)) * (1 - s(0.1, 0.5, d.z)) * (1 - s(0.6, 0.85, d.y));
  return Math.max(front, side);
}

/** The cabin part on plan 01's renderer. ctx is the part context (see parts.js). */
export async function createCabin(ctx) {
  const quality = ctx.app?.plan01?.quality;
  let level = quality?.level ?? 'high';
  let cur = await buildCabin(ctx, level);
  const listeners = [];
  // a level change rebuilds the cabin with the new preset (model, mirrors, rain), then swaps it in
  let pending = null;
  const offQuality = quality?.on ? quality.on('change', (q) => {
    const next = q?.level ?? quality.level;
    if (next === level || pending) return;
    level = next;
    pending = buildCabin(ctx, next).then((built) => {
      const old = cur;
      built.setLook(old.look);
      cur = built;
      old.dispose();
      for (const fn of listeners) fn(cur);
      ctx.app.invalidate?.();
    }).catch((e) => console.warn(`cabin rebuild for ${next} failed: ${e && e.message ? e.message : e}`)).finally(() => { pending = null; });
  }) : null;

  // the part's surface stays the same object across rebuilds: everything goes to the current build
  const part = {
    name: 'cabin',
    get model() { return cur.model; },
    get level() { return cur.level; },
    get meta() { return cur.meta; },
    get car() { return cur.car; },
    get cabinScene() { return cur.car; },
    get cabinCamera() { return null; },
    get mirrors() { return cur.mirrors; },
    get windshield() { return cur.windshield; },
    get wheel() { return cur.wheel; },
    get readout() { return cur.readout; },
    get glass() { return cur.glass; },
    /** The drive's weather port (env.weather), for test scripts that set the rain. */
    get weather() { return ctx.env?.weather ?? null; },
    setLook(l) { cur.setLook(l); },
    setDepthMask() {},
    /** The cabin's draw order (tests: CABIN_ORDER draws it first; a large value last, to measure what drawing it first saves). */
    setDrawOrder(order) { cur.setDrawOrder(order); },
    get depthMask() { return false; },
    update(frame) { cur.update(frame); },
    beforeRender(frame) { cur.beforeRender(frame); },
    afterRender() { cur.afterRender(); },
    stats: () => cur.stats(),
    /** fn(build) after a quality change has rebuilt the cabin (tests). */
    onRebuild(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    whenRebuilt: () => pending || Promise.resolve(),
    dispose() { offQuality?.(); cur.dispose(); },
  };
  return part;
}

/** One build of the cabin for a quality level. */
async function buildCabin(ctx, level) {
  const { app, session, env } = ctx;
  const rig = session.rig;
  const { renderer, scene, settings, city } = app;
  const plan01 = app.plan01 || {};
  const pipeline = plan01.pipeline;
  const meta = await loadCabinMeta();
  const model = cabinModelForLevel(level);
  const gltf = await new GLTFLoader().loadAsync(`${MODELS}${meta.files[model]}`);
  rig.setCabin(meta);
  const phot = photometryContext({ nodes: env?.nodes });
  const classic = phot.display === 'classic';

  // the car: cabin coordinates under a group placed at the body each frame
  const car = new THREE.Group();
  car.name = 'cabin';
  car.matrixAutoUpdate = false;
  car.visible = false;
  const root = gltf.scene;
  car.add(root);
  (ctx.group || scene).add(car);

  // ---------------------------------------------------------------- light
  let worldHemi = null, worldSun = null, cityLight = null;
  for (const o of scene.children) {
    if (o.isHemisphereLight && !worldHemi) worldHemi = o;
    if (o.isDirectionalLight && o.castShadow && !worldSun) worldSun = o;
    if (o.isAmbientLight && o.name === 'city light' && !cityLight) cityLight = o;
  }
  const glow = new THREE.PointLight(0xbcd4ff, 0, 1.2, 2); // the displays' spill, by night
  const GLOW_AT = new THREE.Vector3(0.15, 0.95, -0.7);
  // Light that reaches the inside through the glass from every side, bounced off the road and the seats: the sky light's
  // own tone, a share of its strength, from no direction (cabin.js FILL)
  const fill = new THREE.AmbientLight(0xffffff, 0);
  // the sun: the scene's own at the classic display (as cabin.js copied it); in the shipped look a copy admitted only
  // through the glass (sunIntoCabin)
  const cabinSun = !classic && worldSun ? new THREE.DirectionalLight(0xffffff, 0) : null;
  const lightsNode = lights([worldHemi, cabinSun || worldSun, cityLight, fill, glow].filter(Boolean));

  // ---------------------------------------------------------------- materials
  const materials = {};
  const paint = (name) => {
    if (!materials[name]) {
      const p = PAINT[name] || PAINT.CabinTrim;
      const m = new MeshStandardNodeMaterial({ name, color: new THREE.Color(...p.color), roughness: p.roughness, metalness: 0, side: THREE.DoubleSide, fog: false });
      m.lightsNode = lightsNode;
      materials[name] = m;
    }
    return materials[name];
  };
  const instruments = createInstrumentCanvas();
  const screenCanvas = createScreenCanvas();
  const textureOf = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // glTF texture coordinates: v runs down the image
    t.anisotropy = Math.min(8, renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : 1);
    return t;
  };
  const instrumentsTex = textureOf(instruments.canvas), screenTex = textureOf(screenCanvas.canvas);
  // the displays: cd/m^2 x the light scale in the shipped look; cabin.js's display value at the classic display
  const displayScale = { instruments: uniform(1), screen: uniform(1) };
  const displayMat = (map, k) => {
    const m = new MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
    const scale = classic ? k : k.mul(lightScale(phot));
    m.colorNode = vec4(texture(map).rgb.mul(scale), 1);
    return m;
  };
  const instrumentsMat = displayMat(instrumentsTex, displayScale.instruments), screenMat = displayMat(screenTex, displayScale.screen);
  /** The mirrors' stand-in until the mirror pass: a plain dark sky. */
  const mirrorStandIns = [];

  const byNode = {};
  const meshes = [];
  root.traverse((o) => {
    if (o.name) byNode[o.name] = byNode[o.name] || o;
    if (!o.isMesh) return;
    o.frustumCulled = false; // a handful of meshes, all within a few metres: culling saves nothing
    o.renderOrder = CABIN_ORDER;
    const role = roleOf(o);
    const old = o.material;
    if (role === 'instruments') o.material = instrumentsMat;
    else if (role === 'screen') o.material = screenMat;
    else if (role === 'mirror') { o.material = new MeshBasicNodeMaterial({ color: 0x1c2330, side: THREE.DoubleSide, fog: false }); mirrorStandIns.push(o.material); }
    else o.material = paint(old?.name);
    old?.dispose?.();
    meshes.push(o);
  });

  const v3 = (a) => new THREE.Vector3(...a);
  const { mirrors, windshield } = cabinGlass(meta, byNode);
  const wheel = byNode[meta.wheel.node];
  const wheelAxis = v3(meta.wheel.axis).normalize();
  const wheelRest = wheel ? wheel.quaternion.clone() : null;
  const _wq = new THREE.Quaternion();

  // ---------------------------------------------------------------- the cabin's silhouette, for the glass and the meter
  // its opaque meshes again, sharing their geometry, in a scene of their own: the occluders of the rain on the glass
  // (depth only) and the metering mask (black on white)
  const silhouette = new THREE.Scene();
  silhouette.name = 'cabin-silhouette';
  silhouette.matrixWorldAutoUpdate = false;
  const pairs = [];
  for (const o of meshes) {
    const m = new THREE.Mesh(o.geometry);
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    silhouette.add(m);
    pairs.push([o, m]);
  }
  const shown = (o) => { for (let p = o; p; p = p.parent) if (!p.visible && p !== car) return false; return true; };
  const syncSilhouette = () => { for (const [src, m] of pairs) { m.matrixWorld.copy(src.matrixWorld); m.visible = shown(src); } };

  // ---------------------------------------------------------------- the glass: mirrors, windshield, rain
  const glassOptions = glassPresetForLevel(level, model);
  let mirrorPass = null, windshieldLayer = null, rainLayer = null;
  const removeStages = [];
  try {
    const strides = glassOptions.mirrors.groundStride || {};
    const ground = [...(ctx.ground || []).map(([mesh, grid]) => [mesh, strides[grid] || 1]), ...(ctx.wideMesh ? [[ctx.wideMesh, strides.wide || 1]] : [])];
    mirrorPass = createMirrors({ renderer, scene, session, car, carGroup: car, faces: mirrors, options: glassOptions.mirrors, lightsNode, ground });
    for (const m of mirrorStandIns) m.dispose();
    mirrorStandIns.length = 0;
  } catch (e) { console.warn(`cabin mirrors left out: ${e && e.message ? e.message : e}`); }
  try {
    if (glassOptions.windshield.enabled) windshieldLayer = createWindshield({ parent: car, corners: windshield.corners, options: glassOptions.windshield, env, pipeline, renderer, silhouette });
  } catch (e) { console.warn(`cabin windshield left out: ${e && e.message ? e.message : e}`); }
  try {
    if (glassOptions.rain?.enabled && pipeline && !pipeline.legacy) {
      rainLayer = createGlassRain({ car, corners: windshield.corners, options: glassOptions.rain, env, session, renderer, pipeline, occluders: silhouette, scene });
    }
  } catch (e) { console.warn(`cabin rain on the glass left out: ${e && e.message ? e.message : e}`); }

  // ---------------------------------------------------------------- the metering mask (plan 01 section 11.4)
  // the windshield's picture of where the glass is seen (windshield.node.js: 0 behind the dashboard, the pillars and the
  // mirror), handed to plan 01's exposure so a meter reads through the glass; redrawn for the meter when the view has
  // turned or zoomed (every frame anyway in the shipped look, where the bloom veil reads it)
  const meter = plan01.env?.exposure;
  let maskSet = false, maskAt = { frame: -Infinity, yaw: NaN, pitch: NaN, fov: NaN };
  function meterDue(camera) {
    if (!meter?.setMeteringMask || !windshieldLayer) return false;
    const e = rig.effectiveLook, n = renderer.info.frame ?? 0;
    const moved = !(Math.abs(e.yaw - maskAt.yaw) <= 0.5 && Math.abs(e.pitch - maskAt.pitch) <= 0.5 && Math.abs(camera.fov - maskAt.fov) <= 0.2);
    if (maskSet && (!moved || n - maskAt.frame < 15)) return false;
    maskAt = { frame: n, yaw: e.yaw, pitch: e.pitch, fov: camera.fov };
    return true;
  }
  function setMask() { if (!maskSet && meter?.setMeteringMask && windshieldLayer) { meter.setMeteringMask(windshieldLayer.glassSeen); maskSet = true; } }
  function clearMask() { if (maskSet && meter?.setMeteringMask) meter.setMeteringMask(null); maskSet = false; maskAt.yaw = NaN; }

  // ---------------------------------------------------------------- displays
  let look = { night: false, dusk: 0 };
  const displays = createDisplayDriver({
    session, settings, city, env, instruments, screen: screenCanvas, look: () => look,
    onDrawn: (which) => { (which === 'instruments' ? instrumentsTex : screenTex).needsUpdate = true; },
  });

  // ---------------------------------------------------------------- light, each frame
  const _up = new THREE.Vector3(), _sunDir = new THREE.Vector3(), _inv = new THREE.Matrix4();
  const _toSun = new THREE.Vector3(), _sunCabin = new THREE.Vector3(), _eyeAt = new THREE.Vector3();
  const { glassOut } = glassFrame(windshield.corners);
  function updateLight(L) {
    if (worldHemi) {
      fill.color.copy(worldHemi.color).lerp(worldHemi.groundColor, 0.5);
      fill.intensity = FILL * worldHemi.intensity;
    }
    const d = look.dusk;
    if (classic) {
      displayScale.instruments.value = classicDisplay(d);
      displayScale.screen.value = classicDisplay(d) * 0.95;
    } else {
      displayScale.instruments.value = displayLuminance(d);
      displayScale.screen.value = displayLuminance(d) * DISPLAY_CD.screen;
    }
    if (cabinSun) {
      _inv.copy(L.body).invert();
      _toSun.copy(worldSun.position).sub(worldSun.target.position).normalize();
      _sunCabin.copy(_toSun).transformDirection(_inv);
      cabinSun.color.copy(worldSun.color);
      cabinSun.intensity = worldSun.intensity * sunIntoCabin(_sunCabin, glassOut);
      _eyeAt.setFromMatrixPosition(L.body);
      cabinSun.target.position.copy(_eyeAt);
      cabinSun.position.copy(_eyeAt).addScaledVector(_toSun, 10);
      cabinSun.updateMatrixWorld(true);
      cabinSun.target.updateMatrixWorld(true);
    }
    glow.intensity = 0.02 * d;
    glow.position.copy(GLOW_AT).applyMatrix4(L.body);
    glow.updateMatrixWorld(true);
    // the mirrors' stand-in takes the haze's tone, darkened
    if (scene.fog) for (const m of mirrorStandIns) m.color.copy(scene.fog.color).multiplyScalar(0.3);
  }

  /** The car at the body and the steering wheel turned, for this frame. */
  function placeCar(L) {
    car.matrix.copy(L.body);
    car.matrixWorldNeedsUpdate = true;
    if (wheel) wheel.quaternion.copy(wheelRest).multiply(_wq.setFromAxisAngle(wheelAxis, L.wheel));
    car.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- the mirror stage (beforeScene)
  let drawFrame = null, mirrorJs = 0;
  const removeMirrorStage = mirrorPass && pipeline?.addStage ? pipeline.addStage({
    id: 'cabin-mirrors', at: 'beforeScene',
    render: () => {
      const L = rig.last;
      if (!drawFrame || !car.visible || !L || L.view !== 'cabin') return;
      mirrorJs += mirrorPass.render(drawFrame, L);
    },
  }) : null;
  if (removeMirrorStage) removeStages.push(removeMirrorStage);

  let renders = 0;
  const timing = createTimings(); // the part's own JavaScript per drawn frame, the renderer's own work excluded
  const depth = renderer.reversedDepthBuffer ? 'reversed' : renderer.logarithmicDepthBuffer ? 'logarithmic' : 'standard';

  const build = {
    model, level, meta, car, mirrors, windshield, wheel,
    get look() { return look; },
    get readout() { return { ...displays.readout }; },
    glass: { options: glassOptions, mirrors: mirrorPass, windshield: windshieldLayer, rain: rainLayer },
    setDrawOrder(order) { for (const o of meshes) o.renderOrder = order; },
    setLook(l) { look = { night: !!l.night, dusk: Number.isFinite(l.dusk) ? l.dusk : l.night ? 1 : 0 }; mirrorPass?.setLook(look); },
    update(frame) { if (rig.view === 'cabin') displays.update(frame, false); },
    /** Before the pipeline draws (session.js `around`): the scene's lights already hold what this frame draws with. */
    beforeRender(frame) {
      const L = rig.last;
      const on = !!L && L.view === 'cabin' && rig.view === 'cabin';
      car.visible = on;
      drawFrame = on ? frame : null;
      if (!on) { windshieldLayer?.hide(); rainLayer?.hide(); clearMask(); return; }
      const t0 = performance.now();
      displays.update(frame, false);
      placeCar(L);
      updateLight(L);
      mirrorPass?.shade(worldHemi, worldSun);
      if (windshieldLayer) {
        _inv.copy(L.body).invert();
        if (worldSun) _sunDir.copy(worldSun.position).sub(worldSun.target.position).normalize().transformDirection(_inv);
        else _sunDir.copy(localUp(frame.camera.position.x, frame.camera.position.z, _up)).transformDirection(_inv);
        const traffic = session.part?.('traffic');
        syncSilhouette();
        windshieldLayer.update({
          frame, L, sunDir: _sunDir, sunColor: worldSun?.color, sunIntensity: worldSun?.intensity ?? 0, hemi: worldHemi,
          lampPoints: traffic?.lampPoints ? traffic.lampPoints() : null, eyeWorld: frame.camera.position, camera: frame.camera,
          ambientLux: env?.lighting?.ambientLux ? env.lighting.ambientLux() : undefined, meterDue: meterDue(frame.camera),
        });
        setMask();
      }
      if (rainLayer) {
        syncSilhouette();
        rainLayer.update(frame, { camera: frame.camera, L });
      }
      renders++;
      timing.add(performance.now() - t0 + mirrorJs);
      mirrorJs = 0;
    },
    /** After the pipeline has drawn (session.js `around`): the scene's matrix updates are the scene's again. */
    afterRender() { mirrorPass?.release(); },
    stats: () => ({
      model, level, renders, depth, order: CABIN_ORDER, sunInside: cabinSun ? +cabinSun.intensity.toPrecision(3) : null, js: timing.summary(), display: classic ? 'classic' : 'physical',
      displayScale: { instruments: displayScale.instruments.value, screen: displayScale.screen.value },
      meteringMask: { supported: !!meter?.setMeteringMask, set: maskSet },
      mirrors: mirrorPass ? mirrorPass.stats() : null, windshield: windshieldLayer ? windshieldLayer.stats() : null,
      rain: rainLayer ? rainLayer.stats() : null,
    }),
    dispose() {
      for (const r of removeStages) r();
      clearMask();
      mirrorPass?.dispose();
      windshieldLayer?.dispose();
      rainLayer?.dispose();
      car.parent?.remove(car);
      root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      for (const m of [...Object.values(materials), instrumentsMat, screenMat, ...mirrorStandIns]) m.dispose();
      instrumentsTex.dispose(); screenTex.dispose();
    },
  };
  return build;
}

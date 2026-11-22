// Rain on the windshield (plan 02, D8.2): drops, the film and the two wiper blades, drawn in the cabin pass over the
// windshield opening (so the clean camera has none of it). The rules are drops.js and wipers.js (pure, tested); the
// shaders glassRain.glsl.js; this file feeds them each frame.
//
// Per frame (update): the weather's rain rate (env.weather.state()), the wiper cycle for it, the window of bins
// (drops.js createBinWindow: per half-second bin of absolute simulation time, the expected arrivals per site from the
// car's pose at that time, journey.poseAt, and the rain relative to it, rainMirror.js relativeRain; cached per bin, so a
// playing clock computes about one new bin a frame at 16x and a seek 64), and the blades' sweep at 12 instants over the
// frame's exposure (wipers.js comfortOf). Everything the GPU sees is a pure function of simulation time, the weather and
// the clock's rate (the last only for how the blades blur).
// Before the cabin is drawn (copyFrame), the world as drawn so far is copied into a texture for the drops' lenses and
// the film; only while it rains.
// Dry: the three meshes are hidden and nothing is copied; the glass draws exactly what it drew before D8.2.
// Test hooks: state() { mode, angle, angles, q, dropCount, ... }, drops() (the JavaScript mirror's list),
// setSpeedOverride(m/s | null) (the drops as if the car went at that speed), setEnabled(bool).

import * as THREE from 'three';
import { glassRainShaders } from './glassRain.glsl.js';
import { DROP, glassOf, siteLayout, arrivalRate, runSpeed, createBinWindow, glassDrops } from './drops.js';
import { wiperSchedule, wipePhase, sweepAtPhase, comfortOf, bladeAngle } from './wipers.js';
import { WIPERS } from './windshield.js';
import { relativeRain } from '../weather/rainMirror.js';
import { createTimings } from '../timing.js';

const SAMPLES = 12;
/** Micro-drops of the mist per unit of arriving water (ASSUMED: rain holds an order of magnitude more drops under
 * 1 mm than over it, Marshall-Palmer's ratio at a few mm/h), each in a MIST_CELL (4 mm) cell. */
const MIST_K = 10, MIST_CELL = 0.004;
/** The lens: a drop shows the scene over MAG times its own radius, upside down (ASSUMED, by eye; a real drop shows a
 * still wider field). */
const MAG = 14;

/**
 * @param {{ cabinScene: THREE.Scene, corners: object, options: object, env: object, session: object,
 *   renderer: THREE.WebGLRenderer }} o  options: a preset's `rain` (glassPresets.js)
 */
export function createGlassRain({ cabinScene, corners, options, env, session, renderer }) {
  const { bottomLeft: BL, bottomRight: BR, topRight: TR, topLeft: TL } = corners;
  const glass = glassOf(corners);
  const layout = siteLayout(glass, options.siteM);
  const glassPoint = (x, y, out) => {
    const u = x / glass.W, v = y / glass.H;
    const b = new THREE.Vector3().lerpVectors(BL, BR, u), t = new THREE.Vector3().lerpVectors(TL, TR, u);
    return out.lerpVectors(b, t, v);
  };

  const shaders = glassRainShaders({
    bins: DROP.BINS, binS: DROP.BIN_S, renewS: DROP.RENEW_S, renewFadeS: DROP.RENEW_FADE_S, nRunMin: DROP.N_RUN_MIN,
    nRunSpan: DROP.N_RUN_SPAN, runSpeedK: DROP.RUN_SPEED_K, vRun: DROP.V_RUN, side: DROP.SIDE, runLifeS: DROP.RUN_LIFE_S,
    r0: DROP.R0_M * DROP.SIZE_GAIN, jitter: DROP.JITTER,
  });
  const frameTex = new THREE.FramebufferTexture(1, 1);
  frameTex.minFilter = THREE.LinearFilter; frameTex.magFilter = THREE.LinearFilter;
  const res = new THREE.Vector2(1, 1);
  const uniforms = {
    uBins: { value: Array.from({ length: DROP.BINS }, () => new THREE.Vector4()) },
    uK0: { value: 0 }, uTw: { value: 0 }, uRenewOffset: { value: 0 },
    uWipe: { value: new THREE.Vector4(0, 1, 1, 0) },
    uWiperP: { value: WIPERS.map((w) => new THREE.Vector4(w.x, w.y, w.rIn, w.rOut)) },
    uWiperA: { value: WIPERS.map((w) => new THREE.Vector4(w.a0, w.a1, 0, 0)) },
    uLayout: { value: new THREE.Vector4(glass.W, glass.H, layout.nx, layout.ny) },
    uBL: { value: BL.clone() }, uBR: { value: BR.clone() }, uTL: { value: TL.clone() }, uTR: { value: TR.clone() },
    uComfort: { value: 0 },
    uFrame: { value: frameTex }, uResolution: { value: res }, uSky: { value: new THREE.Color(0, 0, 0) },
    uMag: { value: MAG }, uMistRate: { value: 0 }, uHaze: { value: 0 },
    uQ: { value: new Array(SAMPLES).fill(0) }, uQStep: { value: 0 }, uQRange: { value: new THREE.Vector2() }, uBlade: { value: new THREE.Color(0.02, 0.02, 0.022) },
  };
  const material = (name, s) => new THREE.ShaderMaterial({
    name, uniforms, vertexShader: s.vertex, fragmentShader: s.fragment,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });

  // the film: a grid over the glass (fine enough that the trapezoid's bilinear map holds), glass metres per vertex
  const filmGeo = new THREE.BufferGeometry();
  {
    const NX = 24, NY = 12, pos = [], g = [], idx = [], p = new THREE.Vector3();
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const x = (i / NX) * glass.W, y = (j / NY) * glass.H;
      pos.push(...glassPoint(x, y, p).toArray()); g.push(x, y);
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i;
      idx.push(a, a + 1, a + NX + 2, a, a + NX + 2, a + NX + 1);
    }
    filmGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    filmGeo.setAttribute('aGlass', new THREE.Float32BufferAttribute(g, 2));
    filmGeo.setIndex(idx);
  }
  // the drops: one quad per site and kind
  const dropGeo = new THREE.InstancedBufferGeometry();
  dropGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  dropGeo.setIndex([0, 1, 2, 0, 2, 3]);
  dropGeo.instanceCount = layout.count * 3;
  // the blades: each wiper's swept sector and a margin, clipped to the glass's height
  const bladeGeo = new THREE.BufferGeometry();
  {
    const pos = [], g = [], wi = [], idx = [], p = new THREE.Vector3();
    const NA = 48, NR = 6;
    WIPERS.forEach((w, k) => {
      const base = pos.length / 3;
      for (let j = 0; j <= NR; j++) for (let i = 0; i <= NA; i++) {
        const a = ((w.a0 - 6 + ((w.a1 - w.a0 + 12) * i) / NA) * Math.PI) / 180, r = ((w.rOut + 0.02) * j) / NR;
        const x = w.x + r * Math.cos(a), y = w.y + r * Math.sin(a);
        pos.push(...glassPoint(x, y, p).toArray()); g.push(x, y); wi.push(k);
      }
      for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
        const a = base + j * (NA + 1) + i;
        idx.push(a, a + 1, a + NA + 2, a, a + NA + 2, a + NA + 1);
      }
    });
    bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bladeGeo.setAttribute('aGlass', new THREE.Float32BufferAttribute(g, 2));
    bladeGeo.setAttribute('aWiper', new THREE.Float32BufferAttribute(wi, 1));
    bladeGeo.setIndex(idx);
  }
  const film = new THREE.Mesh(filmGeo, material('glass-film', shaders.film));
  const drops = new THREE.Mesh(dropGeo, material('glass-drops', shaders.drops));
  const blades = new THREE.Mesh(bladeGeo, material('glass-blades', shaders.blades));
  // drawn before the veil (windshield.js, 20), which adds the dirt's glare on top
  film.renderOrder = 17; drops.renderOrder = 18; blades.renderOrder = 19;
  const meshes = [film, drops, blades];
  for (const m of meshes) { m.frustumCulled = false; m.visible = false; m.name = m.material.name; cabinScene.add(m); }

  let enabled = options.enabled !== false;
  let speedOverride = null;
  let R = 0, sched = wiperSchedule(0), phase = 0, tSec = 0, raining = false, comfort = { c: 0, exposureS: 0, wipesPerRealS: 0 };
  let win = null, poseNow = null, rateNow = 0;
  let state = null;
  const timing = createTimings();

  // one bin of absolute simulation time: the expected arrivals per site and the runners' speed up the glass, from the
  // car's pose at the bin's start. Pure in k for one cache key (the journey and its timing, the weather, the hold).
  let held = null;
  function source(k) {
    const journey = session?.journey;
    const tMs = k * DROP.BIN_S * 1000;
    let pose = held ? held : journey ? journey.poseAt(tMs) : poseNow;
    if (speedOverride !== null && pose) pose = { ...pose, speed: speedOverride };
    if (!pose) return { lambda: 0, vy: 0 };
    const rel = relativeRain(state, pose);
    return { lambda: (arrivalRate(R, rel.velocityCar, glass, rel.fallMps) * DROP.BIN_S) / layout.count, vy: runSpeed(pose.speed || 0) };
  }
  const bins = createBinWindow(source);

  /**
   * @param {object} frame the session's frame  @param {{ sky?: THREE.Color }} [o] sky: the haze's colour (linear)
   */
  function update(frame, { sky } = {}) {
    const t0 = performance.now();
    state = env?.weather?.state?.() || { precipMmPerHour: 0 };
    R = state.precipMmPerHour || 0;
    raining = enabled && R > 0;
    sched = wiperSchedule(R);
    tSec = frame.simMs / 1000;
    phase = wipePhase(tSec, sched);
    for (const m of meshes) m.visible = raining;
    // the blades show when parked too (they sit along the cowl, mostly below the opening), but draw nothing new dry
    if (!raining) { win = null; timing.add(performance.now() - t0); return; }
    poseNow = frame.pose;
    const journey = session?.journey;
    const locked = !!session?.locked;
    held = locked && journey ? { ...journey.poseAtS(frame.pose.s), speed: 0 } : null;
    const key = `${journey?.id}|${journey?.departMs}|${R}|${state.windMps}|${state.windFromDeg}|${locked ? Math.round(frame.pose.s * 10) : ''}|${speedOverride}`;
    win = bins.at(tSec, key);
    const b = uniforms.uBins.value;
    for (let j = 0; j < DROP.BINS; j++) b[j].fromArray(win.data, 4 * j);
    uniforms.uK0.value = win.k0 >>> 0;
    uniforms.uTw.value = win.tw;
    uniforms.uRenewOffset.value = win.renewOffset;
    const on = Number.isFinite(sched.periodS);
    uniforms.uWipe.value.set(phase, sched.sweepS, on ? sched.periodS : 1, on ? 1 : 0);
    rateNow = frame.rate;
    comfort = comfortOf(sched, frame.rate, frame.playing);
    uniforms.uComfort.value = comfort.c;
    // the blades over the exposure: 12 instants from now back
    let step = 0, prev = null, qlo = 1, qhi = 0;
    for (let s = 0; s < SAMPLES; s++) {
      const ph = on ? wipePhase(tSec - (comfort.exposureS * s) / (SAMPLES - 1), sched) : 0;
      const q = sweepAtPhase(ph, sched);
      uniforms.uQ.value[s] = q;
      if (prev !== null) step = Math.max(step, Math.abs(q - prev));
      prev = q; qlo = Math.min(qlo, q); qhi = Math.max(qhi, q);
    }
    uniforms.uQStep.value = step;
    uniforms.uQRange.value.set(qlo, qhi);
    // the mist: micro-drops per cell per second at the arrival rate now
    const rel = relativeRain(state, speedOverride !== null ? { ...frame.pose, speed: speedOverride } : held || frame.pose);
    const perM2 = arrivalRate(R, rel.velocityCar, glass, rel.fallMps) / glass.area;
    uniforms.uMistRate.value = perM2 * MIST_CELL * MIST_CELL * MIST_K;
    uniforms.uHaze.value = 0.25 + 0.25 * Math.min(1, R / 12);
    if (sky) {
      const c = uniforms.uSky.value.copy(sky).convertLinearToSRGB();
      uniforms.uBlade.value.copy(c).multiplyScalar(0.06).addScalar(0.008);
    }
    timing.add(performance.now() - t0);
  }

  const _size = new THREE.Vector2(), _p = new THREE.Vector3();
  const CORNERS = [BL, BR, TR, TL];
  /**
   * Copy the world as drawn into the lens texture (call after the world and the mirrors, before the cabin), only over
   * the windshield opening's box on screen (with a margin for the lenses' reach): the copy resolves the canvas's
   * multisampling, which is most of this layer's cost at high resolutions.
   * @param {THREE.Camera} camera the cabin camera, as it will draw this frame
   */
  function copyFrame(camera) {
    if (!raining) return;
    renderer.getDrawingBufferSize(_size);
    const W = _size.x, H = _size.y;
    if (frameTex.image.width !== W || frameTex.image.height !== H) {
      frameTex.image.width = W; frameTex.image.height = H;
      frameTex.dispose(); // reallocated at the new size below
      frameTex.needsUpdate = true;
      res.set(W, H);
    }
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    if (camera) {
      x0 = W; y0 = H; x1 = 0; y1 = 0;
      for (const c of CORNERS) {
        _p.copy(c).applyMatrix4(camera.matrixWorldInverse);
        if (_p.z > -camera.near) { x0 = 0; y0 = 0; x1 = W; y1 = H; break; } // a corner behind the eye: all
        _p.applyMatrix4(camera.projectionMatrix);
        const x = ((_p.x + 1) / 2) * W, y = ((_p.y + 1) / 2) * H;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      const m = 0.04 * H;
      x0 = Math.max(0, Math.floor(x0 - m)); y0 = Math.max(0, Math.floor(y0 - m));
      x1 = Math.min(W, Math.ceil(x1 + m)); y1 = Math.min(H, Math.ceil(y1 + m));
    }
    if (x1 <= x0 || y1 <= y0) return;
    const prev = renderer.getRenderTarget();
    if (prev) renderer.setRenderTarget(null);
    renderer.initTexture(frameTex);
    const gl = renderer.getContext(), st = renderer.state;
    st.bindTexture(gl.TEXTURE_2D, renderer.properties.get(frameTex).__webglTexture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x0, y0, x1 - x0, y1 - y0);
    st.unbindTexture();
    if (prev) renderer.setRenderTarget(prev);
    copied = [x0, y0, x1 - x0, y1 - y0];
  }
  let copied = null;

  /** What the GPU draws, from the JavaScript mirror (for tests: a few milliseconds over every site). */
  function mirrorDrops() {
    if (!raining || !win) return [];
    return glassDrops({ layout, win: { ...win, data: win.data.slice() }, wipe: { phase, sched }, wipers: WIPERS });
  }

  return {
    meshes, layout, glass, frameTexture: frameTex,
    get enabled() { return enabled; },
    get raining() { return raining; },
    setEnabled(v) { enabled = !!v; if (!enabled) for (const m of meshes) m.visible = false; },
    setSpeedOverride(v) { speedOverride = Number.isFinite(v) ? v : null; },
    update,
    copyFrame,
    drops: mirrorDrops,
    /** { mode, angle (the driver's blade, degrees), angles, q, dropCount, comfort, rate } */
    state() {
      const q = sweepAtPhase(phase, sched);
      return {
        mode: sched.mode, q, angle: bladeAngle(q, WIPERS[0]), angles: WIPERS.map((w) => bladeAngle(q, w)),
        dropCount: mirrorDrops().length, periodS: sched.periodS, comfort: comfort.c, exposureS: comfort.exposureS,
        rateMmPerHour: R, clockRate: rateNow, sites: layout.count,
      };
    },
    stats: () => ({ enabled, raining, mode: sched.mode, sites: layout.count, bins: bins.size, copied, js: timing.summary() }),
    dispose() {
      for (const m of meshes) { cabinScene.remove(m); m.geometry.dispose(); }
      meshes[0].material.dispose(); meshes[1].material.dispose(); meshes[2].material.dispose();
      frameTex.dispose();
    },
  };
}

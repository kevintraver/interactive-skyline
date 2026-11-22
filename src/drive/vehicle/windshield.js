// The windshield, first part (plan 02, D4.4; section 7.6): a layer over the windshield opening, drawn in the
// cabin pass (so the clean camera has none), additive: light that the dirt on the glass scatters toward the eye
// lifts the darks, and the lit dashboard top shows faintly in the lower glass by day. The shader is
// windshield.glsl.js; the functions below are its arithmetic in JavaScript, which the unit tests check.
//
// The dirt mask (windshieldMask): generated once, procedurally. Two tandem wiper arcs of a left-hand-drive car
// (both park along the cowl and sweep up to the left) leave a cleaner swept area; dust outside it, heavier low
// down and toward the pillars; a dust line along each arc's outer edge; a few dried streaks running down. Values
// are the dirt's relative strength, 0..1 (swept glass about 0.2, dusty glass 0.6 to 1).
//
// The veil (cd/m^2), per point of the glass, for a glare source of illuminance E (lux, on a plane facing it):
//     L = m x K x E x phaseVeil(theta),  phaseVeil = cos(theta) / (theta_deg^2 + THETA_C^2)
// the Stiles-Holladay form (veiling luminance as illuminance over angle squared, valid 1 to 30 degrees; plan
// reference G7) for a forward-scattering layer, with cos(theta) for the illuminance at the eye and a core
// THETA_C so it stays finite at the source. K is the glass's own share: ASSUMED 4 (the eye's own scatter is 10 in
// the same units; a used, dusty windshield adds glare of the same order). Sources:
//   - the sun: E = direct normal illuminance at the sun's elevation (sunNormalLux: 127.5 klux outside the
//     atmosphere, clear-sky extinction 0.21 per air mass (ASSUMED, dry desert air) over the Kasten-Young air
//     mass), only while the sun shines on the glass's outer face (lit, from the angle between them: the roof
//     shades the glass when the sun is behind);
//   - the sky: the dust scatters a little of the sky's light everywhere: L = m x K_SKY x E_h / pi, K_SKY 0.001
//     (ASSUMED), so with the sun behind the veil is under 1% of a road's luminance (D4.4's acceptance);
//   - the brightest oncoming head lamps (the traffic part's lamp points, kind head, facing the eye): 800 cd toward
//     an eye above the cut-off with a cos^6 lobe (traffic/lamps.js LAMP_CD, LOBE: FMVSS 108 Table XIX-a), each
//     switched on by its vehicle's own threshold; the few strongest by illuminance at the eye.
// In scene units: luminance x (scene per lux), where scene per lux is the scene's horizontal irradiance (its sky
// light plus its sun) over the real one (env.js ambientLux) by day, and env.lighting.units.lux (0.1) at night;
// the sun term is soft-capped (CAP_SUN), the lamps' too (CAP_LAMP), so a head lamp's glare never whites out the
// road.
// The dashboard: the view reflected in the glass's plane, where it meets the dash top's plane inside its
// outline, at the glass's unpolarised Fresnel reflectance (n = 1.52, both faces), times the dash's radiance in
// the cabin's own light (albedo DASH_ALBEDO, ASSUMED a mid-dark grey top).

import * as THREE from 'three';
import { windshieldShaders } from './windshield.glsl.js';
import { LAMP_CD, LOBE, vehicleThresholdLux } from '../traffic/lamps.js';
import { LIGHTING_UNITS, ambientLux } from '../env.js';
import { createTimings } from '../timing.js';

export const VEIL = Object.freeze({
  /** cd/m^2 per lux per deg^-2, for mask 1 (assumed: see the header) */
  K: 4,
  /** the core of the phase function, degrees */
  THETA_C: 0.5,
  /** the dust's share of the sky's light (assumed) */
  K_SKY: 0.001,
  /** soft caps in scene units: the sun's veil and the lamps' (the road at night is 0.003 to 0.06) */
  CAP_SUN: 1.5,
  CAP_LAMP: 0.12,
});
export const GLASS_N = 1.52;
const DASH_ALBEDO = 0.05;
/** Extraterrestrial illuminance (lux) and clear-sky extinction per air mass (assumed). */
const E0 = 127500, EXTINCTION = 0.21;
const RAD = Math.PI / 180;
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Kasten and Young's (1989) relative air mass for an apparent elevation in degrees. */
export function airMass(elDeg) {
  const h = Math.max(-0.5, elDeg);
  return 1 / (Math.sin(h * RAD) + 0.50572 * (h + 6.07995) ** -1.6364);
}

/** Direct normal illuminance of the sun under a clear sky (lux); 0 below the horizon (faded over the last half-degree). */
export function sunNormalLux(elDeg) {
  if (!(elDeg > -0.5)) return 0;
  const fade = Math.min(1, (elDeg + 0.5) / 0.5);
  return fade * E0 * Math.exp(-EXTINCTION * airMass(elDeg));
}

/** The phase term: cos(theta) / (theta_deg^2 + THETA_C^2) for c = cos(theta); 0 beyond 90 degrees. */
export function phaseVeil(c, thetaC = VEIL.THETA_C) {
  if (!(c > 0)) return 0;
  const th = Math.acos(Math.min(c, 1)) / RAD;
  return c / (th * th + thetaC * thetaC);
}

/** Veiling luminance (cd/m^2) from a source of illuminance E (lux) at angle theta (degrees), through dirt m. */
export const veilLuminance = ({ E, thetaDeg, mask = 1, K = VEIL.K }) => mask * K * E * phaseVeil(Math.cos(thetaDeg * RAD));

/** Section 7.6's model, the Stiles-Holladay form: m K E / theta^2 (degrees). */
export const veilModel = ({ E, thetaDeg, mask = 1, K = VEIL.K }) => (mask * K * E) / (thetaDeg * thetaDeg);

/** How much of the sun reaches the glass's outer face: 0 when it is behind the glass, 1 from 6 degrees in front. */
export const sunOnGlass = (cosOut) => { const t = Math.min(1, Math.max(0, cosOut / 0.1)); return t * t * (3 - 2 * t); };

/**
 * The veil at a point of the glass (cd/m^2), the shader's arithmetic without the scene's scale or the caps.
 * Directions are unit [x, y, z] arrays in one frame.
 * @param {{ view: number[], sunDir: number[], glassOut: number[], sunElevation: number, mask?: number, ambient?: number }} o
 *   view: through the glass from the eye; glassOut: the glass's outward normal; ambient: horizontal lux (default
 *   env.js ambientLux at the sun's elevation)
 */
export function veilAt({ view, sunDir, glassOut, sunElevation, mask = 1, ambient }) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const E = sunNormalLux(sunElevation) * sunOnGlass(dot(sunDir, glassOut));
  const sun = mask * VEIL.K * E * phaseVeil(dot(view, sunDir));
  const Eh = ambient ?? ambientLux(sunElevation);
  const sky = (mask * VEIL.K_SKY * Eh) / Math.PI;
  return { sun, sky, total: sun + sky, E };
}

/** Unpolarised Fresnel reflectance of a pane (both faces) for the cosine of the angle of incidence. */
export function glassReflectance(ci, n = GLASS_N) {
  ci = Math.min(1, Math.max(1e-4, ci));
  const si = Math.sqrt(Math.max(0, 1 - ci * ci)) / n;
  const ct = Math.sqrt(Math.max(0, 1 - si * si));
  const rs = (ci - n * ct) / (ci + n * ct), rp = (n * ci - ct) / (n * ci + ct);
  const r = 0.5 * (rs * rs + rp * rp);
  return (2 * r) / (1 + r);
}

/** Head lamp candela toward a direction at angle a (radians) from its axis (traffic/lamps.js). */
export const headLampCandela = (cosA) => (cosA > 0 ? LAMP_CD.head * cosA ** LOBE.head : 0);

// ---------------------------------------------------------------- the dirt mask
/** A small deterministic generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x, y, seed) => {
  let s = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 4; o++) { s += amp * valueNoise(x * f, y * f, seed + o); amp *= 0.5; f *= 2.03; }
  return s / 0.9375;
};

/**
 * The wipers, in glass metres (x from the left edge along the bottom, y up the glass): pivots under the cowl,
 * blades from rIn to rOut, sweeping from a0 to a1 degrees (counter-clockwise from +x). A left-hand-drive tandem
 * pair, sized for FMVSS 104's wiped zones for a wide car (18 deg left, 56 right, 10 up, 5 down of the eye; the
 * plan's G8), assumed.
 */
export const WIPERS = Object.freeze([
  Object.freeze({ x: 0.42, y: -0.05, rIn: 0.12, rOut: 0.64, a0: 4, a1: 96 }),
  Object.freeze({ x: 1.13, y: -0.05, rIn: 0.12, rOut: 0.54, a0: 3, a1: 78 }),
]);

/** Whether a glass point (metres) is in a wiper's swept area, and how far inside (metres, negative outside). */
export function wiperDepth(x, y, w) {
  const dx = x - w.x, dy = y - w.y, r = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx) / RAD;
  const dr = Math.min(r - w.rIn, w.rOut - r);
  const da = Math.min(a - w.a0, w.a1 - a) * RAD * r;
  return Math.min(dr, da);
}

/**
 * The dirt mask: Uint8 values (0..255 for 0..1), rows from the bottom of the glass, `width` x `height`, for a glass
 * of `size` metres (width along the bottom, slant height). Deterministic for a seed.
 */
export function windshieldMask({ width = 512, height = 256, size = [1.665, 0.816], seed = 7 } = {}) {
  const [GW, GH] = size;
  const out = new Uint8Array(width * height);
  const rand = rng(seed);
  // streaks: dried drops' trails running down the unwiped glass
  const streaks = [];
  for (let i = 0; i < 14; i++) streaks.push({ x: rand() * GW, top: GH * (0.55 + 0.45 * rand()), len: 0.08 + 0.25 * rand(), w: 0.002 + 0.004 * rand(), k: 0.12 + 0.18 * rand() });
  for (let j = 0; j < height; j++) {
    const y = ((j + 0.5) / height) * GH;
    for (let i = 0; i < width; i++) {
      const x = ((i + 0.5) / width) * GW;
      const n = fbm(x * 7, y * 7, seed), fine = valueNoise(x * 90, y * 90, seed + 11);
      // dust: heavier low down (the wipers' rest and the spray) and toward the pillars
      const edge = Math.min(x, GW - x, GH - y);
      let dust = 0.55 + 0.25 * n + 0.15 * (1 - y / GH) + 0.15 * Math.max(0, 1 - edge / 0.12) + 0.12 * (fine - 0.5);
      for (const s of streaks) {
        const dx = Math.abs(x - s.x - 0.01 * Math.sin(y * 30 + s.top * 9));
        if (y < s.top && y > s.top - s.len && dx < s.w) dust += s.k * (1 - (s.top - y) / s.len);
      }
      // the swept area: cleaner, with a dust line just outside each blade's tip and at the end of its sweep
      let wiped = 0, line = 0;
      for (const w of WIPERS) {
        const d = wiperDepth(x, y, w);
        wiped = Math.max(wiped, Math.min(1, Math.max(0, (d + 0.004) / 0.02)));
        if (d < 0 && d > -0.018) line = Math.max(line, 1 + d / 0.018);
      }
      const clean = 0.17 + 0.08 * n + 0.04 * (fine - 0.5);
      let m = dust + (clean - dust) * wiped + 0.18 * line * (1 - wiped);
      m = Math.min(1, Math.max(0, m));
      out[j * width + i] = Math.round(m * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the layer
/**
 * @param {{ cabinScene: THREE.Scene, corners: object, options: object, env: object }} o
 *   corners: cabin.js windshield.corners (Vector3s, cabin coordinates); options: a preset's `windshield`
 */
export function createWindshield({ cabinScene, corners, options, env }) {
  const { bottomLeft: BL, bottomRight: BR, topRight: TR, topLeft: TL } = corners;
  const glassW = BL.distanceTo(BR), glassH = BL.distanceTo(TL);
  const [mw, mh] = options.maskSize || [512, 256];
  const maskData = windshieldMask({ width: mw, height: mh, size: [glassW, glassH] });
  const mask = new THREE.DataTexture(maskData, mw, mh, THREE.RedFormat, THREE.UnsignedByteType);
  mask.minFilter = THREE.LinearFilter; mask.magFilter = THREE.LinearFilter; mask.generateMipmaps = false;
  mask.needsUpdate = true;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...BL.toArray(), ...BR.toArray(), ...TR.toArray(), ...TL.toArray()], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // the glass's normal toward the driver (the eye is at the origin's height, behind the glass)
  const glassIn = new THREE.Vector3().crossVectors(BR.clone().sub(BL), TL.clone().sub(BL)).normalize();
  const mid = BL.clone().add(TR).multiplyScalar(0.5);
  if (new THREE.Vector3(0, 1.2, 0).sub(mid).dot(glassIn) < 0) glassIn.negate();
  const glassOut = glassIn.clone().negate();

  const maxLamps = Math.max(1, options.lamps | 0);
  const { vertex, fragment } = windshieldShaders({ thetaC: VEIL.THETA_C, glassN: GLASS_N, maxLamps });
  const uniforms = {
    uMask: { value: mask }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSun: { value: new THREE.Color(0, 0, 0) },
    uCapSun: { value: VEIL.CAP_SUN }, uSky: { value: new THREE.Color(0, 0, 0) },
    uLamps: { value: Array.from({ length: maxLamps }, () => new THREE.Vector4(0, 0, -1, 0)) },
    uLampColor: { value: new THREE.Color(1, 0.96, 0.9) }, uCapLamp: { value: VEIL.CAP_LAMP },
    uGlassN: { value: glassIn }, uDash: { value: new THREE.Color(0, 0, 0) },
    // the dash top: from the cowl back to the instrument hood, pillar to pillar (cabin.json: cowl at z -1.34, y 0.96)
    uDashRect: { value: new THREE.Vector4(Math.min(BL.x, TL.x) - 0.05, Math.max(BR.x, TR.x) + 0.05, BL.z - 0.02, -0.66) },
    uDashY: { value: BL.y - 0.03 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'windshield', uniforms, vertexShader: vertex, fragmentShader: fragment,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'windshield';
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  cabinScene.add(mesh);

  let enabled = options.enabled !== false;
  mesh.visible = enabled;
  const timing = createTimings();
  const _inv = new THREE.Matrix4(), _d = new THREE.Vector3(), _c = new THREE.Color();
  const picked = []; // [E, x, y, z] of the strongest lamps this frame
  const last = { scenePerLux: 0, sunLux: 0, lit: 0, sunVeil: 0, lamps: [], ambient: 0 };

  /**
   * Set the uniforms for this frame (cabin coordinates).
   * @param {{ frame: object, L: object, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number,
   *   hemi: THREE.HemisphereLight|null, lampPoints: object|null, eyeWorld: THREE.Vector3 }} o
   *   sunDir: unit, toward the sun, cabin coordinates; sunIntensity and hemi: the scene's own lights (scene units)
   */
  function update({ frame, L, sunDir, sunColor, sunIntensity, hemi, lampPoints, eyeWorld }) {
    if (!enabled) return;
    const t0 = performance.now();
    const el = frame.sun.elevation;
    const ambient = ambientLux(el);
    // scene per lux: the scene's horizontal irradiance over the real one, never above the night units
    const sinEl = Math.max(0, Math.sin(el * RAD));
    const sceneEh = (sunIntensity || 0) * sinEl * (sunColor ? lum(sunColor) : 1) + (hemi ? hemi.intensity * lum(hemi.color) : 0);
    const S = Math.min(LIGHTING_UNITS.lux, sceneEh / Math.max(ambient, 1e-6));
    uniforms.uSunDir.value.copy(sunDir);
    const lit = sunOnGlass(sunDir.dot(glassOut));
    const E = sunNormalLux(el) * lit;
    // the sun's colour without its strength (the look fades the scene's sun light; the veil uses the real one)
    _c.copy(sunColor || _c.setRGB(1, 1, 1));
    const lc = Math.max(1e-6, lum(_c));
    uniforms.uSun.value.copy(_c).multiplyScalar((VEIL.K * E * S) / lc);
    const skyC = hemi ? _c.copy(hemi.color).multiplyScalar(1 / Math.max(1e-6, lum(hemi.color))) : _c.setRGB(1, 1, 1);
    uniforms.uSky.value.copy(skyC).multiplyScalar((VEIL.K_SKY * ambient * S) / Math.PI);
    // the brightest oncoming head lamps
    picked.length = 0;
    if (lampPoints && lampPoints.count && L?.body) {
      _inv.copy(L.body).invert();
      const P = lampPoints.position, F = lampPoints.facing;
      for (let i = 0; i < lampPoints.count; i++) {
        if (lampPoints.kind[i] !== 0) continue;
        if (ambient >= vehicleThresholdLux(lampPoints.id[i])) continue;
        const dx = eyeWorld.x - P[3 * i], dy = eyeWorld.y - P[3 * i + 1], dz = eyeWorld.z - P[3 * i + 2];
        const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
        if (d < 2) continue;
        const cosA = (F[3 * i] * dx + F[3 * i + 1] * dy + F[3 * i + 2] * dz) / d;
        const I = headLampCandela(cosA) * (lampPoints.alpha[i] ?? 1);
        if (I <= 0) continue;
        const Ei = I / d2;
        if (picked.length < maxLamps || Ei > picked[picked.length - 1][0]) {
          picked.push([Ei, -dx / d, -dy / d, -dz / d]);
          picked.sort((a, b) => b[0] - a[0]);
          if (picked.length > maxLamps) picked.pop();
        }
      }
    }
    for (let i = 0; i < maxLamps; i++) {
      const p = picked[i], u = uniforms.uLamps.value[i];
      if (!p) { u.set(0, 0, -1, 0); continue; }
      _d.set(p[1], p[2], p[3]).transformDirection(_inv);
      u.set(_d.x, _d.y, _d.z, VEIL.K * p[0] * S);
    }
    // the dash top in the cabin's light: Lambert, the sun through the glass and the sky
    if (options.dashboard !== false) {
      const sunOnDash = (sunIntensity || 0) * Math.max(0, sunDir.y) * lit;
      const e = sunOnDash + (hemi ? hemi.intensity : 0);
      uniforms.uDash.value.setRGB(1, 1, 1).multiplyScalar((DASH_ALBEDO * e) / Math.PI);
      if (hemi) uniforms.uDash.value.multiply(_c.copy(hemi.color).lerp(sunColor || hemi.color, sunOnDash / Math.max(e, 1e-6)));
    } else uniforms.uDash.value.setRGB(0, 0, 0);
    Object.assign(last, { scenePerLux: S, sunLux: E, lit, ambient, sunVeil: VEIL.K * E * S, lamps: picked.map((p) => +p[0].toFixed(4)) });
    timing.add(performance.now() - t0);
  }

  return {
    mesh, material, mask, maskData, glassIn, glassOut, size: [glassW, glassH],
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; mesh.visible = enabled; },
    update,
    stats: () => ({ enabled, ...last, js: timing.summary() }),
    dispose() { cabinScene.remove(mesh); geometry.dispose(); material.dispose(); mask.dispose(); },
  };
}

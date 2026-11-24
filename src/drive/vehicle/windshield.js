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
import { createTimings } from '../timing.js';
import {
  VEIL, GLASS_N, airMass, sunNormalLux, phaseVeil, veilLuminance, veilModel, sunOnGlass, veilAt, glassReflectance, headLampCandela,
  WIPERS, wiperDepth, windshieldMask, veilFrame, glassFrame,
} from './veil.js';

export { VEIL, GLASS_N, airMass, sunNormalLux, phaseVeil, veilLuminance, veilModel, sunOnGlass, veilAt, glassReflectance, headLampCandela, WIPERS, wiperDepth, windshieldMask };

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
  const picked = []; // [E, x, y, z] of the strongest lamps this frame
  let last = { scenePerLux: 0, sunLux: 0, lit: 0, sunVeil: 0, lamps: [], ambient: 0 };
  const out = { sunDir: uniforms.uSunDir.value, sun: uniforms.uSun.value, sky: uniforms.uSky.value, lamps: uniforms.uLamps.value, dash: uniforms.uDash.value };
  const consts = { glassOut, maxLamps, dashboard: options.dashboard, picked };

  /**
   * Set the uniforms for this frame (cabin coordinates): veil.js veilFrame.
   * @param {{ frame: object, L: object, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number,
   *   hemi: THREE.HemisphereLight|null, lampPoints: object|null, eyeWorld: THREE.Vector3 }} o
   */
  function update(o) {
    if (!enabled) return;
    const t0 = performance.now();
    last = veilFrame(o, out, consts);
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

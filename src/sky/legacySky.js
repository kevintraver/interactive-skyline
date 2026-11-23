// Today's sky: a two-colour dome, exponential fog, a hemisphere light and one fixed sun, switched between two
// hand-tuned looks. Behind three functions (init, apply, dispose) so phase 1 can drive it from the clock and
// phase 3 can delete it in one commit (plan 01, section 5.6).
import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { night } from '../night.js';
import { createKeyLight } from './lighting.js';
import { createDiscs } from './discs.js';
import { haze } from '../render/materials/shared.js';
import { active } from '../render/active.js';
import { domeNodeMaterial, legacyFogNode } from '../render/materials/skyMaterials.js';
import { onDemandShadow } from '../render/shadowCompat.js';

const FOG_DENSITY = 0.000014;

// Sky, haze and light, by day and by night. `street` is how strongly the ground glows from street lighting
// (near grid, far grid); the moon stands in for the sun so shadows stay where they are.
export const DAY = { haze: 0xd3dee8, zenith: 0x4f86c9, skyLight: 0xdbe8ff, groundLight: 0x8d8371, hemi: 0.8, sun: 0xfff0dc, sunPower: 2.7, tint: 0.45, street: [0, 0] };
export const NIGHT = { haze: 0x3b3850, zenith: 0x05070f, skyLight: 0x33426e, groundLight: 0x4a3a2a, hemi: 0.38, sun: 0x93a8d9, sunPower: 0.2, tint: 0.16, street: [0.07, 0.26] };
const STREET_GLOW = 0xffa858;

// Interim (T1.4, replaced by the atmosphere in phase 3): in the clock state the two looks above become the ends
// of five keyframes by the Sun's altitude, blended smoothly, so a dusk scrub has no visible step.
const SUNSET = { haze: 0xe0b89c, zenith: 0x4870ad, skyLight: 0xe6caa8, groundLight: 0x7f705c, hemi: 0.62, sun: 0xffb36b, sunPower: 1.6, tint: 0.36, street: [0.01, 0.05] };
const CIVIL = { haze: 0x8a7089, zenith: 0x1f2c57, skyLight: 0x6b6d98, groundLight: 0x5a4836, hemi: 0.46, sun: 0x93a8d9, sunPower: 0.2, tint: 0.22, street: [0.05, 0.18] };
const NAUTICAL = { haze: 0x4c4662, zenith: 0x0b1225, skyLight: 0x3c4874, groundLight: 0x4c3b2b, hemi: 0.39, sun: 0x93a8d9, sunPower: 0.2, tint: 0.17, street: [0.07, 0.26] };
export const KEYFRAMES = [[10, DAY], [0, SUNSET], [-6, CIVIL], [-12, NAUTICAL], [-18, NIGHT]];
const COLORS = ['haze', 'zenith', 'skyLight', 'groundLight', 'sun'];
const NUMBERS = ['hemi', 'sunPower', 'tint'];
const smooth = (t) => t * t * (3 - 2 * t);
export const smoothstep = (e0, e1, x) => smooth(Math.min(1, Math.max(0, (x - e0) / (e1 - e0))));
const toColors = (look) => ({ ...look, ...Object.fromEntries(COLORS.map((k) => [k, new THREE.Color(look[k])])) });
const FRAMES = KEYFRAMES.map(([alt, look]) => [alt, toColors(look)]);

/** The look for a solar altitude: the keyframes on either side, blended with a smoothstep. */
export function lookAt(altDeg, out = toColors(DAY)) {
  let i = FRAMES.findIndex(([alt]) => altDeg >= alt);
  if (i === 0 || i === -1) {
    const [, end] = FRAMES[i === 0 ? 0 : FRAMES.length - 1];
    for (const k of COLORS) out[k].copy(end[k]);
    for (const k of NUMBERS) out[k] = end[k];
    out.street = [...end.street];
    return out;
  }
  const [a0, l0] = FRAMES[i - 1], [a1, l1] = FRAMES[i];
  const t = smooth((a0 - altDeg) / (a0 - a1));
  for (const k of COLORS) out[k].lerpColors(l0[k], l1[k], t);
  for (const k of NUMBERS) out[k] = l0[k] + (l1[k] - l0[k]) * t;
  out.street = l0.street.map((v, j) => v + (l1.street[j] - v) * t);
  return out;
}

export function createLegacySky() {
  // the haze colour is the shared uniform's value: fog, dome horizon and facade reflections read it on both renderers
  const HAZE = haze.value.set(DAY.haze), ZENITH = new THREE.Color(DAY.zenith);
  const sky = {
    sun: null, hemi: null, dome: null, scene: null, invalidate: null,
    /** 'pinned' (today's two looks) or 'clock' (follows env.state; plan 01, sections 4.2 and 5.6). */
    mode: 'pinned', state: null, imagery: true, terrain: [],
    /** What the classic look set: key body, weight and sun power, hemisphere, street glow (read by render/look.js). */
    classic: { sunPower: DAY.sunPower, hemi: DAY.hemi, street: [0, 0], imagery: true, keyBody: 'sun', keyWeight: 1, pinned: true },
    /** Add fog, dome and lights to the scene. */
    init({ scene, city, invalidate, renderer }) {
      sky.scene = scene;
      sky.invalidate = invalidate;
      sky.renderer = renderer;
      scene.fog = new THREE.FogExp2(HAZE, FOG_DENSITY);
      // the new renderer: the same exponential-squared fog as a node, reading the shared haze uniform (T2.3)
      if (!active.legacy) scene.fogNode = legacyFogNode(haze, uniform(FOG_DENSITY));
      sky.dome = new THREE.Mesh(
        new THREE.SphereGeometry(120000, 32, 16),
        active.legacy ? active.legacy.domeMaterial({ value: ZENITH }) : domeNodeMaterial(ZENITH),
      );
      scene.add(sky.dome);

      const hemi = sky.hemi = new THREE.HemisphereLight(DAY.skyLight, DAY.groundLight, DAY.hemi);
      scene.add(hemi);
      const sun = sky.sun = new THREE.DirectionalLight(DAY.sun, DAY.sunPower);
      // afternoon sun in the west-southwest, 32 degrees up
      const az = THREE.MathUtils.degToRad(245), el = THREE.MathUtils.degToRad(32);
      // the shadow map covers a square around the towers, sized per city
      const shade = sky.shade = city.shadow;
      sun.target.position.set(shade.x, 0, -shade.y);
      sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(shade.half * 2.5).add(sun.target.position);
      sun.castShadow = true;
      sun.shadow.mapSize.set(4096, 4096);
      Object.assign(sun.shadow.camera, { left: -shade.half, right: shade.half, top: shade.half, bottom: -shade.half, near: shade.half * 0.5, far: shade.half * 4.5 });
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 1.2;
      onDemandShadow(renderer, sun);
      scene.add(sun, sun.target);
      sky.key = createKeyLight({ sun, renderer, shade });
      sky.discs = createDiscs(scene);
      return sky;
    },
    /**
     * Switch sky, haze, light and street glow between day and night. Buildings follow the shared `night` uniform.
     * `terrain` is [{ mesh }] for the far and near ground; `imagery` whether the aerial photo is shown.
     */
    apply({ night: isNight, imagery, terrain }) {
      sky.imagery = imagery;
      sky.terrain = terrain;
      if (sky.mode === 'clock' && sky.state) { sky.update(sky.state); sky.invalidate(); return; }
      sky.look(isNight ? NIGHT : DAY, isNight ? 1 : 0);
      sky.invalidate();
    },
    /** Set sky, haze, light and street glow to one look; `nightValue` drives the buildings' night uniform. */
    look(look, nightValue) {
      const { imagery, terrain } = sky;
      night.value = nightValue;
      // the classic values, for the physical look to scale (src/render/look.js); in the pinned looks the key is the
      // afternoon Sun or the stand-in moon at full strength
      Object.assign(sky.classic, { sunPower: look.sunPower, hemi: look.hemi, street: [...look.street], imagery,
        keyBody: nightValue > 0.5 ? 'moon' : 'sun', keyWeight: 1, pinned: sky.mode !== 'clock' });
      HAZE.set(look.haze);
      sky.scene.fog.color.copy(HAZE); // the fog keeps its own copy of the haze color
      ZENITH.set(look.zenith);
      sky.hemi.color.set(look.skyLight);
      sky.hemi.groundColor.set(look.groundLight);
      sky.hemi.intensity = look.hemi;
      sky.sun.color.set(look.sun);
      sky.sun.intensity = look.sunPower;
      terrain.forEach((t, i) => {
        t.mesh.material.emissive.set(STREET_GLOW);
        // without the photo there is no street pattern to light, so keep the plain ground dim
        t.mesh.material.emissiveIntensity = look.street[i] * (imagery ? 1 : 0.3);
      });
    },
    /** Clock state: follow the environment's state (frame step 40). Interim, until phase 3 deletes this sky. */
    update(state) {
      sky.state = state;
      if (sky.mode !== 'clock') return;
      const alt = state.sun.altDeg;
      sky.current = lookAt(alt, sky.current || undefined);
      // the buildings' shared night uniform: smoothstep from +2 to -6 degrees (T1.4)
      const nightValue = smoothstep(2, -6, alt);
      sky.look(sky.current, nightValue);
      sky.light(state);
      sky.discs.update(state, true, nightValue);
      if (Math.abs(sky.current.tint - sky.paintedTint) > 0.004) { sky.paintedTint = sky.current.tint; sky.onTint(); }
    },
    /** The key light from env.state.key: the Sun by day, the Moon at night, nothing in between (T1.3). */
    light(state) {
      const { key } = state;
      if (key.body !== 'none') sky.key.aim(key.dir);
      const sunPower = sky.current ? sky.current.sunPower : DAY.sunPower;
      sky.sun.intensity = key.body === 'sun' ? sunPower * key.weight : key.body === 'moon' ? NIGHT.sunPower * key.weight : 0;
      Object.assign(sky.classic, { keyBody: key.body, keyWeight: key.weight, sunPower: key.body === 'moon' ? NIGHT.sunPower : sunPower, pinned: false });
    },
    /** Switch between the pinned looks and the clock; back to pinned restores today's fixed light. */
    setMode(mode, state) {
      sky.mode = mode;
      if (state) sky.state = state;
      if (mode === 'pinned') { sky.aimPinned(); sky.key.reset(); sky.discs.update(null, false); sky.current = null; }
      else sky.paintedTint = NaN;
    },
    aimPinned() {
      const shade = sky.shade;
      const az = THREE.MathUtils.degToRad(245), el = THREE.MathUtils.degToRad(32);
      sky.sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(shade.half * 2.5).add(sky.sun.target.position);
      if (sky.renderer) sky.renderer.shadowMap.needsUpdate = true;
    },
    /** How strongly removable towers glow blue in this look (in the clock state, the blended look's). */
    tint: (isNight) => (sky.mode === 'clock' && sky.current ? sky.current.tint : (isNight ? NIGHT : DAY).tint),
    current: null, paintedTint: NaN,
    /** Called when the clock state's tint has moved enough to repaint the towers (set by the app). */
    onTint: () => {},
    dispose() {
      sky.discs.dispose();
      sky.scene.remove(sky.dome, sky.hemi, sky.sun, sky.sun.target);
      sky.dome.geometry.dispose();
      sky.dome.material.dispose();
      sky.sun.shadow.dispose();
      sky.scene.fog = null;
    },
  };
  return sky;
}

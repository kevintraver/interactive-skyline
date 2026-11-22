// Puts the drive's blended look (look.js) on the app's legacy sky while driving, and hands the sky back on leaving.
// The legacy sky (src/sky/legacySky.js) has one seam for this: while `sky.hold` is set, its apply() calls it instead
// of switching, so the app's own calls (a change of the imagery setting, the drive's night flag) repaint the blend.
//
// What it sets: the dome (its own material while driving: the legacy dome's two colours plus a warm band low on
// the sun's side, which is the legacy dome exactly when the band is off), the fog colour, the hemisphere light, the
// directional light's colour, power and direction, the shared `night` uniform (windows and LED skins), and the street
// glow on the app's ground meshes. Exposure is not touched: both legacy looks use the same one.
//
// The directional light follows the ephemeris: its direction is the sun's at the simulation time rounded to
// SUN_STEP_MS, so it moves in steps of about half a degree, and the app's shadow map (rendered on demand,
// renderer.shadowMap.autoUpdate is false) is refreshed only when that step changes or the light changes hands
// between sun and moon. Rounding the time keeps the light, and so the shadows, a pure function of simulation time.
// Low in the sky a step moves long shadows a long way, so the shadows fade out between 10 and 2 degrees (look.js
// shadowAt) and are gone before the steps would show.

import * as THREE from 'three';
import { night } from '../night.js';

/** The sun's direction is taken at the simulation time rounded to this: 2 minutes, about half a degree of sun. */
export const SUN_STEP_MS = 120000;
const STREET_GLOW = 0xffa858; // as legacySky.js sets it
const RAD = Math.PI / 180;

const DOME_VERTEX = 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
// The legacy dome's gradient, then a band low on the sun's side: strongest at the horizon toward the sun's azimuth,
// fading over about 20 degrees up; a concentrated glow around the sun's azimuth over a broad warm tint that fades to
// nothing on the far side. glowAmount 0 leaves the legacy dome's colour exactly.
const DOME_FRAGMENT = `uniform vec3 horizon; uniform vec3 zenith; uniform vec3 glow; uniform float glowAmount; uniform vec2 sunAz; varying vec3 d;
void main(){
  float h = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(horizon, zenith, pow(h, 0.45));
  vec2 a = normalize(d.xz + vec2(1e-6, 0.0));
  float toward = 0.5 + 0.5 * dot(a, sunAz);
  float t2 = toward * toward, t6 = t2 * t2 * t2;
  float w = glowAmount * exp(-h * 5.0) * (0.4 * toward + 0.6 * t6);
  gl_FragColor = vec4(mix(c, glow, clamp(w, 0.0, 1.0)), 1.0);
}`;

/** Scene direction (x east, y up, z south) for an azimuth clockwise from north and an elevation, degrees. */
export function sceneDirection(azimuth, elevation, out = new THREE.Vector3()) {
  const az = azimuth * RAD, el = elevation * RAD;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

/**
 * @param {{ dome: THREE.Mesh, renderer: THREE.WebGLRenderer, invalidate: () => void, ephemeris: { sun(ms: number): { azimuth: number, elevation: number } },
 *   ground: [THREE.Mesh, string][], imagery: () => boolean }} opts
 *   dome: the app's sky dome (legacySky puts the sky on its userData); ground: the app's ground meshes in the
 *   order the legacy sky's apply() takes them.
 * @returns {{ set(look: object, simMs: number): void, release(): void, readonly held: boolean, stats(): object } | null}
 *   null when the app's sky is not the legacy one.
 */
export function createSkyBlend({ dome, renderer, invalidate, ephemeris, ground, imagery }) {
  const sky = dome?.userData?.sky;
  if (!sky || !sky.sun || !sky.hemi) return null;
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      horizon: { value: new THREE.Color() }, zenith: { value: new THREE.Color() }, glow: { value: new THREE.Color() },
      glowAmount: { value: 0 }, sunAz: { value: new THREE.Vector2(0, -1) },
    },
    vertexShader: DOME_VERTEX, fragmentShader: DOME_FRAGMENT,
  });
  material.name = 'drive sky';
  let held = null, look = null, simStep = null, shadowKey = null, refreshes = 0;
  let terrain = ground.map(([mesh]) => ({ mesh })), withImagery = imagery();
  const dir = new THREE.Vector3();
  const srgb = (color, rgb) => color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);

  function take() {
    held = { material: dome.material, position: sky.sun.position.clone(), shadow: sky.sun.shadow.intensity };
    dome.material = material;
    sky.hold = (g) => { terrain = g.terrain; withImagery = g.imagery; paint(); };
  }

  function paint() {
    if (!held || !look) return;
    const s = look.sky, u = material.uniforms;
    srgb(u.horizon.value, s.haze);
    srgb(u.zenith.value, s.zenith);
    srgb(u.glow.value, s.glow);
    u.glowAmount.value = s.glowAmount;
    const az = look.sun.azimuth * RAD;
    u.sunAz.value.set(Math.sin(az), -Math.cos(az));
    if (sky.scene?.fog) srgb(sky.scene.fog.color, s.haze);
    srgb(sky.hemi.color, s.skyLight);
    srgb(sky.hemi.groundColor, s.groundLight);
    sky.hemi.intensity = s.hemi;
    srgb(sky.sun.color, look.light.color);
    sky.sun.intensity = look.light.intensity;
    sky.sun.shadow.intensity = look.light.shadow;
    night.value = look.lights;
    terrain.forEach((t, i) => {
      t.mesh.material.emissive.set(STREET_GLOW);
      t.mesh.material.emissiveIntensity = look.street[i] * (withImagery ? 1 : 0.3);
    });
    // the light's direction: the sun's at the rounded time, or the night look's moon from the map's fixed place
    const target = sky.sun.target.position;
    if (look.light.source === 'sun') {
      const sun = ephemeris.sun(simStep * SUN_STEP_MS);
      const reach = held.position.distanceTo(target);
      sky.sun.position.copy(target).addScaledVector(sceneDirection(sun.azimuth, Math.max(sun.elevation, 0.5), dir), reach);
    } else sky.sun.position.copy(held.position);
    // with no shadow to see (the sun under 2 degrees) the map is not redrawn as the sun moves
    const key = look.light.source !== 'sun' ? look.light.source : look.light.shadow > 0 ? `sun ${simStep}` : 'sun, no shadow';
    if (key !== shadowKey) {
      shadowKey = key;
      if (look.light.source !== 'none') { renderer.shadowMap.needsUpdate = true; refreshes++; }
    }
    invalidate();
  }

  return {
    get held() { return !!held; },
    /** Show a look (look.js lookAt) at a simulation time; takes the sky the first time. */
    set(next, simMs) {
      const step = Math.round(simMs / SUN_STEP_MS);
      if (look === next && step === simStep && held) return;
      look = next;
      simStep = step;
      if (!held) take();
      paint();
    },
    /** Hand the sky back: the legacy dome and the map's fixed sun. The caller then applies the map's own look. */
    release() {
      if (!held) return;
      sky.hold = null;
      dome.material = held.material;
      sky.sun.position.copy(held.position);
      sky.sun.shadow.intensity = held.shadow;
      held = null;
      look = null;
      shadowKey = null;
      renderer.shadowMap.needsUpdate = true;
      invalidate();
    },
    stats: () => ({ held: !!held, shadowRefreshes: refreshes, source: look?.light.source ?? null }),
    dispose() { material.dispose(); },
  };
}

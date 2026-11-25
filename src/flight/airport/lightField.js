// The airport's light field (plan 03, section 7.10; F4.4): every light of the layout as a light point, in one draw.
//
// Each light is a camera-facing quad sized in pixels, carrying the flux of plan 1's pointSource() (the eye's
// illuminance E = I / d^2 spread over the sprite, so a light keeps its brightness at any size) with a Gaussian profile,
// as the aircraft's own lamps are drawn (src/flight/aircraft/lightsDraw.js). Everything that depends on the eye is in
// the vertex stage:
//   - the beam: the light's intensity toward the eye from its lobe (lightLayout.js lobe(), the CPU twin), so approach
//     lights blaze along the approach and nearly vanish from the side, and edge lights fall away as they pass;
//   - the PAPI: each unit red below its setting and white above it, by the eye's elevation angle at the unit;
//   - distance: E = I / d^2 and the air's extinction exp(-3.912 d / visibility) (Koschmieder);
//   - size: a light whose single pixel would pass PEAK_PER_PIXEL HDR units grows (flux conserved) up to MAX_PX, and no
//     further: a light at 100 m is a small hot dot whose glare is left to the pipeline's bloom (spreading it here drew
//     every near light as a white disc), and one at 20 km is a dim pixel that still reads;
//   - depth: the quad is drawn PULL of the way nearer the eye than the light, so the pavement the light stands on does
//     not cut off the lower half of its glow at a grazing angle.
// Brightness steps and flashes are one small uniform array indexed by the light's slot (lightLayout.js), so changing
// day to night or firing a flasher writes a few floats, never the buffers. All lights pass `artificial: true`, so plan
// 1's lights-out control dims the airport with the city.

import { BufferAttribute, BufferGeometry, Mesh, AdditiveBlending } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute, varying, uniform, uniformArray, vec3, vec4, float, int, exp, sqrt, max, min, abs, atan, dot, length, step, mix, smoothstep, clamp,
  cameraPosition, cameraProjectionMatrix, cameraViewMatrix, positionWorld, screenSize,
} from 'three/tsl';
import { COLOURS } from '../aircraft/lights.js';
import { CATEGORIES, PAPI_TRANSITION_DEG, levelsFor, createFlashSequencer, groupVisible } from './lightLayout.js';

/** HDR units one pixel may carry before the sprite grows instead. */
export const PEAK_PER_PIXEL = 12;
/** Sprite size limits, pixels (the Gaussian's full width is about the size). */
export const MIN_PX = 1.5;
export const MAX_PX = 2.5;
/** Share of the distance the quad is drawn nearer the eye than its light. */
export const PULL = 0.04;
/** Lights drawn this far above where the layout puts them (m), clear of the pavement's lifts (surfaces.js LIFT). */
export const RENDER_LIFT = 0.15;

const unitLum = (c) => { const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return c.map((v) => v / y); };
/** Linear RGB of unit luminance: the aircraft's aviation red, green and white, and aviation yellow and blue. */
export const LIGHT_COLOURS = Object.freeze({
  white: COLOURS.white, red: COLOURS.red, green: COLOURS.green,
  yellow: Object.freeze(unitLum([1, 0.62, 0.08])), blue: Object.freeze(unitLum([0.08, 0.22, 1])),
});

/**
 * @param {{ layout: ReturnType<import('./lightLayout.js').layoutLights>, toScene: (x: number, y: number, z: number) => number[],
 *   nodes: { pointSource: Function }, toMap?: (p: { x: number, y: number, z: number }) => number[] }} o
 *   toScene: map metres and height above sea level to scene axes; toMap: a scene position back to map [x, y, z]
 */
export function createLightField({ layout, toScene, toMap, nodes }) {
  const n = layout.lights.length;
  const pos = new Float32Array(n * 12), ax = new Float32Array(n * 16), beam = new Float32Array(n * 16), colr = new Float32Array(n * 16);
  const corner = new Float32Array(n * 8);
  const index = new Uint32Array(n * 6);
  const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  layout.lights.forEach((l, i) => {
    const p = toScene(l.x, l.y, l.z + RENDER_LIFT);
    const c = l.colour === 'papi' ? LIGHT_COLOURS.white : LIGHT_COLOURS[l.colour] ?? LIGHT_COLOURS.white;
    for (let k = 0; k < 4; k++) {
      const v = 4 * i + k;
      pos.set(p, 3 * v);
      // the beam's horizontal direction in scene axes (x, -y), its elevation and all-round share
      ax.set([l.dir ? l.dir[0] : 0, l.dir ? -l.dir[1] : 0, l.elev, l.omni], 4 * v);
      beam.set([l.hHalf, l.vHalf, l.candela, l.slot], 4 * v);
      colr.set([c[0], c[1], c[2], l.papi ? (l.papi.setting * Math.PI) / 180 : -1], 4 * v);
      corner.set(C[k], 2 * v);
    }
    index.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3], 6 * i);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('lightAxis', new BufferAttribute(ax, 4));
  g.setAttribute('lightBeam', new BufferAttribute(beam, 4));
  g.setAttribute('lightColour', new BufferAttribute(colr, 4));
  g.setAttribute('corner', new BufferAttribute(corner, 2));
  g.setIndex(new BufferAttribute(index, 1));

  const levels = new Array(layout.slots.length).fill(0);
  const uLevels = uniformArray(levels.slice(), 'float');
  const uSigma = uniform(3.912 / 80000);

  const m = new MeshBasicNodeMaterial({ name: 'airport-lights', transparent: true, depthWrite: false, depthTest: true, blending: AdditiveBlending, fog: false });
  m.lights = false;
  const axis = attribute('lightAxis', 'vec4'), bm = attribute('lightBeam', 'vec4'), lc = attribute('lightColour', 'vec4');
  const toEye = cameraPosition.sub(positionWorld);
  const d = max(length(toEye), 1e-3);
  const hx = toEye.x, hz = toEye.z;
  const hlen = max(length(vec3(hx, 0, hz)), 1e-6);
  const el = atan(toEye.y, hlen);
  const dir = axis.xy;
  const hasDir = step(0.5, length(dir));
  // an all-round light has no axis: its angle off the axis is 0 (atan(0, 1)), never atan(0, 0), which is undefined in
  // WGSL and gives NaN on Metal
  const cross = abs(hx.mul(dir.y).sub(hz.mul(dir.x))).mul(hasDir);
  const along = mix(float(1), hx.mul(dir.x).add(hz.mul(dir.y)), hasDir);
  const dh = atan(cross, along);
  const a = dh.div(bm.x), b = el.sub(axis.z).div(bm.y);
  const main = exp(a.mul(a).add(b.mul(b)).mul(-Math.LN2));
  const above = clamp(el.add(0.1).div(0.1), 0, 1);
  // PAPI: red below the unit's setting, white above; red is the white through a 15 % filter
  const isPapi = step(0, lc.w);
  const white = mix(float(1), smoothstep(lc.w.sub(PAPI_TRANSITION_DEG * Math.PI / 180), lc.w.add(PAPI_TRANSITION_DEG * Math.PI / 180), el), isPapi);
  const papiI = mix(float(1), mix(float(0.15), float(1), white), isPapi);
  const level = uLevels.element(int(bm.w));
  const candela = bm.z.mul(main.add(axis.w.mul(above))).mul(papiI).mul(level).mul(exp(d.mul(uSigma).negate()));
  const { color: onePixel } = nodes.pointSource(candela, { minPixels: 1, artificial: true });
  const vOne = varying(onePixel, 'vAptOne');
  const sizePx = varying(clamp(sqrt(onePixel.div(PEAK_PER_PIXEL)), MIN_PX, MAX_PX), 'vAptSize');
  const vColour = varying(mix(lc.xyz, mix(vec3(...LIGHT_COLOURS.red), vec3(...LIGHT_COLOURS.white), white), isPapi), 'vAptColour');
  const SIGMA = 0.6;
  const sigma = sizePx.mul(SIGMA);
  const vCorner = varying(attribute('corner', 'vec2').mul(sizePx.mul(SIGMA * 3)), 'vAptPx');
  m.vertexNode = (() => {
    const view = cameraViewMatrix.mul(vec4(positionWorld, 1));
    const pulled = vec4(view.xyz.mul(float(1 - PULL)), 1);
    const clip = cameraProjectionMatrix.mul(pulled);
    return vec4(clip.xy.add(vCorner.mul(2).div(screenSize).mul(clip.w)), clip.z, clip.w);
  })();
  const r2 = dot(vCorner, vCorner);
  // a Gaussian holding the flux of a one-pixel sprite: its integral over the quad is vOne
  const profile = exp(r2.div(sigma.mul(sigma).mul(-2))).div(sigma.mul(sigma).mul(2 * Math.PI));
  m.colorNode = vec4(vColour.mul(vOne).mul(profile).mul(step(r2, sigma.mul(sigma).mul(9))), 1);

  const mesh = new Mesh(g, m);
  mesh.name = 'airport-lights';
  mesh.frustumCulled = false; // the quads are collapsed onto their lights until the vertex stage spreads them
  mesh.renderOrder = 20;
  mesh.raycast = () => {};

  const seq = createFlashSequencer(layout);
  const visible = layout.groups.map(() => false);
  const catLevel = new Array(CATEGORIES.length).fill(0);
  let lastFlash = null;
  return {
    mesh,
    /**
     * Set the brightness steps and the flashes for this frame.
     * @param {{ eye?: number[], wallS: number, night: boolean, reducedMotion?: boolean, visibilityM?: number, levels?: object }} o
     *   eye: the camera in map metres and height above sea level (for which flashers are in view)
     */
    update({ eye = null, wallS = 0, night = true, reducedMotion = false, visibilityM = 80000, levels: override = null } = {}) {
      const step = { ...levelsFor({ night, visibilityM }), ...(override || {}) };
      CATEGORIES.forEach((c, i) => { catLevel[i] = step[c] ?? 0; });
      layout.groups.forEach((gr, i) => { visible[i] = eye ? groupVisible(layout, gr, eye) : true; });
      const fl = seq.update(wallS, visible, reducedMotion);
      lastFlash = fl;
      const arr = uLevels.array;
      for (let s = 0; s < layout.slots.length; s++) {
        const slot = layout.slots[s];
        const base = catLevel[CATEGORIES.indexOf(slot.category)];
        arr[s] = slot.flash ? base * fl[s - layout.firstFlashSlot] : base;
      }
      uSigma.value = 3.912 / Math.max(visibilityM, 100);
      return { levels: arr, flash: lastFlash, visible };
    },
    /** Eye in map axes from a scene position, when the caller has the scene camera. */
    eyeOf: (p) => (toMap ? toMap(p) : null),
    count: n,
    dispose() { g.dispose(); m.dispose(); },
  };
}

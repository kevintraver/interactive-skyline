// The billboard faces on plan 01's renderer (plan 02, D7.4; third stretch, decisions 2 and 6): billboardsFace.js's
// shader as a MeshLambertNodeMaterial, so the faces take the scene's lights like everything else. Same inputs (the
// instance attributes aFace, aAd, aFit; the atlas, the table and the artwork) and the same rules (the hash, the holds,
// the fade, the fit, the letterbox bars, the three modes), read billboardsFace.js's header for them. The schedules and
// the hash are JavaScript in screens/digital.js, art.js and billboardsImages.js; tests/unit/roadside/
// billboards-images.test.js and tests/unit/screens/programs.test.js hold this text to them as they hold the GLSL.
//
//   const { material, uniforms } = faceMaterial({ blank, blankTable, photometry });
//   uniforms.uAds.value = atlasTexture;  uniforms.uMode.value = 2;  uniforms.uDigitalLevel.value = cdM2;  ...
//
// `uniforms` has the keys of billboards.js's classic uniforms, each with a `.value` (texture nodes for the textures,
// render-group uniform nodes for the rest), so the part sets either kind the same way.
//
// Light (decision 6). A digital face emits its picture x uDigitalLevel, a static face its picture x uStaticLevel x the
// floodlights' gradient (brighter at the bottom), both multiplied by photometry.node.js luminance(): the pre-exposure
// and the lights-out slider in the shipped look, where the levels are cd/m^2 per unit of picture colour
// (screens/digital.js faceLevels 'physical': the static face is vinyl under its floodlights' lux, albedo x E / pi), and
// LIGHTING_UNITS at the classic display, where they are the classic levels / LIGHTING_UNITS.nit. The albedo under the
// scene's own light is the picture x VINYL (static) or x 0.06 (a screen's dark surface).
//
// Differences from the GLSL, on purpose: the static and digital paths and the three modes are selects, not branches
// (WGSL samples textures only in uniform control flow; the mode is a uniform, the face kind is not), so every face takes
// two taps; and the image index adds n x step before the modulo, so no operand of % is negative (GLSL ES leaves that
// undefined; the value is the same).

import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import {
  attribute, varying, uv, texture, uniform, renderGroup, normalLocal, float, int, uint, ivec2, vec2, vec3, vec4, floor, clamp, mix, step,
  select,
} from 'three/tsl';
import { ATLAS_COLS, ATLAS_ROWS, CELL_H, CELL_W, DESIGNS } from '../screens/art.js';
import { FADE_S, HOLD_S, PLAIN, VINYL } from '../screens/digital.js';
import { luminance, photometryContext } from '../lights/photometry.node.js';
import { FACE_DISPLAY } from './faceDisplay.js';

const shared = (v, name) => uniform(v).setGroup(renderGroup).setName(name);

/** The display a photometry context draws for ('classic' or 'physical'): which units faceLevels should give. */
export const displayOf = (photometry) => photometryContext(photometry).display;

/** faceDisplay.js's limit as a node: the drawn white level for a pre-exposed white level. */
const faceDisplayNode = (x) => {
  const span = FACE_DISPLAY.max - FACE_DISPLAY.knee;
  const over = x.sub(FACE_DISPLAY.knee).max(0);
  return x.clamp(0, FACE_DISPLAY.knee).add(float(span).mul(float(1).sub(over.div(span).negate().exp())));
};

/** lowbias32 (art.js hash32) on uint nodes: x ^= x >> 16; x *= 0x7feb352d; x ^= x >> 15; x *= 0x846ca68b; x ^= x >> 16 */
export function bbHash(x0) {
  let x = x0.bitXor(x0.shiftRight(uint(16)));
  x = x.mul(uint(0x7feb352d));
  x = x.bitXor(x.shiftRight(uint(15)));
  x = x.mul(uint(0x846ca68b));
  return x.bitXor(x.shiftRight(uint(16)));
}

/** The design of hold k of a seed (digital.js frameDesign): hash(seed ^ (uint(k) * 0x9e3779b9)) % DESIGNS */
export const bbDesign = (seed, k) => bbHash(seed.bitXor(uint(k).mul(uint(0x9e3779b9)))).mod(uint(DESIGNS));

/**
 * The image of hold k (billboardsImages.js imageAt): base + (start + k * step) mod n, with aAd = (base, n, start, step).
 * k is at least -1 (content time and phase are not negative), so start + (k + n) * step is never negative.
 */
export function bbImage(ad, k) {
  const n = int(ad.y.add(0.5));
  const i = int(ad.z.add(0.5)).add(k.add(n).mul(int(ad.w.add(0.5)))).mod(n);
  return int(ad.x.add(0.5)).add(i);
}

/**
 * The face material: { material, uniforms }.
 * @param {{ blank: THREE.Texture, blankTable: THREE.Texture, photometry?: object }} o  blank: the 1 x 1 white texture the
 *   images start as; blankTable: the float table they start as; photometry: photometry.node.js's context
 */
export function faceMaterial({ blank, blankTable, photometry = {} }) {
  const ctx = photometryContext(photometry);
  // The sampled images start as a linear-filtered copy of the blank: three's WGSL builder reads a texture whose min and
  // mag filters are both Nearest with textureSampleLevel(..., 0), decided when the shader is built, and would keep doing
  // so after the mipmapped atlas replaces the stand-in (the faces then alias on WebGPU only). The table is read with
  // textureLoad either way.
  const stand = blank.clone();
  stand.minFilter = THREE.LinearFilter;
  stand.magFilter = THREE.LinearFilter;
  stand.generateMipmaps = false;
  stand.needsUpdate = true;
  const uniforms = {
    uArt: texture(stand), uAds: texture(stand), uAdTable: texture(blankTable),
    uAdTexel: shared(new THREE.Vector2(1, 1), 'uBbAdTexel'),
    uMode: shared(0, 'uBbMode'), uTime: shared(0, 'uBbTime'),
    uDigitalLevel: shared(0.5, 'uBbDigitalLevel'), uStaticLevel: shared(0, 'uBbStaticLevel'),
  };
  const { uArt, uAds, uAdTable, uAdTexel, uMode, uTime, uDigitalLevel, uStaticLevel } = uniforms;

  const vFace = varying(attribute('aFace', 'vec4'), 'vBbFace');
  const vAd = varying(attribute('aAd', 'vec4'), 'vBbAd');
  const vFit = varying(attribute('aFit', 'vec2'), 'vBbFit');
  const faceUv = uv();
  const seed = uint(vFace.x.add(0.5));
  const digital = step(0.5, vFace.y); // 1 for a digital face
  const isDigital = vFace.y.greaterThan(0.5);
  const adUv = faceUv.sub(0.5).mul(vFit).add(0.5);

  /** the artwork's colour of a design at face uv (billboardsFace.js bbArt) */
  const art = (design, p) => {
    const cell = vec2(float(design.mod(uint(ATLAS_COLS))), float(design.div(uint(ATLAS_COLS))));
    const inset = vec2(2 / CELL_W, 2 / CELL_H);
    return uArt.sample(cell.add(clamp(p, inset, vec2(1).sub(inset))).div(vec2(ATLAS_COLS, ATLAS_ROWS))).rgb;
  };
  /** an advertisement's colour at image uv, its mean colour (dimmed) in the letterbox bars (billboardsFace.js bbAd) */
  const ad = (image, p) => {
    const rect = uAdTable.load(ivec2(image, int(0)));
    const mean = uAdTable.load(ivec2(image, int(1))).rgb;
    const inset = uAdTexel.mul(0.5).div(rect.zw);
    const c = uAds.sample(rect.xy.add(clamp(p, inset, vec2(1).sub(inset)).mul(rect.zw))).rgb;
    const inside = step(0, p.x).mul(step(p.x, 1)).mul(step(0, p.y)).mul(step(p.y, 1));
    return mix(mean.mul(0.7), c, inside);
  };
  /** what hold k shows (billboardsFace.js bbShow) */
  const show = (k) => select(uMode.greaterThan(1.5), ad(bbImage(vAd, k), adUv),
    select(uMode.greaterThan(0.5), art(select(isDigital, bbDesign(seed, k), seed.mod(uint(DESIGNS))), faceUv), vec3(...PLAIN)));

  // a digital face: hold k, cross-faded from hold k - 1 over FADE_S; a static face: hold 0 (its step is 0), no fade
  const u = uTime.add(vFace.z);
  const kf = floor(u.div(HOLD_S));
  const into = clamp(u.sub(kf.mul(HOLD_S)).div(FADE_S), 0, 1);
  const fade = mix(float(1), into.mul(into).mul(into.mul(-2).add(3)), digital);
  const k = int(kf.mul(digital));
  const now = mix(show(k.sub(1)), show(k), fade);

  const material = new MeshLambertNodeMaterial({ color: 0xffffff });
  material.name = 'billboard-face';
  // albedo: printed vinyl, or a screen's dark surface
  material.colorNode = vec4(now.mul(mix(float(VINYL), float(0.06), digital)), 1);
  // emission: the screen's picture, or the vinyl under its floodlights (brighter at the bottom)
  const level = mix(uStaticLevel.mul(mix(float(1.35), float(0.65), faceUv.y)), uDigitalLevel, digital);
  // in the shipped look the face's white is held inside what the tone mapping shows (faceDisplay.js); the classic
  // display draws the classic levels as they are
  const white = luminance(level, ctx);
  material.emissiveNode = now.mul(ctx.display === 'classic' ? white : faceDisplayNode(white));
  material.addEventListener('dispose', () => stand.dispose());
  return { material, uniforms };
}

/**
 * The floodlights' material: dark housings whose lens glows at uLevel (cd/m^2 per unit of `color`, linear) x
 * luminance(). In the shipped look the lens is the housing's top face (it points up at the face; from the road the
 * housing is seen from below), at the classic display every face glows as on the classic renderer.
 * @param {{ color?: number, photometry?: object }} [o]
 * @returns {{ material: MeshLambertNodeMaterial, uniforms: { uLevel: object } }}
 */
export function lampMaterial({ color = 0xfff1d6, photometry = {} } = {}) {
  const ctx = photometryContext(photometry);
  const uLevel = shared(0, 'uBbLampLevel');
  const material = new MeshLambertNodeMaterial({ color: 0x2b2d30 });
  material.name = 'billboard-lamp';
  const lens = ctx.display === 'classic' ? float(1) : step(0.5, normalLocal.y);
  material.emissiveNode = vec3(new THREE.Color(color)).mul(luminance(uLevel, ctx)).mul(lens);
  return { material, uniforms: { uLevel } };
}

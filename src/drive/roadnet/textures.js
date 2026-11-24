// What the road's two material modules share (material.js on the classic renderer, material.node.js on plan 01's):
// the canvas atlas as textures, and the night glow of the headlight stand-in.
import * as THREE from 'three';
import { drawRoadAtlas, ATLAS_W, ATLAS_H, V_CYCLES } from './atlas.js';

/** Emissive intensity on the night map, near and far from the car. */
export const NIGHT_GLOW = { near: 0.5, far: 0.1 };

/** true/false or a number to a glow weight in 0..1. */
export const nightWeight = (on) => (typeof on === 'number' ? Math.min(1, Math.max(0, on)) || 0 : on ? 1 : 0);

/** A canvas for the atlas, or null where there is none (Node). */
function makeCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(ATLAS_W, ATLAS_H);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: ATLAS_W, height: ATLAS_H });
  return null;
}

/** The day (night false) or night emissive atlas as a texture, or null without a canvas. */
export function atlasTexture(night, anisotropy) {
  const canvas = makeCanvas();
  const ctx = canvas?.getContext('2d');
  if (!ctx) return null;
  drawRoadAtlas(ctx, { night });
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping; // regions sit side by side across
  t.wrapT = THREE.RepeatWrapping; // one marking cycle along, repeating with chainage
  t.flipY = false; // v = 0 at the top of the canvas, where the dashes start
  t.repeat.set(1, 1 / V_CYCLES); // the canvas stacks V_CYCLES marking cycles; the mesh's v counts cycles (atlas.js)
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  return t;
}

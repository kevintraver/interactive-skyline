// The road's canvas atlas as textures (material.js).
import * as THREE from 'three';
import { drawRoadAtlas, ATLAS_W, ATLAS_H, V_CYCLES } from './atlas.js';

/** A canvas for the atlas, or null where there is none (Node). */
function makeCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(ATLAS_W, ATLAS_H);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: ATLAS_W, height: ATLAS_H });
  return null;
}

/** The day atlas (night false) or the one with its night paint as a texture, or null without a canvas. */
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

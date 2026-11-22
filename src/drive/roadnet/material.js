/**
 * Stock materials for the road ribbon: asphalt, lane markings and embankment dirt from one
 * canvas-drawn atlas (see atlas.js), lit by the app's lights and fogged by its FogExp2.
 *
 * Two materials share the textures: `road` for most of the network and `roadNear` for chunks close
 * to the car. They are identical by day; at night `roadNear` glows more, standing in for headlights
 * (which replace it in a later phase) so the markings read for about 150 m ahead while the road
 * farther off stays dim.
 */
import * as THREE from 'three';
import { drawRoadAtlas, ATLAS_W, ATLAS_H } from './atlas.js';

const NIGHT_GLOW = { near: 0.5, far: 0.1 }; // emissive intensity on the night map

/** A canvas for the atlas, or null where there is none (Node). */
function makeCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(ATLAS_W, ATLAS_H);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: ATLAS_W, height: ATLAS_H });
  return null;
}

function atlasTexture(night, anisotropy) {
  const canvas = makeCanvas();
  const ctx = canvas?.getContext('2d');
  if (!ctx) return null;
  drawRoadAtlas(ctx, { night });
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping; // regions sit side by side across
  t.wrapT = THREE.RepeatWrapping; // one marking cycle along, repeating with chainage
  t.flipY = false; // v = 0 at the top of the canvas, where the dashes start
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  return t;
}

/**
 * @param {{ anisotropy?: number }} [opts] anisotropy: pass renderer.capabilities.getMaxAnisotropy()
 * @returns {{ road: THREE.MeshLambertMaterial, roadNear: THREE.MeshLambertMaterial,
 *   map: THREE.Texture|null, nightMap: THREE.Texture|null, setNight(on: boolean): void, dispose(): void }}
 */
export function createRoadMaterials({ anisotropy = 1 } = {}) {
  const map = atlasTexture(false, anisotropy);
  const nightMap = atlasTexture(true, anisotropy);
  const make = () => new THREE.MeshLambertMaterial({
    map,
    color: map ? 0xffffff : 0x55534f,
    emissiveMap: nightMap,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    // the road is seen at grazing angles for kilometres a few decimetres above coarse ground
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const road = make(), roadNear = make();
  road.name = 'road'; roadNear.name = 'road-near';
  return {
    road, roadNear, map, nightMap,
    setNight(on) {
      road.emissiveIntensity = on ? NIGHT_GLOW.far : 0;
      roadNear.emissiveIntensity = on ? NIGHT_GLOW.near : 0;
    },
    dispose() { road.dispose(); roadNear.dispose(); map?.dispose(); nightMap?.dispose(); },
  };
}

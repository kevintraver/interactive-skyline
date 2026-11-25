// The ground and sky for a flight (plan 03, sections 7.9 and 7.14, until the regional grids of phase 6 exist).
//
//   wide grid       the coarse 160 m grid that reaches the drive routes, drawn as the drive draws it on plan 01's
//                   renderer (src/world/terrain/widemesh.js), under the map's near and far grids
//   virtual ground  beyond the wide grid, a plain surface in the mean colour of the wide photo's edge that falls with
//                   the curve of the datum (src/city/apron.js's geometry, rings out to 500 km), so that from any
//                   height nothing but ground is seen below the horizon
//   map apron       the map's own apron rings the far grid and, inside the wide grid, rises above the wide ground in
//                   places (as the drive found): hidden while flying
//   sky dome        centred on the camera already (src/sky/legacySky.js); scaled while flying to just inside the far
//                   plane, which the flight sets to the horizon plus 80 km (from 87 km on the runway to 480 km), so the
//                   terrain to the horizon is in front of it and the dome is never cut by the far plane. Scale 1 again
//                   on leaving
//
// Everything here is added on show(true) and taken out on show(false); the map's look is untouched when not flying.
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { buildWideMesh } from '../world/terrain/widemesh.js';
import { apronGeometry } from '../city/apron.js';

/** Rings of the virtual ground beyond the wide grid's edge, metres: tucked under it, then out to 500 km, 25 km apart
 * past 100 km so that the chords sag no more than about 10 m below the curve between rings. */
export const VIRTUAL_RINGS = [-200, 0, 1500, 6000, 20000, 50000, 75000, 100000,
  ...Array.from({ length: 16 }, (_, k) => 125000 + k * 25000)];
/** The sky dome's radius in src/sky/legacySky.js. */
const DOME_R = 120000;
/** The dome sits at this fraction of the far plane. */
const DOME_AT = 0.97;
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The mean colour (linear RGB) of a band along the edge of an image, or a plain desert tan without one. */
export function edgeTone(image, band = 0.04) {
  const fallback = [0.38, 0.33, 0.27];
  if (!image || typeof OffscreenCanvas === 'undefined') return fallback;
  try {
    const W = 128, H = 128, g = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data, b = Math.max(1, Math.round(W * band));
    const sum = [0, 0, 0];
    let n = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (i >= b && i < W - b && j >= b && j < H - b) continue;
      const k = (j * W + i) * 4;
      for (let c = 0; c < 3; c++) sum[c] += srgbToLinear(px[k + c] / 255);
      n++;
    }
    return sum.map((v) => v / n);
  } catch { return fallback; }
}

/** The virtual ground: plain, its colour following the wide ground's material (photo on or off) on every draw. */
function virtualGround(wide, base, tone, wideMesh) {
  const g = apronGeometry(wide, base, null, { rings: VIRTUAL_RINGS });
  const geo = new THREE.BufferGeometry();
  // positions are world metres out to 560 km; relative to the grid's centre they stay small enough for float32
  const cx = wideMesh.position.x, cz = wideMesh.position.z;
  for (let k = 0; k < g.pos.length; k += 3) { g.pos[k] -= cx; g.pos[k + 2] -= cz; }
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
  geo.setIndex(g.idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const material = new MeshLambertNodeMaterial({ color: new THREE.Color(...tone) });
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(cx, 0, cz);
  mesh.name = 'flight virtual ground';
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.raycast = () => {}; // never picked
  mesh.frustumCulled = false; // it surrounds the camera
  const photo = new THREE.Color(...tone), plain = new THREE.Color();
  mesh.onBeforeRender = () => {
    const m = wideMesh.material;
    // without the aerial photo the ground is the material's plain colour, as the map's is
    material.color.copy(m.map ? photo : plain.copy(m.color));
  };
  return mesh;
}

/**
 * @param {{ scene: THREE.Scene, renderer: object, base: number, terrain: ReturnType<import('../world/terrain/index.js').createTerrain>,
 *           fetchImage: (file: string) => Promise<ImageBitmap>, sky: { dome: THREE.Mesh }, settings: { imagery: boolean },
 *           anisotropy?: number }} o
 */
export async function createFlightWorld({ scene, base, terrain, fetchImage, sky, settings, anisotropy = 1 }) {
  const [wide, bitmap] = await Promise.all([
    terrain.loadWide(),
    terrain.hasWide ? fetchImage('ground-wide.jpg').catch(() => null) : null,
  ]);
  const group = new THREE.Group();
  group.name = 'flight world';
  group.visible = false;
  let wideMesh = null, wideMap = null;
  if (wide) {
    if (bitmap) {
      wideMap = new THREE.Texture(bitmap);
      wideMap.flipY = false; // flipped while decoding, as main.js does for its grids
      wideMap.colorSpace = THREE.SRGBColorSpace;
      wideMap.anisotropy = anisotropy;
      wideMap.needsUpdate = true;
    }
    wideMesh = buildWideMesh({ wide, hole: terrain.grid('far'), base, map: wideMap, legacy: false });
    wideMesh.raycast = () => {}; // picking is for buildings
    group.add(wideMesh, virtualGround(wide, base, edgeTone(bitmap), wideMesh));
  }
  scene.add(group);
  const mapApron = scene.getObjectByName('terrain apron');
  let apronWas = null;

  const world = {
    group, wideMesh,
    /** Add or take out the flight's ground; hides the map's apron while it is out. */
    show(on) {
      group.visible = !!on;
      if (on) {
        if (mapApron && apronWas === null) { apronWas = mapApron.visible; mapApron.visible = false; }
      } else {
        if (mapApron && apronWas !== null) { mapApron.visible = apronWas; apronWas = null; }
        if (sky.dome) sky.dome.scale.setScalar(1);
      }
    },
    /** Every frame while flying: the photo setting, and the dome just inside the far plane. */
    update(camera) {
      if (wideMesh) {
        const want = settings.imagery ? wideMap : null;
        if (wideMesh.material.map !== want) {
          wideMesh.material.map = want;
          wideMesh.material.color.set(want ? 0xffffff : 0xbdb9ad);
          wideMesh.material.needsUpdate = true;
        }
      }
      // either way: near the ground the far plane (the horizon plus 80 km) is closer than the dome's 120 km
      if (sky.dome) sky.dome.scale.setScalar((camera.far * DOME_AT) / DOME_R);
    },
    stats() {
      let triangles = 0;
      group.traverse((o) => { if (o.isMesh && o.geometry.index) triangles += o.geometry.index.count / 3; });
      return { triangles, wide: !!wideMesh };
    },
  };
  return world;
}

/**
 * Stock materials for the road ribbon: asphalt, lane markings and embankment dirt from one
 * canvas-drawn atlas (see atlas.js), lit by the app's lights and fogged by its FogExp2.
 *
 * Two materials share the textures: `road` for most of the network and `roadNear` for chunks close
 * to the car. They are identical by day; at night `roadNear` glows more, standing in for headlights
 * (which replace it in a later phase) so the markings read for about 150 m ahead while the road
 * farther off stays dim.
 *
 * The pavement rides 0.3 m above coarse ground and is seen at grazing angles for kilometres, so it
 * needs a depth bias to win against the ground under it. A slope-scaled polygon offset is wrong
 * for that: it applies to the whole mesh, and on the steep embankment skirts seen edge-on it pulls
 * buried slopes kilometres away forward through the ground in front (the stacked wedges of the far
 * road). Instead the vertex shader moves pavement, shoulder and marking vertices (by the mesh's
 * `kind` attribute) towards the camera along their own view ray by PULL of their distance, which
 * changes depth and nothing on screen; embankment vertices stay put and meet the ground honestly.
 */
import * as THREE from 'three';
import { KIND } from './atlas.js';
import { atlasTexture, NIGHT_GLOW, nightWeight } from './textures.js';

export { nightWeight };
// Fraction of its distance a pavement vertex moves towards the camera: 4 mm at 10 m, 0.4 m at 1 km,
// 4 m at 10 km, each several times the depth buffer's resolution there with a near plane up to 5 m.
export const PULL = 4e-4;

/** Pull pavement (every kind but embankment) towards the camera in depth; see the header. */
function pullPavement(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float kind;')
    .replace('#include <project_vertex>', [
      '#include <project_vertex>',
      `if ( kind < ${(KIND.embankment - 0.5).toFixed(1)} ) { mvPosition.xyz *= ${(1 - PULL).toFixed(6)}; gl_Position = projectionMatrix * mvPosition; }`,
    ].join('\n'));
}

/**
 * @param {{ anisotropy?: number }} [opts] anisotropy: pass renderer.capabilities.getMaxAnisotropy()
 * @returns {{ road: THREE.MeshLambertMaterial, roadNear: THREE.MeshLambertMaterial,
 *   map: THREE.Texture|null, nightMap: THREE.Texture|null, setNight(on: boolean|number): void,
 *   setLook(look: { lights: number }): void, dispose(): void }}
 *   setNight takes true/false or how far the night glow is on (0..1, the look's `lights`): the glow scales with
 *   it, so the markings come up through dusk instead of switching.
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
  });
  const road = make(), roadNear = make();
  for (const m of [road, roadNear]) {
    m.onBeforeCompile = pullPavement;
    m.customProgramCacheKey = () => `road-pull-${PULL}`;
  }
  road.name = 'road'; roadNear.name = 'road-near';
  // with real headlights (lights/headlights.js) the stand-in glow gives way: markings are lit by what the lamps return
  let headlights = false, lastNight = 0;
  const api = {
    road, roadNear, map, nightMap,
    setNight(on) {
      lastNight = on;
      const w = headlights ? 0 : nightWeight(on);
      road.emissiveIntensity = NIGHT_GLOW.far * w;
      roadNear.emissiveIntensity = NIGHT_GLOW.near * w;
    },
    /** The drive's look (look.js): its `beams` (the headlight stand-in's share), or its boolean `night`. */
    setLook(look) { api.setNight(look.beams ?? look.night); },
    /** true while real headlights light the road (the stand-in glow is then off); false brings the glow back. */
    setHeadlights(on) { headlights = !!on; api.setNight(lastNight); },
    dispose() { road.dispose(); roadNear.dispose(); map?.dispose(); nightMap?.dispose(); },
  };
  return api;
}

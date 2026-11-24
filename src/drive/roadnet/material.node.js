/**
 * The road ribbon's materials on plan 01's renderer (plan 02, third stretch, decision 2): material.js's factory and
 * options with three's node materials. Asphalt, lane markings, barriers, decks and embankment dirt from the same
 * canvas atlas (textures.js), lit by the scene's lights; aerial perspective and fog are the pipeline's.
 *
 * Two materials share the textures, as on the classic renderer: `road` for most of the network and `roadNear` for chunks
 * close to the car, identical by day; at night `roadNear` glows more, standing in for headlights until they are ported.
 *
 * Depth (decision 7). The classic renderer pulls pavement vertices toward the camera (material.js) because its depth
 * buffer cannot keep pavement 0.3 m above coarse ground apart at kilometres. Plan 01's renderer has reversed depth on
 * both backends, and the depth test of the port (2026-11-23, Apple M4, both backends) found the pull unnecessary: pulling
 * pavement by PULL changed at most one pixel of a 1280 x 720 frame of the road 15 to 22 km ahead and of the valley from
 * Railroad Pass, and pushing it away by 2 % (fifty times PULL) about sixty. Seen at grazing angles the ground under the
 * road is kilometres behind it along the ray, and reversed float depth resolves millimetres there. So `pull` defaults to
 * 0; the option keeps the classic pull in node form (true, or a fraction) for that test and for a depth buffer that
 * cannot hold.
 *
 * Light (decision 6): the night glow is in cd/m2 times the pre-exposure in the shipped look (glow.node.js). Both
 * materials carry `userData.surfaceLight = 'road'`; the lights part adds its terms (src/drive/lights/surfaceLight.node.js)
 * to them through the session's eachSurface(), composing with the emissive node set here.
 */
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { attribute, cameraProjectionMatrix, positionView, select, float, vec4 } from 'three/tsl';
import { KIND } from './atlas.js';
import { atlasTexture, NIGHT_GLOW, nightWeight } from './textures.js';
import { PULL } from './material.js';
import { standInEmissive } from './glow.node.js';

/** A Lambert node material that can pull pavement toward the camera in depth (see the header). */
class RoadNodeMaterial extends MeshLambertNodeMaterial {
  constructor(params, pull = 0) {
    super(params);
    /** Fraction of its distance pavement moves toward the camera in depth (true: the classic PULL; negative pushes it away). */
    this.pull = pull;
  }

  get pullFraction() { return this.pull === true ? PULL : Number(this.pull) || 0; }

  /** The pull changes the program: builds are shared only between materials with the same one. */
  customProgramCacheKey() { return `${super.customProgramCacheKey()}|pull ${this.pullFraction}`; }

  setupModelViewProjection(builder) {
    const f = this.pullFraction;
    if (!f) return super.setupModelViewProjection(builder);
    const k = select(attribute('kind', 'float').lessThan(KIND.embankment - 0.5), float(1 - f), float(1));
    return cameraProjectionMatrix.mul(vec4(positionView.mul(k), 1));
  }
}

/**
 * @param {{ anisotropy?: number, pull?: boolean | number }} [opts]  pull: false (the default), true (material.js's PULL) or a fraction
 * @returns {{ road: MeshLambertNodeMaterial, roadNear: MeshLambertNodeMaterial, map: object|null, nightMap: object|null,
 *   setNight(on: boolean|number): void, setLook(look: { beams?: number, night?: boolean }): void, setHeadlights(on: boolean): void,
 *   dispose(): void }}  the same as material.js's
 */
export function createRoadMaterials({ anisotropy = 1, pull = 0 } = {}) {
  const map = atlasTexture(false, anisotropy);
  const nightMap = atlasTexture(true, anisotropy);
  const make = (name) => {
    const m = new RoadNodeMaterial({ map, color: map ? 0xffffff : 0x55534f, emissiveMap: nightMap, emissive: 0xffffff, emissiveIntensity: 0 }, pull);
    m.name = name;
    m.emissiveNode = standInEmissive(); // the night glow in cd/m2 x the pre-exposure in the shipped look (glow.node.js)
    m.userData.surfaceLight = 'road';
    return m;
  };
  const road = make('road'), roadNear = make('road-near');
  let headlights = false, lastNight = 0;
  const api = {
    road, roadNear, map, nightMap,
    setNight(on) {
      lastNight = on;
      const w = headlights ? 0 : nightWeight(on);
      road.emissiveIntensity = NIGHT_GLOW.far * w;
      roadNear.emissiveIntensity = NIGHT_GLOW.near * w;
    },
    setLook(look) { api.setNight(look.beams ?? look.night); },
    setHeadlights(on) { headlights = !!on; api.setNight(lastNight); },
    dispose() { road.dispose(); roadNear.dispose(); map?.dispose(); nightMap?.dispose(); },
  };
  return api;
}

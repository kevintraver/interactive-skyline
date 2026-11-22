// The wet road on the drive's materials (plan 02, D8.1): the `wet` surface term (wet.glsl.js) on the road's two
// materials and the ground's, through lights/surfaceLight.js. Nothing is added until the first time it is wet, so a
// visitor who never asks for rain runs exactly the shaders of before; once added the term stays (taking it out would
// recompile), and at wetness 0 it adds exactly nothing (the block is skipped on uWet.x).
//
// The term must run after every other term on a material (it scales their light): it is added last, and if another
// part adds a term later (a lamp pool, the headlamps, which load at their own pace) it is taken out and put back at
// the end on the next check.

import * as THREE from 'three';
import { addSurfaceTerm, removeSurfaceTerm, surfaceTerms } from '../lights/surfaceLight.js';
import { WET_HEAD, wetBody } from './wet.glsl.js';
import { WET_DIFFUSE, WET_RETRO, GLOSS, GROUND_DIFFUSE } from './wetMirror.js';
import { regionU, WEAR } from '../roadnet/atlas.js';

export const TERM_ID = 'wet';

/**
 * @param {{ road: THREE.Material[], ground: THREE.Material[] }} materials
 * @returns {{ uniforms: object, set(o: { wetness: number, sky: THREE.Color }): void, tick(): void, attached: number, dispose(): void }}
 */
export function createWetRoad({ road, ground }) {
  const shared = {
    uWetSky: { value: new THREE.Color(0, 0, 0) },
    uWetLanes: { value: new THREE.Vector4(regionU('lane', 0), regionU('lane', 1), regionU('laneR', 0), regionU('laneR', 1)) },
    uWetPath: { value: new THREE.Vector4(WEAR.paths[0], WEAR.paths[1], WEAR.pathSigma, 0) },
    uWetDirt: { value: new THREE.Vector2(regionU('dirt', 0), regionU('dirt', 1)) },
  };
  const uRoad = { value: new THREE.Vector4(0, WET_DIFFUSE, WET_RETRO, GLOSS.road) };
  const uGround = { value: new THREE.Vector4(0, GROUND_DIFFUSE, WET_RETRO, GLOSS.ground) };
  const terms = {
    road: { id: TERM_ID, key: 'road-v1', uniforms: { ...shared, uWet: uRoad }, head: WET_HEAD, body: wetBody('road') },
    ground: { id: TERM_ID, key: 'ground-v1', uniforms: { ...shared, uWet: uGround }, head: WET_HEAD, body: wetBody('ground') },
  };
  const targets = [...new Set(road.filter(Boolean))].map((m) => [m, 'road'])
    .concat([...new Set(ground.filter(Boolean))].filter((m) => !road.includes(m)).map((m) => [m, 'ground']));
  let added = false;

  function addAll() {
    for (const [m, kind] of targets) addSurfaceTerm(m, terms[kind]);
    added = true;
  }
  /** Put the term back at the end of any material where another term was added after it. */
  function keepLast() {
    for (const [m, kind] of targets) {
      const ids = surfaceTerms(m);
      if (ids.length && ids[ids.length - 1] !== TERM_ID) { removeSurfaceTerm(m, TERM_ID); addSurfaceTerm(m, terms[kind]); }
    }
  }

  return {
    uniforms: { ...shared, uWetRoad: uRoad, uWetGround: uGround },
    get attached() { return added ? targets.length : 0; },
    /** The wetness (0..1) and the sky's radiance near the horizon (scene units, linear). */
    set({ wetness, sky }) {
      const w = wetness > 0 ? Math.min(1, wetness) : 0;
      uRoad.value.x = w;
      uGround.value.x = w;
      if (sky) shared.uWetSky.value.copy(sky);
      if (w > 0 && !added) addAll();
    },
    /**
     * Put the term on every material now, at wetness 0 (where it adds exactly nothing), so the first rain does not
     * recompile the road's and the ground's programs on the frame it starts (about 100 ms on an M4); the drive does this
     * while it loads.
     */
    prepare() { if (!added) addAll(); },
    /**
     * Once a frame: the term is put back last where another term came after it. Checked every frame (a few array reads),
     * so the reordering (a recompile) happens on the update right after another part adds its term, while the drive
     * loads, not a second into the drive.
     */
    tick() { if (added) keepLast(); },
    /** Add a material later (one that loads after the part). */
    add(material, kind = 'ground') {
      if (!material || targets.some(([m]) => m === material)) return;
      targets.push([material, kind]);
      if (added) addSurfaceTerm(material, terms[kind]);
    },
    dispose() { if (added) for (const [m] of targets) removeSurfaceTerm(m, TERM_ID); added = false; },
  };
}

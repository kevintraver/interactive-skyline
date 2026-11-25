// The wet road on the drive's materials (plan 02, D8.1; third stretch, decision 6). The `wet` filter term (wet.js)
// goes on the road's materials (the pavement, decks and shoulders share them) and the ground's through
// src/drive/lights/surfaceLight.js.
//
// It is put on while the drive loads (prepare), at wetness 0, where it skips its block and adds nothing: the first
// rain then changes uniforms only and builds no program. It must run after every other term on a material (it filters
// their light): if another part adds a term later, tick() moves it back to the end. One term object per kind is
// shared by all the materials of that kind, so they share one program.
//
// Units. The mirrored sky is set in cd/m^2 (surfaceLight.js scales a term's radiance by the light scale: the
// pre-exposure x cityFactor); the caller converts.

import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { addSurfaceTerm, removeSurfaceTerm, surfaceTerms } from '../lights/surfaceLight.js';
import { wetTerm, TERM_ID } from './wet.js';
import { WET_DIFFUSE, WET_RETRO, GLOSS, GROUND_DIFFUSE } from './wetMirror.js';
import { regionU, WEAR } from '../roadnet/atlas.js';

export { TERM_ID };

/**
 * @param {{ road: object[], ground: object[], photometry?: object }} materials  node materials; photometry: the light
 *   scale's context (photometry.js), used where the wet term is a material's first
 * @returns {{ uniforms: object, set(o: { wetness?: number, sky?: { r: number, g: number, b: number } }): void, prepare(): void,
 *   tick(): void, add(material: object, kind?: 'road' | 'ground'): void, attached: number, dispose(): void }}
 */
export function createWetRoad({ road, ground, photometry }) {
  const shared = {
    uWetSky: uniform(new THREE.Color(0, 0, 0)).setName('uWetSky'),
    uWetLanes: uniform(new THREE.Vector4(regionU('lane', 0), regionU('lane', 1), regionU('laneR', 0), regionU('laneR', 1))).setName('uWetLanes'),
    uWetPath: uniform(new THREE.Vector4(WEAR.paths[0], WEAR.paths[1], WEAR.pathSigma, 0)).setName('uWetPath'),
    uWetDirt: uniform(new THREE.Vector2(regionU('dirt', 0), regionU('dirt', 1))).setName('uWetDirt'),
  };
  const uRoad = uniform(new THREE.Vector4(0, WET_DIFFUSE, WET_RETRO, GLOSS.road)).setName('uWetRoad');
  const uGround = uniform(new THREE.Vector4(0, GROUND_DIFFUSE, WET_RETRO, GLOSS.ground)).setName('uWetGround');
  const terms = { road: wetTerm('road', { ...shared, uWet: uRoad }), ground: wetTerm('ground', { ...shared, uWet: uGround }) };
  const targets = [...new Set(road.filter(Boolean))].map((m) => [m, 'road'])
    .concat([...new Set(ground.filter(Boolean))].filter((m) => !road.includes(m)).map((m) => [m, 'ground']));
  const opts = { photometry };
  let added = false;

  const put = (m, kind) => addSurfaceTerm(m, terms[kind], opts);
  function addAll() { for (const [m, kind] of targets) put(m, kind); added = true; }

  return {
    uniforms: { ...shared, uWetRoad: uRoad, uWetGround: uGround },
    get attached() { return added ? targets.length : 0; },
    /** The wetness (0..1) and the sky's luminance near the horizon (cd/m^2, linear RGB). */
    set({ wetness, sky } = {}) {
      if (wetness !== undefined) {
        const w = wetness > 0 ? Math.min(1, wetness) : 0;
        uRoad.value.x = w;
        uGround.value.x = w;
        if (w > 0 && !added) addAll();
      }
      if (sky) shared.uWetSky.value.setRGB(sky.r, sky.g, sky.b);
    },
    /** Put the term on every material now, at wetness 0 (the drive does this while it loads). */
    prepare() { if (!added) addAll(); },
    /** Once a frame: the term back at the end of any material where another term came after it (a recompile, at load). */
    tick() {
      if (!added) return;
      for (const [m, kind] of targets) {
        const ids = surfaceTerms(m);
        if (ids.length && ids[ids.length - 1] !== TERM_ID) { removeSurfaceTerm(m, TERM_ID); put(m, kind); }
      }
    },
    /** A material that arrives later (a terrain patch, a route's new surfaces). */
    add(material, kind = 'ground') {
      if (!material || targets.some(([m]) => m === material)) return;
      targets.push([material, kind]);
      if (added) put(material, kind);
    },
    dispose() { if (added) for (const [m] of targets) removeSurfaceTerm(m, TERM_ID); added = false; },
  };
}

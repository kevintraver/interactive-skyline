/**
 * The corridor's material: the app's own for its low buildings (lightAtNight over a vertex-coloured Lambert, as
 * src/city/buildings.js makes it), with one addition read from a vertex attribute the mesher writes per wall,
 * `winLit` (0..1, src/drive/corridor/mesher.js windowShare):
 *   - 0: the wall has no windows (a canopy's edge, a shed, a warehouse's blank wall, any wall under WINDOW_MIN_M);
 *   - otherwise the share of the app's lit windows that are lit on it (the app picks 5 to 40% block by block; a
 *     hotel keeps all of that, a warehouse a small part), which also dims the far-off average the same way.
 * The window grid itself (one bay 3.6 m across, one floor 3.4 m up, the pane inside it) is the app's, unchanged.
 *
 * src/night.js is not changed: its shader is extended here, after its own onBeforeCompile, by replacing two of its
 * lines. patchCorridorShader throws if they are not found, so a change there fails tests/unit/corridor/material.test.js
 * instead of silently dropping the rule.
 */
import * as THREE from 'three';
import { lightAtNight } from '../../night.js';

const PATCHES = {
  vertex: [
    ['#include <common>', '#include <common>\nattribute float winLit;\nvarying float vWinLit;'],
    ['vNightNormal = objectNormal;', 'vNightNormal = objectNormal;\nvWinLit = winLit;'],
  ],
  fragment: [
    ['#include <common>', '#include <common>\nvarying float vWinLit;'],
    ['if (windowed > 0.0 && facadeFacing() > 0.5) {', 'if (windowed > 0.0 && vWinLit > 0.0 && facadeFacing() > 0.5) {'],
    ['float busy = mix(0.05, 0.4, nightHash(floor(vNightPos.xz / 90.0)));',
      'float busy = mix(0.05, 0.4, nightHash(floor(vNightPos.xz / 90.0))) * vWinLit;'],
  ],
};

/** Extend lightAtNight's shader (already applied to `shader`) with the per-wall `winLit` rule. */
export function patchCorridorShader(shader) {
  for (const [key, list] of [['vertexShader', PATCHES.vertex], ['fragmentShader', PATCHES.fragment]]) {
    for (const [from, to] of list) {
      if (!shader[key].includes(from)) throw new Error(`corridor material: "${from}" is not in the night shader any more (src/night.js changed)`);
      shader[key] = shader[key].replace(from, to);
    }
  }
  return shader;
}

/** The corridor's buildings' material. */
export function corridorMaterial() {
  const mat = lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const night = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    night(shader, renderer);
    patchCorridorShader(shader);
  };
  mat.customProgramCacheKey = () => 'night-v5-corridor-1';
  mat.name = 'corridor';
  return mat;
}

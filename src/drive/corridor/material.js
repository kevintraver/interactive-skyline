/**
 * The corridor's material (plan 02, D7.6). The buildings are drawn with plan 01's building material (src/night.js
 * lightAtNight, a node material: vertex colours, the removable tint, the steady refresh), and its window term is replaced by the same term
 * read with the corridor's per-wall attribute `winLit` (0..1, src/drive/corridor/mesher.js windowShare):
 *   - 0: the wall has no windows (a canopy's edge, a shed, a warehouse's blank wall, any wall under WINDOW_MIN_M);
 *   - otherwise the share of the app's lit windows that are lit on it, which also dims the far-off average.
 * The window grid, the hash, the tints, the classic and the physical looks are plan 01's extruded variant
 * (src/render/materials/buildingMaterial.js), unchanged but for those two factors: plan 01's graph takes no per-vertex
 * share, so the terms are written out here with its helpers rather than patched into it.
 */
import * as THREE from 'three';
import {
  attribute, varying, positionGeometry, normalGeometry, materialEmissive, vec2, vec3, float, fract, floor, dot, normalize, step,
  smoothstep, mix, max, abs, fwidth,
} from 'three/tsl';
import { lightAtNight } from '../../night.js';
import { nightHash } from '../../render/materials/buildingMaterial.js';
import { night, exposure, physical, switchOn, cityFactor, legacyScale } from '../../render/materials/shared.js';
import { PHOTOMETRY } from '../../render/photometry.js';

/**
 * The window light of an extruded building with the corridor's `winLit`, as plan 01's buildingNodes() writes it for the
 * 'extruded' variant: the classic and physical terms blended by the shared `physical` uniform.
 * @returns {import('three/tsl').Node} vec3 emissive (added to the material's own)
 */
export function corridorWindowNode() {
  const pos = varying(positionGeometry, 'vNightPos');
  const nrm = varying(normalGeometry, 'vNightNormal');
  const winLit = varying(attribute('winLit', 'float'), 'vWinLit');
  const facing = float(1).sub(step(0.87, abs(nrm.y)));
  const wall = nrm.xz.add(vec2(1e-5, 0));
  const along = normalize(vec2(wall.y.negate(), wall.x));
  const cell = vec2(dot(pos.xz, along).div(3.6), pos.y.div(3.4));
  const detail = float(1).sub(smoothstep(0.35, 1.2, max(fwidth(cell.x), fwidth(cell.y))));
  const id = floor(cell).add(floor(along.mul(5)).mul(17));
  const f = fract(cell);
  // the corridor's rule: the share of lit windows is winLit of the app's, and a wall with none has no windows
  const busy = mix(0.05, 0.4, nightHash(floor(pos.xz.div(90)))).mul(winLit);
  const lit = step(float(1).sub(busy), nightHash(id));
  const pane = step(0.18, f.x).mul(step(f.x, 0.82)).mul(step(0.25, f.y)).mul(step(f.y, 0.8));
  const amount = mix(busy.mul(0.35), lit.mul(pane), detail);
  const tint = mix(vec3(1.0, 0.72, 0.38), vec3(0.7, 0.82, 1.0), step(0.8, nightHash(id.add(3.7))));
  const onFacade = step(1e-6, winLit).mul(step(0.5, facing));
  const classic = tint.mul(amount).mul(0.75).mul(onFacade).mul(night);
  const on = step(nightHash(id.add(11.3)), switchOn.windows);
  const tintLum = dot(tint, vec3(0.2126, 0.7152, 0.0722));
  const cd = nightHash(id.add(5.1)).add(0.5).mul(PHOTOMETRY.windowCdM2);
  const amountPhys = mix(busy.mul(0.35).mul(switchOn.windows).mul(PHOTOMETRY.windowCdM2), lit.mul(pane).mul(on).mul(cd), detail);
  const phys = tint.div(tintLum).mul(amountPhys).mul(onFacade).mul(exposure.mul(cityFactor));
  return mix(classic, phys, physical);
}

let shared = null;

/** The corridor's buildings' material (one node graph for every corridor material). */
export function corridorMaterial() {
  const mat = lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true }));
  // the material's own emissive (the removable tint) as plan 01's graph has it, plus the corridor's windows
  shared ||= materialEmissive.mul(mix(float(1), legacyScale, physical)).add(corridorWindowNode());
  mat.emissiveNode = shared;
  mat.name = 'corridor';
  mat.userData.surfaceLight = 'building';
  return mat;
}

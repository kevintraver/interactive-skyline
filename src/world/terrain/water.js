// Water inside a terrain patch: each body (a lake, the river) a flat sheet at its level, from the OSM outlines
// and levels scripts/build_terrain.py writes to water-<patch>.json. The elevation source has the water flat at
// about that level already, so the sheet sits just above the ground there and the shores, where the ground
// rises, hide whatever of an outline lies beyond the water of the day. Drive-only, like the patch.
// A body whose source surface is not at one level (the river below the dam, where two surveys meet) carries
// `levels`, [x, y, level] read in squares across it; its sheet blends between them (inverse distance squared).

import * as THREE from 'three';
import { curveDrop } from '../frame.js';
import { waterMaterial } from './material.js';

/** Metres the sheet floats above its level, over the flat ground the elevation source has there. */
export const LIFT = 1.0;
/** Longest triangle edge, m: fine enough for a blended level to follow its pieces; curvature sags under 1 cm. */
const MAX_EDGE = 250;

/**
 * The level of a body at (x, y): its one level, or the blend of its pieces' levels.
 * @param {{ level: number, levels?: number[][] }} body
 */
export function levelAt(body, x, y) {
  const ls = body.levels;
  if (!ls || !ls.length) return body.level;
  let sw = 0, s = 0;
  for (const [px, py, l] of ls) {
    const d2 = (px - x) ** 2 + (py - y) ** 2;
    if (d2 < 1) return l;
    const w = 1 / d2;
    sw += w; s += w * l;
  }
  return s / sw;
}

/**
 * Triangles of one body: its outline and holes triangulated, then split until no edge is longer than maxEdge.
 * @param {number[][][]} rings  [outer, ...holes], each [[x, y], ...] in map metres, not closed
 * @returns {number[]} flat [x, y, x, y, x, y, ...], three points a triangle
 */
export function waterTriangles(rings, maxEdge = MAX_EDGE) {
  const [outer, ...holes] = rings.map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
  const all = [outer, ...holes].flat();
  const tris = THREE.ShapeUtils.triangulateShape(outer, holes);
  const out = [];
  const split = (a, b, c, depth) => {
    const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a), m = Math.max(ab, bc, ca);
    if (m <= maxEdge || depth > 16) { out.push(a.x, a.y, b.x, b.y, c.x, c.y); return; }
    // split the longest edge at its middle
    if (m === ab) { const p = a.clone().lerp(b, 0.5); split(a, p, c, depth + 1); split(p, b, c, depth + 1); }
    else if (m === bc) { const p = b.clone().lerp(c, 0.5); split(a, b, p, depth + 1); split(a, p, c, depth + 1); }
    else { const p = c.clone().lerp(a, 0.5); split(a, b, p, depth + 1); split(p, b, c, depth + 1); }
  };
  for (const [i, j, k] of tris) split(all[i], all[j], all[k], 0);
  return out;
}

/**
 * The water of one patch as one mesh, or null when it has none.
 * @param {{ bodies: Array<{ level: number, rings: number[][][] }> }} doc  water-<patch>.json
 * @param {{ base: number, name?: string, legacy?: boolean }} opts  legacy false: a node material (plan 01's renderer)
 */
export function buildWaterMesh(doc, { base, name = 'water', legacy = true }) {
  const bodies = doc?.bodies || [];
  const pos = [];
  for (const b of bodies) {
    const t = waterTriangles(b.rings);
    for (let k = 0; k < t.length; k += 2) pos.push(t[k], levelAt(b, t[k], t[k + 1]) + LIFT, t[k + 1]);
  }
  if (!pos.length) return null;
  // vertices relative to the centre of what is drawn (float32 precision), curvature baked per vertex
  let cx = 0, cy = 0;
  for (let k = 0; k < pos.length; k += 3) { cx += pos[k]; cy += pos[k + 2]; }
  cx = Math.round(cx / (pos.length / 3)); cy = Math.round(cy / (pos.length / 3));
  const arr = new Float32Array(pos.length);
  for (let k = 0; k < pos.length; k += 3) {
    const x = pos[k], y = pos[k + 2];
    arr[k] = x - cx; arr[k + 1] = pos[k + 1] - base - curveDrop(x, y); arr[k + 2] = -(y - cy);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const nor = new Float32Array(arr.length);
  for (let k = 1; k < nor.length; k += 3) nor[k] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.computeBoundingSphere();
  // plain, slightly glossy blue-green: lit by the look's lights, so it follows the day and goes dark at night
  const material = waterMaterial({
    color: 0x24545a, specular: 0x3a4a4c, shininess: 40, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }, { legacy });
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(cx, 0, -cy);
  mesh.name = name;
  return mesh;
}

// skyline-integration: v7 (blender-landmark-model skill)
import * as THREE from 'three';
import { active } from './render/active.js';
import { createFountainMaterial } from './render/materials/fountainMaterial.js';

// A fountain show on a lake, from a data file the skill writes (public/models/<city>/attractions/*.json): the lake
// outline and every nozzle in meters east and north of the city origin, each as
//   [east, north, type, figure, u, tangent_e, tangent_n, normal_e, normal_n, seed]
// type 0 oarsman, 1 mini-shooter, 2 super-shooter, 3 extreme-shooter; figure 0 is the front line, 1.. rings;
// u is the place along that figure (0..1). All jets are one InstancedMesh (one draw call): each is a soft
// camera-facing ribbon plus a mist puff at its foot, animated in the vertex shader from the shared clock
// through a looping choreography. White and translucent by day, brightly lit from below at night.
// v7 (plan 01, phase 2): the shader is a TSL node material (src/render/materials/fountainMaterial.js) for
// WebGPURenderer; v6's GLSL moved unchanged to src/render/legacy/materials.js for ?renderer=legacy.

const SEGMENTS = 14; // rows along a jet, so a leaning jet can arc
const MAX_JETS = 5000;

/** One ribbon (side -1|1, v 0..1, part 0) and one mist quad (corners -1|1, part 1), shared by every jet. */
function jetGeometry(jets, waterY) {
  const geo = new THREE.BufferGeometry();
  const pos = [], index = [];
  for (let i = 0; i <= SEGMENTS; i++) pos.push(-1, i / SEGMENTS, 0, 1, i / SEGMENTS, 0);
  for (let i = 0; i < SEGMENTS; i++) { const a = 2 * i; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const m = pos.length / 3;
  pos.push(-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1);
  index.push(m, m + 1, m + 2, m, m + 2, m + 3);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  const at = new Float32Array(jets.length * 3), kind = new Float32Array(jets.length * 4), axis = new Float32Array(jets.length * 4);
  const counts = new Map(); // alternate jets of a type along a figure lean and fire in turn
  jets.forEach(([east, north, type, figure, u, te, tn, ne, nn, seed], i) => {
    const key = `${figure}:${type}`, k = counts.get(key) || 0;
    counts.set(key, k + 1);
    at.set([east, waterY, -north], i * 3);
    kind.set([type, figure, u, (k % 2) + THREE.MathUtils.clamp(seed, 0, 0.99)], i * 4);
    axis.set([te, -tn, ne, -nn], i * 4); // map east/north to world x/z
  });
  geo.setAttribute('jetAt', new THREE.InstancedBufferAttribute(at, 3));
  geo.setAttribute('jetKind', new THREE.InstancedBufferAttribute(kind, 4));
  geo.setAttribute('jetAxis', new THREE.InstancedBufferAttribute(axis, 4));
  return geo;
}

const isJet = (j) => Array.isArray(j) && j.length >= 10 && j.slice(0, 10).every(Number.isFinite)
  && j[2] >= 0 && j[2] <= 3;

/**
 * Build the show from its data file's contents. `groundY(east, north)` is the app's terrain height; the jets
 * start at the median height under the nozzles (the lake is flat).
 * @param {{name?: string, jets: number[][], center?: number[], radius?: number}} data
 * @param {(east: number, north: number) => number} groundY
 * @returns {THREE.InstancedMesh}
 */
export function createFountain(data, groundY) {
  const jets = (Array.isArray(data?.jets) ? data.jets : []).filter(isJet).slice(0, MAX_JETS);
  if (!jets.length) throw new Error('the fountain file lists no valid jets');
  const heights = jets.filter((_, i) => i % 7 === 0).map((j) => groundY(j[0], j[1])).sort((a, b) => a - b);
  const waterY = heights[Math.floor(heights.length / 2)] + 0.2;
  const xs = jets.map((j) => j[0]), ys = jets.map((j) => j[1]);
  const box = new THREE.Box3(
    new THREE.Vector3(Math.min(...xs) - 40, waterY, -Math.max(...ys) - 40),
    new THREE.Vector3(Math.max(...xs) + 40, waterY + 150, -Math.min(...ys) + 40),
  );
  const legacy = active.legacy && active.legacy.fountainMaterial();
  const material = legacy ? legacy.material : createFountainMaterial();
  const mesh = new THREE.InstancedMesh(jetGeometry(jets, waterY), material, jets.length);
  mesh.name = data.name || 'Fountain';
  mesh.boundingBox = box;
  mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  mesh.raycast = () => {}; // water is not clickable, and its shape lives in the shader
  // meters per pixel at 1 m from the camera, for the minimum jet width (the node material derives it itself)
  if (legacy) mesh.onBeforeRender = legacy.onBeforeRender;
  mesh.userData.fountain = { name: mesh.name, jets: jets.length, waterY, center: box.getCenter(new THREE.Vector3()) };
  return mesh;
}

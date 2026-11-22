/**
 * Delineators (plan 02, D3.7; MUTCD 3F): small posts with a retroreflective face at the edge of
 * the shoulder, at the chainages barriers.json lists (white on the right, yellow on the left).
 * Instanced: one InstancedMesh for the posts and one per reflector colour, rebuilt around the car
 * every REBUILD metres, relative to a local origin near it (float32 is too coarse 60 km out).
 *
 * The reflector meshes carry an instance attribute `retro` (sheeting code, sheeting.js) and
 * materials named 'delineator white' and 'delineator yellow'. At night they glow a little, as
 * the road's markings do, standing in for headlights until those exist.
 */
import * as THREE from 'three';
import { createRefline } from '../roadnet/refline.js';
import { edgesAt } from '../roadnet/crosssection.js';
import { localUp } from '../../world/frame.js';
import { asDecoded } from './barrierFormat.js';
import { standY } from './geometry.js';
import { sheetingCode } from './sheeting.js';
import { nightWeight } from './batch.js';

export const SHOW = 1200; // m: delineators within this distance are drawn
export const REBUILD = 150; // m the car moves before the set is rebuilt
export const POST = { w: 0.08, d: 0.03, y0: -0.6, y1: 1.25 };
export const FACE = { w: 0.075, y0: 0.95, y1: 1.15 }; // reflector at about 4 ft
const NIGHT_GLOW = 0.55;

/**
 * Every delineator as { x, y (map), pos (scene, doubles), right, up, face (unit vectors), colour }. Each stands on
 * the embankment the mesher draws at its offset or, where that does not reach or the ground is higher, on the
 * drawn ground (geometry.js standY).
 * @param {object} barriers barriers.json, raw or decoded  @param {{ roads: object[] }} roadnet decoded
 * @param {number} base  @param {number} earthR  @param {(x: number, y: number) => number} [ground] terrain.surfaceAt
 */
export function placeDelineators(barriers, roadnet, base, earthR, ground = null) {
  const roads = new Map(roadnet.roads.map((r) => [r.id, r]));
  const out = [];
  for (const br of asDecoded(barriers).roads) {
    const road = roads.get(br.id);
    if (!road || !br.delineators.length) continue;
    const ref = createRefline(road);
    const stand = { raw: road, ground };
    const p = {};
    for (const dl of br.delineators) {
      const left = dl.side === 'left', sgn = left ? 1 : -1;
      for (const s of dl.s) {
        ref.at(s, p);
        const e = edgesAt(road, s);
        const edge = left ? e.left : e.right;
        const d = edge + sgn * dl.o;
        const sn = Math.sin(p.heading), c = Math.cos(p.heading);
        const mx = p.x - d * sn, my = p.y + d * c;
        const hEdge = p.h + p.crossfall * edge;
        const h = hEdge + standY(stand, s, p, e, dl.side, dl.o, mx, my, hEdge);
        const pos = [mx, h - base - (mx * mx + my * my) / (2 * earthR), -my];
        const u = localUp(pos[0], pos[2], new THREE.Vector3());
        const up = [u.x, u.y, u.z];
        const travel = [c, 0, -sn];
        const k = travel[0] * up[0] + travel[1] * up[1] + travel[2] * up[2];
        const face = new THREE.Vector3(-travel[0] + up[0] * k, -travel[1] + up[1] * k, -travel[2] + up[2] * k).normalize();
        const right = new THREE.Vector3().crossVectors(u, face).normalize();
        out.push({ x: mx, y: my, pos, right: [right.x, right.y, right.z], up, face: [face.x, face.y, face.z], colour: dl.colour });
      }
    }
  }
  return out;
}

function postGeometry() {
  const g = new THREE.BoxGeometry(POST.w, POST.y1 - POST.y0, POST.d);
  g.translate(0, (POST.y0 + POST.y1) / 2, -POST.d / 2);
  return g;
}

function faceGeometry() {
  const g = new THREE.PlaneGeometry(FACE.w, FACE.y1 - FACE.y0);
  g.translate(0, (FACE.y0 + FACE.y1) / 2, 0.006); // just in front of the post, facing the driver (+z)
  return g;
}

/**
 * @param {{ barriers: object, roadnet: object, base: number, earthR: number, parent: THREE.Object3D,
 *           ground?: (x: number, y: number) => number }} opts
 */
export function createDelineators({ barriers, roadnet, base, earthR, parent, ground = null }) {
  const all = placeDelineators(barriers, roadnet, base, earthR, ground);
  const counts = { white: 0, yellow: 0 };
  for (const d of all) counts[d.colour]++;
  const group = new THREE.Group();
  group.name = 'delineators';
  parent.add(group);
  const postMat = new THREE.MeshLambertMaterial({ color: 0xd9dbd6 });
  postMat.name = 'delineator posts';
  const faceMats = {
    white: new THREE.MeshLambertMaterial({ color: 0xf4f4ef, emissive: 0xffffff, emissiveIntensity: 0 }),
    yellow: new THREE.MeshLambertMaterial({ color: 0xf2c230, emissive: 0xffc840, emissiveIntensity: 0 }),
  };
  faceMats.white.name = 'delineator white';
  faceMats.yellow.name = 'delineator yellow';
  const cap = Math.max(1, all.length);
  const posts = new THREE.InstancedMesh(postGeometry(), postMat, cap);
  const faces = {};
  for (const colour of ['white', 'yellow']) {
    const n = Math.max(1, counts[colour]);
    const m = new THREE.InstancedMesh(faceGeometry(), faceMats[colour], n);
    m.geometry.setAttribute('retro', new THREE.InstancedBufferAttribute(new Uint8Array(n).fill(sheetingCode(colour)), 1));
    faces[colour] = m;
  }
  for (const m of [posts, faces.white, faces.yellow]) {
    m.count = 0;
    m.frustumCulled = false; // the set spans 2.4 km around the car
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  let last = null, shown = 0;
  const mat = new THREE.Matrix4(), bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3();

  function rebuild(car) {
    const origin = [Math.round(car.x), 0, Math.round(-car.y)];
    const near = all.filter((d) => Math.hypot(d.x - car.x, d.y - car.y) < SHOW);
    const idx = { white: 0, yellow: 0 };
    near.forEach((d, i) => {
      bx.fromArray(d.right); by.fromArray(d.up); bz.fromArray(d.face);
      mat.makeBasis(bx, by, bz).setPosition(d.pos[0] - origin[0], d.pos[1] - origin[1], d.pos[2] - origin[2]);
      posts.setMatrixAt(i, mat);
      faces[d.colour].setMatrixAt(idx[d.colour]++, mat);
    });
    posts.count = near.length;
    faces.white.count = idx.white;
    faces.yellow.count = idx.yellow;
    for (const m of [posts, faces.white, faces.yellow]) {
      m.instanceMatrix.needsUpdate = true;
      m.position.set(...origin);
      m.updateMatrix();
      m.visible = m.count > 0;
    }
    shown = near.length;
    last = { x: car.x, y: car.y };
  }

  return {
    update(car) {
      if (!all.length) return;
      if (!last || Math.hypot(car.x - last.x, car.y - last.y) > REBUILD) rebuild(car);
    },
    /** true/false or how far the night glow is on (0..1, the look's `lights`). */
    setNight(on) { const w = nightWeight(on); for (const m of Object.values(faceMats)) m.emissiveIntensity = NIGHT_GLOW * w; },
    stats() {
      const vis = [posts, faces.white, faces.yellow].filter((m) => m.visible && m.count);
      return { delineators: all.length, shown, drawCalls: vis.length,
        triangles: vis.reduce((a, m) => a + (m.geometry.index ? m.geometry.index.count / 3 : 2) * m.count, 0) };
    },
    dispose() {
      parent.remove(group);
      for (const m of [posts, faces.white, faces.yellow]) { m.geometry.dispose(); m.dispose?.(); }
      postMat.dispose();
      Object.values(faceMats).forEach((m) => m.dispose());
    },
  };
}

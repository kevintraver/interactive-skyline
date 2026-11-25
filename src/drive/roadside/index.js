/**
 * The roadside signs of plan 02 task D3.7, by day: guide signs, speed limits, route confirmation
 * and mile markers from signs.json (scripts/build_roadside.py), drawn into a canvas atlas and
 * batched so the whole set costs a handful of draw calls. Overhead guide signs hang from truss
 * structures (structures.js) merged into the supports mesh; delineators from barriers.json
 * (delineators.js) are three instanced meshes. Every face carries its sheeting as the vertex
 * attributes `retro` and `retroLegend` (sheeting.js).
 *
 * Signs within SHOW (2 km) of the car are built, nearest first, and packed into one mesh per atlas
 * page for the faces and one for the supports, relative to a local origin near the car (float32
 * is too coarse 60 km out). Lambert node materials, so the app's lights and fog apply; at night the headlights part
 * adds the retroreflected return of the visitor's lamps (src/drive/lights/headlights.js).
 */
import * as THREE from 'three';
import { createRefline } from '../roadnet/refline.js';
import { edgesAt } from '../roadnet/crosssection.js';
import { facesOf } from './faces.js';
import { packAtlas, drawAtlas } from './atlas.js';
import { buildSign, signFrame } from './geometry.js';
import { selectVisible, packSigns } from './batch.js';
import { buildStructure } from './structures.js';
import { createDelineators } from './delineators.js';
import { lambert } from './lambert.js';

const BUILD_BUDGET = 48; // signs built per step; the rest follow on the next tick
const REBASE = 1000; // m: move the local origin when the car is this far from it

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return null;
}

/**
 * @param {{ signs: object, roadnet: object, base: number, earthR: number, parent: THREE.Object3D, anisotropy?: number, barriers?: object|null }} opts
 *   signs: signs.json; roadnet: the decoded RoadNet; base and earthR: as for the road chunks;
 *   barriers: barriers.json (for its delineators), optional; ground: metres above sea level of the ground as drawn
 *   (terrain.surfaceAt), for what posts and delineators stand on where the embankment does not reach (optional)
 * @returns {{ update(car: { x: number, y: number }): void, surfaces(): Array<[object, string]>,
 *   whenSettled(): Promise<void>, stats(): object, dispose(): void }}
 */
export function createRoadside({ signs, roadnet, base, earthR, parent, anisotropy = 1, barriers = null, ground = null }) {
  const roadsById = new Map(roadnet.roads.map((r) => [r.id, r]));
  const all = []; // { rec, tab, faces, road, map, built }
  const faceByKey = new Map();
  for (const r of signs.roads || []) {
    const road = roadsById.get(r.id);
    if (!road) continue;
    const ref = createRefline(road);
    const ctx = { at: (s) => ref.at(s), edges: (s) => edgesAt(road, s), base, earthR, raw: road, ground };
    for (const rec of r.signs) {
      const fs = facesOf(rec, r.exits);
      for (const f of fs) faceByKey.set(f.key, f.face);
      const tab = fs.find((f) => f.plate === 'tab')?.face || null;
      all.push({ rec, tab, faces: fs, road: ctx, map: signFrame(rec, ctx).map, built: null });
    }
    // overhead structures are items of their own: no faces, only supports
    for (const st of r.structures || []) {
      const first = r.signs[st.signs[0]];
      all.push({ structure: st, recs: r.signs, faces: [], road: ctx, map: signFrame({ ...first, s: st.s }, ctx).map, built: null });
    }
  }

  const atlas = packAtlas([...faceByKey].map(([key, face]) => ({ key, face })));
  const canvases = drawAtlas(atlas, faceByKey, makeCanvas);
  const textures = canvases.map((c) => {
    if (!c) return null;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // v = 0 at the top of the canvas
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = anisotropy;
    return t;
  });
  // one material per atlas page
  const faceMats = textures.map((map, p) => {
    const m = lambert({ map, color: map ? 0xffffff : 0x2f7a55 }, 'sign');
    m.name = `signs p${p}`;
    return m;
  });
  const supportMat = lambert({ vertexColors: true }, 'support');
  supportMat.name = 'sign supports';

  const group = new THREE.Group();
  group.name = 'roadside';
  parent.add(group);
  const faceMeshes = faceMats.map((mat) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    m.matrixAutoUpdate = false;
    m.frustumCulled = false; // the batch spans 4 km around the car; one sphere test would rarely cull it
    m.visible = false; // nothing to draw until the first assemble (an empty geometry is an error on WebGPU)
    group.add(m);
    return m;
  });
  const supportMesh = new THREE.Mesh(new THREE.BufferGeometry(), supportMat);
  supportMesh.matrixAutoUpdate = false;
  supportMesh.frustumCulled = false;
  supportMesh.visible = false;
  group.add(supportMesh);

  const uvOf = (s) => (plate) => {
    const f = s.faces.find((x) => x.plate === plate);
    const r = atlas.rects.get(f.key), pg = atlas.pages[r.page];
    return { page: r.page, u0: r.x / pg.w, v0: r.y / pg.h, u1: (r.x + r.w) / pg.w, v1: (r.y + r.h) / pg.h };
  };

  const delineators = barriers ? createDelineators({ barriers, roadnet, base, earthR, parent: group, ground }) : null;
  let disposed = false, car = null, origin = null;
  let shown = new Set(), wanted = [], dirty = false, timer = null;
  let waiters = [];

  // the sheeting codes as float32: the WebGL2 backend cannot read a byte attribute as the uint it declares, and WebGPU
  // has no one-byte vertex format (the lights part reads them, src/drive/lights/headlamps.js)
  const f32 = (a) => Float32Array.from(a);
  function setAttrs(geom, attrs, index) {
    for (const [name, arr, size] of attrs) geom.setAttribute(name, new THREE.BufferAttribute(arr, size));
    geom.setIndex(new THREE.BufferAttribute(index, 1));
  }

  function assemble() {
    const items = wanted.filter((w) => all[w.index].built).map((w) => ({ index: w.index, built: all[w.index].built }));
    if (!origin) origin = items.length ? items[0].built.frame.base.map(Math.round) : [0, 0, 0];
    const packed = packSigns(items, origin, atlas.pages.length);
    packed.faces.forEach((pf, p) => {
      const old = faceMeshes[p].geometry;
      const g = new THREE.BufferGeometry();
      setAttrs(g, [['position', pf.position, 3], ['normal', pf.normal, 3], ['uv', pf.uv, 2], ['retro', f32(pf.retro), 1], ['retroLegend', f32(pf.retroLegend), 1]], pf.index);
      faceMeshes[p].geometry = g;
      faceMeshes[p].visible = pf.index.length > 0;
      old.dispose();
    });
    const old = supportMesh.geometry;
    const g = new THREE.BufferGeometry();
    setAttrs(g, [['position', packed.support.position, 3], ['normal', packed.support.normal, 3], ['color', packed.support.color, 3]], packed.support.index);
    supportMesh.geometry = g;
    supportMesh.visible = packed.support.index.length > 0;
    old.dispose();
    for (const m of [...faceMeshes, supportMesh]) { m.position.set(...origin); m.updateMatrix(); }
    shown = new Set(items.map((it) => it.index));
    dirty = false;
  }

  /** Build up to BUILD_BUDGET missing signs, nearest first; reassemble; continue later if any remain. */
  function step() {
    timer = null;
    if (disposed) return;
    let n = 0;
    for (const w of wanted) {
      const s = all[w.index];
      if (s.built) continue;
      if (n++ >= BUILD_BUDGET) break;
      if (s.structure) {
        const b = buildStructure(s.structure, s.recs, s.road);
        s.built = { faces: [], support: b.support, frame: b.frame };
      } else s.built = buildSign(s.rec, s.tab, s.road, uvOf(s));
      dirty = true;
    }
    if (dirty) assemble();
    if (wanted.some((w) => !all[w.index].built)) timer = setTimeout(step, 0);
    else settle();
  }

  const isSettled = () => !timer && !dirty && wanted.every((w) => all[w.index].built && shown.has(w.index));

  function settle() {
    if (!waiters.length || !isSettled()) return;
    const w = waiters; waiters = [];
    w.forEach((resolve) => resolve());
  }

  function update(pos) {
    if (disposed) return;
    car = { x: pos.x, y: pos.y };
    delineators?.update(car);
    wanted = selectVisible(all, car, shown);
    const set = new Set(wanted.map((w) => w.index));
    if (set.size !== shown.size || wanted.some((w) => !shown.has(w.index))) dirty = true;
    if (origin && Math.hypot(origin[0] - car.x, origin[2] + car.y) > REBASE) { origin = null; dirty = true; }
    if (!timer) step();
  }

  const api = {
    update,
    /** The materials the lights part adds surface light to: [material, kind] pairs. */
    surfaces: () => [...faceMats.map((m) => [m, 'sign']), [supportMat, 'support'], ...(delineators?.surfaces() ?? [])],
    /** Resolves when every sign wanted for the last update is built and on screen. */
    whenSettled: () => (isSettled() ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    stats() {
      const out = { signs: all.filter((s) => s.rec).length, structures: all.filter((s) => s.structure).length, shown: shown.size,
        built: all.filter((s) => s.built).length, pages: atlas.pages.length, ppm: atlas.ppm, faces: faceByKey.size, drawCalls: 0, triangles: 0 };
      for (const m of [...faceMeshes, supportMesh]) {
        if (!m.visible || !m.geometry.index) continue;
        const gs = m.geometry.groups.length ? m.geometry.groups : [{ count: m.geometry.index.count }];
        out.drawCalls += gs.length;
        out.triangles += m.geometry.index.count / 3;
      }
      if (delineators) {
        const d = delineators.stats();
        out.delineators = d.shown;
        out.drawCalls += d.drawCalls;
        out.triangles += d.triangles;
      }
      return out;
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      delineators?.dispose();
      parent.remove(group);
      for (const m of [...faceMeshes, supportMesh]) m.geometry.dispose();
      faceMats.forEach((m) => m.dispose());
      supportMat.dispose();
      textures.forEach((t) => t?.dispose());
      waiters = [];
    },
  };
  return api;
}

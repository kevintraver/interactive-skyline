/**
 * Keeps the road network on screen around the car.
 *
 * Every road is always present at level 2 (a row every 64 m) as batches of 64 chunks (16 km), one
 * mesh and one draw call each. Within `mid` (2 km) of the car a 256 m chunk is drawn at level 1,
 * within `near` (400 m) at level 0; the batch skips that chunk's index range (its geometry groups
 * cover only the chunks not drawn finer), which costs one more draw call per hole. A finer chunk
 * replaces the coarser one only once it has arrived, and a chunk going coarser keeps its mesh
 * until the replacement is in, so the road never has a gap.
 *
 * For a 70 km road: 5 batches, plus about 16 level-1 and 4 level-0 chunks around the car, plus one
 * extra group for the batch with the hole: about 26 draw calls.
 *
 * Barriers (barriers.json, `barriers`) are swept into the same chunks by the worker, so they cost
 * no draw call of their own; their level of detail follows the chunk's (src/drive/roadside/sweep.js).
 *
 * The small roads of the interchanges (ramps and crossing roads, role !== 'main') are not chunked
 * road by road, which would cost a draw call per road: they are cut into pieces of at most 256 m,
 * and the pieces are gathered by where they lie, on a CLUSTER-metre grid, into one chunk per
 * cell. Those chunks work as the main road's do, in batches of their own.
 */
import * as THREE from 'three';
import { CHUNK_STATIONS } from './mesher.js';
import { createRefline } from './refline.js';
import { asDecoded } from '../roadside/barrierFormat.js';

const BATCH_CHUNKS = 64;
const CLUSTER = 768; // m: grid cell that gathers the pieces of the small roads into one chunk
const CLUSTER_BATCH = 32; // cluster chunks per batch (one draw call each at level 2)
const HYSTERESIS = 1.1; // a chunk drawn finer stays finer until 10% past the threshold
const NEAR_LIT = 150; // m: chunks this close get the material that glows more at night

const defaultWorker = () => new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });

/** A three mesh from a meshChunk result. */
function toMesh(m, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setAttribute('kind', new THREE.BufferAttribute(m.kind, 1));
  // sheeting code (src/drive/roadside/sheeting.js); float32 on plan 01's renderer, whose WebGL2 backend cannot read a byte
  // attribute as the uint it declares (and WebGPU has no one-byte vertex format)
  if (m.retro) g.setAttribute('retro', new THREE.BufferAttribute((Array.isArray(material) ? material[0] : material)?.isNodeMaterial ? Float32Array.from(m.retro) : m.retro, 1));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  const [cx, cy, cz, r] = m.sphere;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
  const mesh = new THREE.Mesh(g, material);
  mesh.position.set(m.origin[0], m.origin[1], m.origin[2]); // doubles; the GPU only sees the local part
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.name = m.s1 > m.s0 ? `road L${m.lod} ${m.s0}-${m.s1}` : `interchange L${m.lod}`;
  return mesh;
}

/**
 * @param {{ roadnet: { roads: object[] }, base: number, earthR: number, parent: THREE.Object3D,
 *   materials: { road: THREE.Material, roadNear?: THREE.Material, setNight?: (on: boolean) => void },
 *   barriers?: object|null,
 *   createWorker?: () => { postMessage: Function, onmessage: Function|null, terminate?: Function },
 *   near?: number, mid?: number, maxInFlight?: number }} opts
 */
export function createRoadChunks({ roadnet, base, earthR, parent, materials, barriers = null, createWorker = defaultWorker, near = 400, mid = 2000, maxInFlight = 4 }) {
  const worker = createWorker();
  const nearMat = materials.roadNear || materials.road;
  const chunks = []; // { road, index, s0, s1, cx, cy, radius, want, have, pending, dist, batch }
  const batches = []; // { road, s0, s1, first, count, mesh, ranges, pending }
  const requests = new Map(); // id -> { target, lod }
  let nextId = 1, inFlight = 0, disposed = false;
  let waiters = [];
  const p = {};

  const cells = new Map(); // grid cell -> cluster chunk
  roadnet.roads.forEach((road, ri) => {
    const ref = createRefline(road);
    if ((road.role ?? 'main') !== 'main') {
      const step = CHUNK_STATIONS * road.spacing;
      const halfW = Math.max(...road.sections.map((s) => Math.max(s.left.shoulder, s.right.shoulder) + s.lanes.reduce((a, l) => a + l.w, 0))) + 50;
      for (let a = 0; a < ref.length - 1e-6; a += step) {
        const b = Math.min(ref.length, a + step);
        ref.at((a + b) / 2, p);
        const key = `${Math.floor(p.x / CLUSTER)},${Math.floor(p.y / CLUSTER)}`;
        let c = cells.get(key);
        if (!c) {
          c = { road: -1, cluster: key, parts: [], index: cells.size, s0: 0, s1: 0, cx: 0, cy: 0, radius: 0, want: 2, have: null, pending: null, dist: Infinity, batch: null, mids: [] };
          cells.set(key, c);
        }
        c.parts.push({ road: ri, s0: a, s1: b });
        c.mids.push([p.x, p.y, (b - a) / 2 + halfW]);
      }
      return;
    }
    const step = CHUNK_STATIONS * road.spacing;
    const n = Math.ceil(ref.length / step - 1e-9);
    const halfWidth = Math.max(...road.sections.map((s) => Math.max(s.left.shoulder, s.right.shoulder) + s.lanes.reduce((a, l) => a + l.w, 0))) + 50;
    const first = chunks.length;
    for (let c = 0; c < n; c++) {
      const s0 = c * step, s1 = Math.min(ref.length, (c + 1) * step);
      ref.at((s0 + s1) / 2, p);
      chunks.push({ road: ri, index: c, s0, s1, cx: p.x, cy: p.y, radius: (s1 - s0) / 2 + halfWidth, want: 2, have: null, pending: null, dist: Infinity, batch: null });
    }
    for (let b = 0; b * BATCH_CHUNKS < n; b++) {
      const lo = first + b * BATCH_CHUNKS, count = Math.min(BATCH_CHUNKS, n - b * BATCH_CHUNKS);
      const batch = { isBatch: true, road: ri, s0: chunks[lo].s0, s1: chunks[lo + count - 1].s1, first: lo, count, mesh: null, ranges: null, pending: null, step };
      for (let k = 0; k < count; k++) chunks[lo + k].batch = batch;
      batches.push(batch);
    }
  });

  // cluster chunks: centre and reach from their pieces, then batches of them
  const clusters = [...cells.values()].sort((a, b) => (a.cluster < b.cluster ? -1 : 1));
  for (const c of clusters) {
    c.cx = c.mids.reduce((a, m) => a + m[0], 0) / c.mids.length;
    c.cy = c.mids.reduce((a, m) => a + m[1], 0) / c.mids.length;
    c.radius = Math.max(...c.mids.map((m) => Math.hypot(m[0] - c.cx, m[1] - c.cy) + m[2]));
    delete c.mids;
  }
  for (let b = 0; b * CLUSTER_BATCH < clusters.length; b++) {
    const lo = chunks.length;
    const group = clusters.slice(b * CLUSTER_BATCH, (b + 1) * CLUSTER_BATCH);
    chunks.push(...group);
    const batch = { isBatch: true, road: -1, s0: 0, s1: 0, first: lo, count: group.length, mesh: null, ranges: null, pending: null, clusters: group };
    for (const c of group) c.batch = batch;
    batches.push(batch);
  }

  worker.onmessage = (e) => receive(e.data);
  // barriers (barriers.json, decoded or raw) ride along with their roads into the worker, which sweeps them into the chunks
  const runsById = new Map((barriers ? asDecoded(barriers).roads : []).map((r) => [r.id, r.runs]));
  const workerRoads = runsById.size ? roadnet.roads.map((r) => (runsById.get(r.id)?.length ? { ...r, barriers: runsById.get(r.id) } : r)) : roadnet.roads;
  worker.postMessage({ type: 'init', roads: workerRoads, base, earthR });

  function send(target, msg) {
    const id = nextId++;
    target.pending = { id, lod: msg.lod };
    requests.set(id, target);
    inFlight++;
    worker.postMessage({ type: 'mesh', id, ...msg });
  }

  /** Show only the batch ranges whose chunks are not drawn finer. */
  function regroup(batch) {
    if (!batch.mesh) return;
    const g = batch.mesh.geometry;
    g.clearGroups();
    let start = -1, end = 0;
    for (let k = 0; k <= batch.count; k++) {
      const show = k < batch.count && !chunks[batch.first + k].have;
      const r = batch.ranges[k];
      if (show && start < 0) start = r.start;
      if (show) end = r.start + r.count;
      if (!show && start >= 0) { g.addGroup(start, end - start, 0); start = -1; }
    }
    batch.mesh.visible = g.groups.length > 0;
  }

  function receive({ id, mesh: m, error }) {
    const target = requests.get(id);
    requests.delete(id);
    inFlight--;
    if (disposed || !target) return;
    if (target.pending?.id === id) target.pending = null;
    if (error) { console.warn('road mesher:', error); dispatch(); settle(); return; }
    if (target.isBatch) {
      target.mesh = toMesh(m, [materials.road]);
      target.ranges = m.ranges;
      parent.add(target.mesh);
      // chunks that went coarse while the batch was missing can go now
      for (let k = 0; k < target.count; k++) {
        const c = chunks[target.first + k];
        if (c.want === 2 && c.have) { drop(c.have.mesh); c.have = null; }
      }
      regroup(target);
    } else if (target.want === m.lod) {
      if (target.have) drop(target.have.mesh);
      const mesh = toMesh(m, target.dist < NEAR_LIT ? nearMat : materials.road);
      target.have = { lod: m.lod, mesh };
      parent.add(mesh);
      regroup(target.batch);
    }
    dispatch();
    settle();
  }

  function drop(mesh) { parent.remove(mesh); mesh.geometry.dispose(); }

  /** Send the nearest outstanding requests, batches first, up to maxInFlight. */
  function dispatch() {
    for (const b of batches) {
      if (b.mesh || b.pending || inFlight >= maxInFlight) continue;
      if (b.clusters) send(b, { parts: b.clusters.flatMap((c, g) => c.parts.map((pt) => ({ ...pt, group: g }))), groups: b.count, lod: 2 });
      else send(b, { road: b.road, s0: b.s0, s1: b.s1, lod: 2, split: b.step });
    }
    if (inFlight >= maxInFlight) return;
    const todo = chunks.filter((c) => c.want < 2 && c.have?.lod !== c.want && c.pending?.lod !== c.want).sort((a, b) => a.dist - b.dist);
    for (const c of todo) {
      if (inFlight >= maxInFlight) break;
      if (c.have?.lod === c.want || c.pending?.lod === c.want) continue; // a synchronous reply got there first
      if (c.cluster) send(c, { parts: c.parts.map((pt) => ({ ...pt, group: 0 })), groups: 1, lod: c.want });
      else send(c, { road: c.road, s0: c.s0, s1: c.s1, lod: c.want });
    }
  }

  const isSettled = () => batches.every((b) => b.mesh) && chunks.every((c) => (c.want === 2 ? !c.have : c.have?.lod === c.want));

  function settle() {
    if (!waiters.length || !isSettled()) return;
    const w = waiters; waiters = [];
    w.forEach((resolve) => resolve());
  }

  /** Bring the network up to date for the car at map position { x, y }. */
  function update({ x, y }) {
    if (disposed) return;
    const touched = new Set();
    for (const c of chunks) {
      c.dist = Math.max(0, Math.hypot(c.cx - x, c.cy - y) - c.radius);
      const cur = c.have ? c.have.lod : 2;
      const lim = (lod, d) => (cur <= lod ? d * HYSTERESIS : d);
      c.want = c.dist < lim(0, near) ? 0 : c.dist < lim(1, mid) ? 1 : 2;
      if (c.want === 2 && c.have && c.batch.mesh) { drop(c.have.mesh); c.have = null; touched.add(c.batch); }
      if (c.have) c.have.mesh.material = c.dist < NEAR_LIT ? nearMat : materials.road;
    }
    touched.forEach(regroup);
    dispatch();
    settle();
  }

  dispatch();

  return {
    update,
    /** Resolves when everything wanted for the last update is on screen. */
    whenSettled: () => (isSettled() ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    setNight: (on) => materials.setNight?.(on),
    stats() {
      const out = { batches: 0, lod0: 0, lod1: 0, drawCalls: 0, triangles: 0, inFlight, pending: chunks.filter((c) => c.pending).length };
      for (const b of batches) if (b.mesh?.visible) {
        out.batches++;
        out.drawCalls += b.mesh.geometry.groups.length;
        out.triangles += b.mesh.geometry.groups.reduce((a, g) => a + g.count / 3, 0);
      }
      for (const c of chunks) if (c.have) {
        out[c.have.lod ? 'lod1' : 'lod0']++;
        out.drawCalls++;
        out.triangles += c.have.mesh.geometry.index.count / 3;
      }
      return out;
    },
    /** Chunk states, for tests and debugging. */
    chunks: () => chunks.map((c) => ({ road: c.road, index: c.index, s0: c.s0, s1: c.s1, want: c.want, have: c.have?.lod ?? null, pending: c.pending?.lod ?? null, ...(c.cluster ? { cluster: c.cluster, parts: c.parts.length } : {}) })),
    dispose() {
      disposed = true;
      worker.terminate?.();
      for (const c of chunks) if (c.have) { drop(c.have.mesh); c.have = null; }
      for (const b of batches) if (b.mesh) { drop(b.mesh); b.mesh = null; }
      waiters = [];
    },
  };
}

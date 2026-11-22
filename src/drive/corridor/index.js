/**
 * The buildings beyond the core along the drive (plan 02, D7.6), as a drive part.
 *
 * The pipeline (scripts/build_corridor.py) cuts them into 2 km cells of buildings under 20 m, plus one
 * file of every building of 20 m or more in the drive region (format.js). This part keeps the cells
 * within `radius` (6 km) of the car on screen, one merged mesh per cell built in a worker, and drops
 * those beyond `dropRadius`; the tall file is one mesh, always shown, out to the horizon. Building
 * bases sit on the terrain the drive draws: `heightAt` is sampled at each outline's points here, on
 * the main thread, and the worker turns that into walls and a roof (mesher.js).
 *
 * The material is the app's own for its low buildings (lightAtNight over a vertex-coloured Lambert, as
 * src/city/buildings.js makes it), so by day they are the same grey and at night they get the same lit
 * windows, following the shared `night` uniform the app's look sets.
 *
 * Part interface (src/drive/session.js): { name, update(frame), setLook(look), whenSettled(), stats(), dispose() }.
 */
import * as THREE from 'three';
import { lightAtNight } from '../../night.js';
import { decodeCell } from './format.js';
import { groundUnder } from './mesher.js';

const defaultWorker = () => new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
/** The car must move this far before the wanted set is worked out again. */
const MOVE_M = 40;
const RETRY_MS = 5000;

/**
 * @param {{ index: object, fetchBinary: (file: string) => Promise<ArrayBuffer>, heightAt: (x: number, y: number) => number,
 *   base: number, earthR: number, parent: THREE.Object3D, anisotropy?: number,
 *   createWorker?: () => { postMessage: Function, onmessage: Function|null, terminate?: Function },
 *   radius?: number, dropRadius?: number, maxInFlight?: number, material?: THREE.Material }} opts
 *   index is corridor/index.json; fetchBinary loads a file named in it (relative to the index).
 */
export function createCorridor({
  index, fetchBinary, heightAt, base, earthR, parent, createWorker = defaultWorker,
  radius = 6000, dropRadius = 7500, maxInFlight = 3, material,
}) {
  if (index?.version !== 1) throw new Error(`corridor index version ${index?.version} is not supported`);
  const group = new THREE.Group();
  group.name = 'corridor';
  parent.add(group);
  const mat = material || lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const worker = createWorker();
  const cells = index.cells.map((c) => ({ ...c, want: false, state: 'none', mesh: null, retryAt: 0, dist: Infinity, load: 0 }));
  const tall = index.tall ? { ...index.tall, want: true, state: 'none', mesh: null, retryAt: 0, dist: 0, load: 0, isTall: true } : null;
  const requests = new Map();
  let nextId = 1, inFlight = 0, disposed = false, waiters = [], lastX = NaN, lastY = NaN, look = null;
  const meshMs = [];

  worker.onmessage = (e) => receive(e.data);

  const distTo = (c, x, y) => {
    const [x0, y0, x1, y1] = c.bounds;
    return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
  };

  function toMesh(m, name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const [sx, sy, sz, r] = m.sphere;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(sx, sy, sz), r);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(m.origin[0], m.origin[1], m.origin[2]);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = name;
    mesh.userData.triangles = m.triangles;
    mesh.userData.buildings = m.buildings;
    return mesh;
  }

  function drop(c) {
    if (c.mesh) { group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    c.state = 'none';
  }

  async function load(c) {
    c.state = 'loading';
    const ticket = ++c.load;
    inFlight++;
    try {
      const buf = await fetchBinary(c.file);
      if (disposed || ticket !== c.load || !c.want) { inFlight--; c.state = c.mesh ? 'meshed' : 'none'; dispatch(); settle(); return; }
      const cell = decodeCell(buf);
      const { groundMin, groundMean } = groundUnder(cell, heightAt);
      const id = nextId++;
      requests.set(id, { c, ticket });
      // the tall file spans the region: put its vertices' zero at the middle of its extent, not at the map origin
      const origin = c.isTall ? [Math.round((c.bounds[0] + c.bounds[2]) / 2), Math.round((c.bounds[1] + c.bounds[3]) / 2)] : undefined;
      worker.postMessage({ type: 'mesh', id, buf, groundMin, groundMean, base, earthR, origin }, [buf, groundMin.buffer, groundMean.buffer]);
    } catch (err) {
      inFlight--;
      console.warn(`corridor: ${c.file}:`, err);
      c.state = 'failed';
      c.retryAt = performance.now() + RETRY_MS;
      dispatch();
      settle();
    }
  }

  function receive({ id, mesh: m, ms, error }) {
    const req = requests.get(id);
    requests.delete(id);
    inFlight--;
    if (disposed || !req) return;
    const { c, ticket } = req;
    if (error) {
      console.warn('corridor mesher:', error);
      c.state = 'failed'; c.retryAt = performance.now() + RETRY_MS;
    } else if (ticket === c.load && c.want) {
      if (c.mesh) drop(c);
      c.mesh = toMesh(m, c.isTall ? 'corridor tall' : `corridor ${c.file}`);
      group.add(c.mesh);
      c.state = 'meshed';
      meshMs.push(ms);
      if (meshMs.length > 64) meshMs.shift();
    } else if (!c.mesh) c.state = 'none';
    dispatch();
    settle();
  }

  function dispatch() {
    if (disposed) return;
    const now = performance.now();
    const todo = [tall, ...cells].filter((c) => c && c.want && (c.state === 'none' || (c.state === 'failed' && now >= c.retryAt)));
    todo.sort((a, b) => a.dist - b.dist);
    for (const c of todo) {
      if (inFlight >= maxInFlight) break;
      load(c);
    }
  }

  const isSettled = () => [tall, ...cells].every((c) => !c || !c.want || c.state === 'meshed' || c.state === 'failed');

  function settle() {
    if (!waiters.length || !isSettled()) return;
    const w = waiters; waiters = [];
    w.forEach((resolve) => resolve());
  }

  /** Work out which cells are wanted for the car at map (x, y). */
  function place(x, y) {
    lastX = x; lastY = y;
    for (const c of cells) {
      c.dist = distTo(c, x, y);
      if (c.dist <= radius) c.want = true;
      else if (c.dist > dropRadius) { c.want = false; if (c.state !== 'loading') drop(c); }
    }
    dispatch();
    settle();
  }

  dispatch();

  return {
    name: 'corridor',
    group,
    /** @param {{ pose: { position: { x: number, z: number } } }} frame */
    update(frame) {
      if (disposed) return;
      const x = frame.pose.position.x, y = -frame.pose.position.z;
      // nothing to do until the car has moved a little, or a failed cell is due again
      if (Math.abs(x - lastX) < MOVE_M && Math.abs(y - lastY) < MOVE_M) {
        if (cells.some((c) => c.state === 'failed' && c.want) || tall?.state === 'failed') dispatch();
        return;
      }
      place(x, y);
    },
    /** The look follows the app's shared `night` uniform; kept for stats. */
    setLook(l) { look = l; },
    whenSettled: () => (isSettled() ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    stats() {
      const shown = [tall, ...cells].filter((c) => c?.mesh);
      return {
        cells: shown.filter((c) => !c.isTall).length,
        tall: !!tall?.mesh,
        loading: inFlight,
        wanted: cells.filter((c) => c.want).length,
        drawCalls: shown.length,
        triangles: shown.reduce((a, c) => a + c.mesh.userData.triangles, 0),
        buildings: shown.reduce((a, c) => a + c.mesh.userData.buildings, 0),
        meshMsMax: meshMs.length ? Math.max(...meshMs) : 0,
        night: look?.night ?? null,
      };
    },
    dispose() {
      disposed = true;
      worker.terminate?.();
      for (const c of [tall, ...cells]) if (c) drop(c);
      parent.remove(group);
      if (!material) mat.dispose();
      waiters.forEach((resolve) => resolve());
      waiters = [];
    },
  };
}

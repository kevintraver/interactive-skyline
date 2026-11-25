import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createRoadChunks } from '../../../src/drive/roadnet/chunks.js';
import { createRoadMaterials } from '../../../src/drive/roadnet/material.js';
import { createMesherHandler } from '../../../src/drive/roadnet/mesher.worker.js';
import { reflineOf } from '../../../src/drive/roadnet/mesher.js';
import { fixture, BASE, EARTH_R } from './helpers.js';

/** A worker stand-in running the real mesher: queued (flush by hand) or answering at once. */
function fakeWorker({ sync = false } = {}) {
  const w = { queue: [], posted: [], onmessage: null, terminated: false };
  const handle = createMesherHandler((data) => w.onmessage({ data }));
  w.postMessage = (msg) => { w.posted.push(msg); if (sync || msg.type === 'init') handle(msg); else w.queue.push(msg); };
  w.flush = (n = Infinity) => { while (w.queue.length && n-- > 0) handle(w.queue.shift()); };
  w.terminate = () => { w.terminated = true; };
  return w;
}

function setup(opts = {}) {
  const roadnet = fixture();
  const parent = new THREE.Group();
  let worker;
  const roads = createRoadChunks({
    roadnet, base: BASE, earthR: EARTH_R, parent, materials: createRoadMaterials(),
    createWorker: () => (worker = fakeWorker(opts)), near: 100, mid: 600, ...opts,
  });
  return { roadnet, parent, roads, worker, at: (s) => reflineOf(roadnet.roads[0]).at(s) };
}
const meshes = (w) => w.posted.filter((m) => m.type === 'mesh');
const byLevel = (roads, road = 0) => roads.chunks().filter((c) => c.road === road).map((c) => c.have);

describe('road chunks', () => {
  it('asks for one level-2 batch per road first, and is settled once they arrive', async () => {
    const { roads, worker, parent } = setup();
    expect(worker.posted[0].type).toBe('init');
    expect(meshes(worker).map((m) => [m.road, m.lod, m.s0, m.s1, m.split])).toEqual([[0, 2, 0, 3000, 256], [1, 2, 0, 1200, 256]]);
    let settled = false;
    roads.whenSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.flush();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(parent.children).toHaveLength(2);
    expect(roads.stats()).toMatchObject({ batches: 2, lod0: 0, lod1: 0, drawCalls: 2 });
  });

  it('refines chunks near the car, nearest first, and cuts them out of the batch', async () => {
    const { roads, worker, at, parent } = setup();
    worker.flush();
    roads.update(at(1000));
    const asked = meshes(worker).slice(2);
    expect(asked.length).toBe(4); // maxInFlight
    expect(asked[0]).toMatchObject({ road: 0, lod: 0, s0: 768, s1: 1024 });
    let settled = false;
    roads.whenSettled().then(() => { settled = true; });
    worker.flush();
    await Promise.resolve();
    expect(settled).toBe(true);
    const levels = byLevel(roads);
    // chunk 3 holds s = 1000; within 100 m: chunks 3 and 4; within 600 m: 1, 2, 5, 6
    expect(levels).toEqual([null, 1, 1, 0, 0, 1, 1, null, null, null, null, null]);
    const batch = parent.children.find((c) => Array.isArray(c.material) && c.geometry.groups.length && c.name.includes('0-3000'));
    expect(batch.geometry.groups).toHaveLength(2); // chunk 0, then chunks 7..11
    const st = roads.stats();
    const groups = parent.children.filter((c) => Array.isArray(c.material) && c.visible).reduce((a, c) => a + c.geometry.groups.length, 0);
    expect(st.drawCalls).toBe(groups + st.lod0 + st.lod1);
    expect(st.lod0 + st.lod1).toBe(6 + byLevel(roads, 1).filter((l) => l !== null).length); // road B runs alongside
  });

  it('keeps the coarser mesh until the finer one arrives, and releases chunks left behind', async () => {
    const { roads, worker, at, parent } = setup();
    worker.flush();
    roads.update(at(1000));
    worker.flush();
    await roads.whenSettled();
    roads.update(at(1300)); // chunk 5 (1280..1536) becomes near; chunk 3 goes back to level 1; chunk 1 is released
    expect(byLevel(roads)[1]).toBe(null); // the batch covers it at once
    expect(byLevel(roads)[5]).toBe(1); // still the old mesh while level 0 is on its way
    const before = parent.children.length;
    expect(roads.chunks()[5]).toMatchObject({ want: 0, pending: 0 });
    worker.flush(1);
    expect(parent.children.length).toBe(before); // one swapped for one: no gap, no double
    worker.flush();
    await roads.whenSettled();
    expect(byLevel(roads)).toEqual([null, null, 1, 1, 0, 0, 1, 1, null, null, null, null]);
  });

  it('drops answers that are no longer wanted', async () => {
    const { roads, worker, at } = setup();
    worker.flush();
    roads.update(at(1000));
    roads.update(at(2900)); // before any answer arrives
    worker.flush();
    await roads.whenSettled();
    const levels = byLevel(roads);
    expect(levels.slice(0, 7).every((l) => l === null)).toBe(true);
    expect(levels[11]).toBe(0);
  });

  it('serves every road: the car beside the opposite carriageway refines both', async () => {
    const { roads, worker, at } = setup();
    worker.flush();
    roads.update(at(600));
    worker.flush();
    await roads.whenSettled();
    expect(byLevel(roads, 1).filter((l) => l === 0).length).toBeGreaterThan(0);
  });

  it('works with a worker that answers synchronously', async () => {
    const { roads, at, parent } = setup({ sync: true });
    roads.update(at(1000));
    await roads.whenSettled();
    expect(byLevel(roads)).toEqual([null, 1, 1, 0, 0, 1, 1, null, null, null, null, null]);
    roads.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('uses about 26 draw calls for a 70 km road at the default ranges', async () => {
    const roadnet = fixture();
    const a = roadnet.roads[0];
    // stretch the fixture into 70 km of straight road
    const n = 17501, c = Math.cos(0.6), s = Math.sin(0.6);
    const long = { ...a, id: 'long', count: n, length: (n - 1) * 4, sections: [{ ...a.sections[0], s1: (n - 1) * 4 }],
      x: Float64Array.from({ length: n }, (_, i) => -40000 + c * 4 * i), y: Float64Array.from({ length: n }, (_, i) => -40000 + s * 4 * i),
      h: new Float64Array(n).fill(800), heading: new Float64Array(n).fill(0.6), curvature: new Float64Array(n), crossfall: new Float64Array(n).fill(0.02) };
    const parent = new THREE.Group();
    const roads = createRoadChunks({ roadnet: { roads: [long] }, base: BASE, earthR: EARTH_R, parent, materials: createRoadMaterials(), createWorker: () => fakeWorker({ sync: true }) });
    roads.update({ x: -40000 + c * 30000, y: -40000 + s * 30000 });
    await roads.whenSettled();
    const st = roads.stats();
    console.log('70 km road:', JSON.stringify(st));
    expect(st.batches).toBe(5);
    expect(st.drawCalls).toBeLessThanOrEqual(28);
    roads.dispose();
  });
});

// Interchanges in the runtime: the RoadNet records of format.js ("junctions and gores",
// "structures", road bridges with decks, embankment limits), the mesher's decks, parapets, gores,
// piers and abutments, and the chunk manager's clusters for the small roads.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { decodeRoadNet, encodeRoadNet, RoadNetError } from '../../../src/drive/roadnet/format.js';
import { meshChunk, meshParts, rowStations, modePieces, goreEdge, reflineOf, DECK, PARAPET, EMBANKMENT } from '../../../src/drive/roadnet/mesher.js';
import { edgesAt } from '../../../src/drive/roadnet/crosssection.js';
import { KIND, REGIONS, ATLAS_W } from '../../../src/drive/roadnet/atlas.js';
import { createRoadChunks } from '../../../src/drive/roadnet/chunks.js';
import { createRoadMaterials } from '../../../src/drive/roadnet/material.js';
import { createMesherHandler } from '../../../src/drive/roadnet/mesher.worker.js';
import { interchange, interchangeInput, MAIN_H, CF } from './interchange-fixture.js';
import { fixture, BASE, EARTH_R } from './helpers.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const world = (m, i) => [m.origin[0] + m.positions[3 * i], m.origin[1] + m.positions[3 * i + 1], m.origin[2] + m.positions[3 * i + 2]];
const height = ([x, y, z]) => y + BASE + (x * x + z * z) / (2 * EARTH_R);
const inRegion = (u, name) => u * ATLAS_W >= REGIONS[name][0] && u * ATLAS_W <= REGIONS[name][1];

describe('RoadNet interchange records', () => {
  const { json, bin, net } = interchange();
  const [main, ramp, cross] = net.roads;

  it('decodes roles, decks, embankment limits, junctions and structures, and attaches them to their roads', () => {
    expect(net.roads.map((r) => r.role)).toEqual(['main', 'ramp', 'crossing']);
    expect(main.bridges).toEqual([]);
    expect(cross.bridges).toEqual([{ s0: 120, s1: 180, kind: 'bridge', deck: true }]);
    expect(ramp.embankment).toEqual([{ s0: 0, s1: 400, side: 'right', w: 2 }]);
    expect(net.junctions).toHaveLength(1);
    expect(net.junctions[0].a).toMatchObject({ road: 'm.main', index: 0 });
    expect(net.junctions[0].b).toMatchObject({ road: 'm.x1.off', index: 1 });
    expect(main.hides).toEqual([{ side: 'right', s0: 200, s1: 380 }]);
    expect(main.gores).toHaveLength(1);
    expect(ramp.hides).toEqual([]);
    expect(cross.structures.map((s) => [s.kind, s.s])).toEqual([['abutment', 120], ['pier', 150], ['abutment', 180]]);
    expect(net.structures).toHaveLength(4); // the unknown kind is kept
  });

  it('still decodes a roadnet written before interchanges (no records, bridges without decks)', () => {
    const old = fixture();
    expect(old.junctions).toEqual([]);
    expect(old.structures).toEqual([]);
    for (const r of old.roads) expect(r).toMatchObject({ role: 'main', hides: [], gores: [], structures: [], embankment: [] });
  });

  it('writes the records back as the file had them', () => {
    const again = encodeRoadNet(net);
    expect(Buffer.from(again.bin).equals(Buffer.from(bin))).toBe(true);
    expect(clone(again.json).junctions).toEqual(json.junctions);
    expect(clone(again.json).structures).toEqual(json.structures);
    for (const r of again.json.roads) for (const k of ['hides', 'gores', 'structures']) expect(r[k]).toBeUndefined();
  });

  const bad = (edit, pattern) => {
    const j = clone(json);
    edit(j);
    expect(() => decodeRoadNet(j, bin)).toThrow(RoadNetError);
    expect(() => decodeRoadNet(j, bin)).toThrow(pattern);
  };
  it('rejects a junction to a road that is not there', () => bad((j) => { j.junctions[0].b.road = 'nope'; }, /not in the roadnet/));
  it('rejects a repeated junction id', () => bad((j) => { j.junctions.push(clone(j.junctions[0])); }, /repeated/));
  it('rejects a gore whose chainages do not increase', () => bad((j) => { j.junctions[0].gore.b[2] = 10; }, /must increase/));
  it('rejects a gore without a side', () => bad((j) => { j.junctions[0].side = ''; }, /side left or right/));
  it('rejects an unknown junction kind', () => bad((j) => { j.junctions[0].kind = 'weave'; }, /kind/));
  it('rejects an abutment without a direction', () => bad((j) => { j.structures[1].dir = 0; }, /dir/));
  it('rejects a pier without a height', () => bad((j) => { delete j.structures[0].h1; }, /h1/));
  it('rejects an embankment limit on no side', () => bad((j) => { j.roads[1].embankment[0].side = 'up'; }, /side/));
  it('rejects an unknown role', () => bad((j) => { j.roads[1].role = 'sliproad'; }, /role/));
  it('rejects a bridge that runs backwards', () => bad((j) => { j.roads[2].bridges[0].s1 = 100; }, /bridge/));
});

describe('structure mesher', () => {
  const { net } = interchange();
  const [main, ramp, cross] = net.roads;
  const opts = { base: BASE, earthR: EARTH_R, roads: net.roads };

  it('cuts rows at the ends of decks and hidden shoulders, and gives each span its mode', () => {
    const spans = rowStations(cross, 0, 300, 0);
    // the deck's expansion joints (atlas.js JOINT) are spans of their own inside it
    const joints = spans.filter((sp) => sp.surface.joint);
    expect(joints.map((sp) => [sp.s0, sp.s1 - sp.s0, sp.mode.deck]).map(([a, l, d]) => [a, +l.toFixed(6), d])).toEqual([[120, 0.3, true], [179.7, 0.3, true]]);
    const merged = spans.filter((sp) => !sp.surface.joint).map((sp) => [sp.s0, sp.s1, sp.mode.deck]);
    expect(merged.map(([a, b, d]) => [+a.toFixed(6), +b.toFixed(6), d])).toEqual([[0, 120, false], [120.3, 179.7, true], [180, 300, false]]);
    const mspans = rowStations(main, 0, 512, 0);
    expect(mspans.find((sp) => sp.s0 === 200 && sp.s1 === 380).mode.hideR).toBe(true);
  });

  it('on a deck: parapets, fascias and a soffit instead of embankments, with outward normals', () => {
    const m = meshChunk({ road: cross, s0: 128, s1: 172, lod: 0, ...opts });
    const pieces = modePieces(edgesAt(cross, 150), { deck: true });
    expect(pieces.filter((p) => p.kind === KIND.embankment)).toHaveLength(0);
    expect(pieces.filter((p) => p.kind === KIND.structure)).toHaveLength(7); // 3 + 3 parapet faces, the soffit
    let soffit = 0, top = 0;
    for (let i = 0; i < m.kind.length; i++) {
      if (m.kind[i] !== KIND.structure) continue;
      const [, , z] = world(m, i);
      const h = height(world(m, i)) - reflineOf(cross).at(-z + 150).h; // the road runs north from y = -150
      if (Math.abs(h + DECK) < 0.02) soffit++;
      if (Math.abs(h - PARAPET.h) < 0.02) top++;
    }
    expect(soffit).toBeGreaterThan(10);
    expect(top).toBeGreaterThan(10);
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])).toBeCloseTo(1, 5);
    // every structure triangle's winding agrees with its normal (so it is not culled from outside)
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      if (m.kind[a] !== KIND.structure) continue;
      const P = (i) => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];
      const [A, B, C] = [P(a), P(b), P(c)];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      if (Math.hypot(...n) < 1e-9 || Math.abs(m.normals[3 * a + 1]) < 1e-6 && n[1] < -0.5 * Math.hypot(...n)) continue; // the soffit is lit as a side face
      expect(n[0] * m.normals[3 * a] + n[1] * m.normals[3 * a + 1] + n[2] * m.normals[3 * a + 2]).toBeGreaterThan(0);
    }
  });

  it('meshes the pier as a box from h0 to h1, squared to the road, and the abutments as slopes', () => {
    const m = meshChunk({ road: cross, s0: 0, s1: 300, lod: 1, ...opts });
    const pier = cross.structures.find((s) => s.kind === 'pier');
    const hs = [];
    for (let i = 0; i < m.kind.length; i++) if (m.kind[i] === KIND.structure) hs.push(height(world(m, i)));
    expect(hs.some((h) => Math.abs(h - pier.h0) < 0.01)).toBe(true);
    expect(hs.some((h) => Math.abs(h - pier.h1) < 0.01)).toBe(true);
    const ab = cross.structures.find((s) => s.kind === 'abutment');
    expect(hs.some((h) => Math.abs(h - ab.h1) < 0.01)).toBe(true);
    expect(m.ranges).toHaveLength(1);
    expect(m.ranges[0].count).toBe(m.indices.length);
  });

  it('hides the shoulder beside a gore and fills the gore from the edge line to the ramp', () => {
    const m = meshChunk({ road: main, s0: 256, s1: 512, lod: 0, ...opts });
    const cs = edgesAt(main, 300);
    const pieces = modePieces(cs, { hideR: true });
    const sh = pieces.filter((p) => p.kind === KIND.shoulder && p.side === 'right');
    expect(sh).toHaveLength(1);
    expect(sh[0].dl).toBeCloseTo(sh[0].dr, 9); // no width
    expect(sh[0].dl).toBeCloseTo(goreEdge(cs, 'right'), 9);
    expect(goreEdge(cs, 'right')).toBeCloseTo(-(3 * 3.66) / 2 - 0.5, 9);
    // the gore strip: vertices in the gore region, from the main's gore edge to the ramp's left edge
    const gore = [];
    for (let i = 0; i < m.kind.length; i++) if (inRegion(m.uvs[2 * i], 'gore')) gore.push(i);
    expect(gore.length).toBeGreaterThan(20);
    const p = reflineOf(main).at(300);
    const lat = (i) => { const [x, , z] = world(m, i); return (x - p.x) * -Math.sin(p.heading) + (-z - p.y) * Math.cos(p.heading); };
    const at300 = gore.filter((i) => Math.abs(world(m, i)[0] - 300) < 0.01);
    expect(at300).toHaveLength(2);
    const [dA, dB] = at300.map(lat).sort((a, b) => b - a);
    expect(dA).toBeCloseTo(goreEdge(cs, 'right'), 3);
    const rcs = edgesAt(ramp, 100);
    const rp = reflineOf(ramp).at(100);
    expect(dB).toBeCloseTo(rp.y + rcs.left * Math.cos(rp.heading), 3);
    // in the plane of the main, as the writer puts the ramp there
    for (const i of at300) expect(height(world(m, i))).toBeCloseTo(MAIN_H + CF * lat(i), 2);
  });

  it('holds an embankment to its limit and draws it as a concrete wall when that is narrow', () => {
    const m = meshChunk({ road: ramp, s0: 200, s1: 400, lod: 0, ...opts });
    const p = reflineOf(ramp).at(300);
    const cs = edgesAt(ramp, 300);
    let widest = 0, walls = 0;
    for (let i = 0; i < m.kind.length; i++) {
      if (m.kind[i] !== KIND.embankment) continue;
      const [x, , z] = world(m, i);
      const along = (x - p.x) * Math.cos(p.heading) + (-z - p.y) * Math.sin(p.heading);
      if (Math.abs(along) > 0.05) continue; // the row at s = 300 only
      const d = (x - p.x) * -Math.sin(p.heading) + (-z - p.y) * Math.cos(p.heading);
      if (d < cs.right) widest = Math.max(widest, cs.right - d);
      if (inRegion(m.uvs[2 * i], 'concrete')) walls++;
    }
    expect(widest).toBeLessThan(2 + 1e-3);
    expect(walls).toBeGreaterThan(0);
  });

  it('meshes the old fixture exactly as before (no records, no change)', () => {
    const old = fixture();
    const a = meshChunk({ road: old.roads[0], s0: 256, s1: 512, lod: 0, base: BASE, earthR: EARTH_R });
    const b = meshChunk({ road: old.roads[0], s0: 256, s1: 512, lod: 0, base: BASE, earthR: EARTH_R, roads: old.roads });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(new Set(a.kind)).toEqual(new Set([KIND.lane, KIND.marking, KIND.shoulder, KIND.embankment]));
  });

  it('gathers stretches of several roads into one set of buffers with a range per group', () => {
    const m = meshParts({ parts: [{ road: 1, s0: 0, s1: 256, group: 0 }, { road: 2, s0: 0, s1: 300, group: 1 }, { road: 1, s0: 256, s1: 400, group: 0 }], groups: 2, lod: 1, ...opts });
    expect(m.ranges.map((r) => r.group)).toEqual([0, 1]);
    expect(m.ranges[0].start).toBe(0);
    expect(m.ranges[1].start).toBe(m.ranges[0].count);
    expect(m.ranges[0].count + m.ranges[1].count).toBe(m.indices.length);
    for (const i of m.indices) expect(i).toBeLessThan(m.kind.length);
  });

  it('meshes a level-0 chunk of the interchange within the worker budget', () => {
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) meshChunk({ road: cross, s0: 0, s1: 300, lod: 0, ...opts });
    expect((performance.now() - t0) / 5).toBeLessThan(8);
  });
});

describe('road chunks with interchanges', () => {
  function fakeWorker() {
    const w = { posted: [], onmessage: null };
    const handle = createMesherHandler((data) => w.onmessage({ data }));
    w.postMessage = (msg) => { w.posted.push(msg); handle(msg); };
    w.terminate = () => {};
    return w;
  }

  it('gathers the ramp and the crossing road into cluster chunks and one batch, so they cost few draw calls', async () => {
    const { net } = interchange();
    let worker;
    const parent = new THREE.Group();
    const roads = createRoadChunks({ roadnet: net, base: BASE, earthR: EARTH_R, parent, materials: createRoadMaterials(), createWorker: () => (worker = fakeWorker()), near: 100, mid: 600 });
    await roads.whenSettled();
    const clusters = roads.chunks().filter((c) => c.cluster);
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters.reduce((a, c) => a + c.parts, 0)).toBe(2 + 2); // 400 m ramp in two pieces, 300 m crossing in two
    expect(roads.stats()).toMatchObject({ batches: 2, drawCalls: 2 });
    const batchMsg = worker.posted.find((m) => m.parts);
    expect(batchMsg.groups).toBe(clusters.length);
    roads.update({ x: 700, y: 0 });
    await roads.whenSettled();
    const st = roads.stats();
    expect(st.lod0).toBeGreaterThan(0);
    expect(st.drawCalls).toBeLessThan(12);
    expect(parent.children.some((m) => m.name.startsWith('interchange'))).toBe(true);
    roads.dispose();
  });
});

// keep the fixture's input honest: every record kind is in it
describe('interchange fixture', () => {
  it('has a gore, a deck, a pier, abutments and an embankment limit', () => {
    const inp = interchangeInput();
    expect(inp.junctions[0].gore).toBeTruthy();
    expect(inp.structures.map((s) => s.kind)).toEqual(expect.arrayContaining(['pier', 'abutment']));
    expect(EMBANKMENT[0][0]).toBe(24);
  });
});

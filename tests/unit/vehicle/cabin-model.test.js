// The cabin model (plan 02, D4.1): cabin.json and the GLBs' JSON chunks agree on names, budgets and the eye.
// The GLBs are built by models/drive/cabin/build_cabin.py; tests/manual/cabin-check.mjs checks the geometry
// in three.js itself.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../../public/models/drive/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('cabin.json', DIR), 'utf8'));

function glbJson(file) {
  const buf = readFileSync(new URL(file, DIR));
  expect(buf.toString('latin1', 0, 4)).toBe('glTF');
  expect(buf.readUInt32LE(4)).toBe(2);
  const length = buf.readUInt32LE(12);
  expect(buf.readUInt32LE(16)).toBe(0x4e4f534a); // 'JSON'
  const doc = JSON.parse(buf.toString('utf8', 20, 20 + length));
  const binStart = 20 + length;
  expect(buf.readUInt32LE(binStart + 4)).toBe(0x004e4942); // 'BIN'
  doc.bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart));
  return doc;
}

/** The float values of a VEC2 accessor (UVs), read from the BIN chunk. */
function vec2Values(doc, index) {
  const acc = doc.accessors[index];
  expect(acc.componentType).toBe(5126);
  const view = doc.bufferViews[acc.bufferView];
  const stride = view.byteStride || 8;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) out.push(doc.bin.readFloatLE(base + i * stride), doc.bin.readFloatLE(base + i * stride + 4));
  return out;
}

const NODES = ['Cabin', 'Wheel', 'MirrorLeft', 'MirrorRight', 'MirrorCenter', 'Instruments', 'CenterScreen'];
const MATERIALS = ['CabinDash', 'CabinTrim', 'CabinPillar', 'Hood', 'MirrorHousing', 'Mirror', 'Screen'];
const FILES = [['cabin.glb', 'high', 40000], ['cabin-low.glb', 'low', 15000]];

const triangles = (doc) =>
  doc.meshes.flatMap((m) => m.primitives).reduce((n, p) => n + doc.accessors[p.indices].count / 3, 0);
const len = (a) => Math.hypot(...a);

describe('cabin.json', () => {
  it('puts the eye 1.2 m above the road at the origin, with the car centre to the right', () => {
    expect(meta.eye).toEqual([0, 1.2, 0]);
    expect(meta.carCenterX).toBeGreaterThan(0.3);
    expect(meta.carCenterX).toBeLessThan(0.45);
    expect(meta.neckPivot[2]).toBeCloseTo(0.1, 6); // behind the eye: the car faces -Z
  });

  it('describes each mirror and display with a unit normal facing the eye and a sensible size', () => {
    const faces = [...Object.values(meta.mirrors), meta.instruments, meta.centerScreen];
    for (const f of faces) {
      expect(NODES).toContain(f.node);
      expect(len(f.normal)).toBeCloseTo(1, 3);
      const toEye = meta.eye.map((e, i) => e - f.center[i]);
      expect(toEye.reduce((s, x, i) => s + x * f.normal[i], 0)).toBeGreaterThan(0);
      expect(f.width).toBeGreaterThan(0.05);
      expect(f.height).toBeGreaterThan(0.03);
      expect(f.width).toBeLessThan(0.4);
    }
  });

  it('places the door mirrors where the driver glances for them', () => {
    const yaw = (c) => (Math.atan2(c[0], -c[2]) * 180) / Math.PI; // + is to the right
    expect(-yaw(meta.mirrors.left.center)).toBeGreaterThanOrEqual(35);
    expect(-yaw(meta.mirrors.left.center)).toBeLessThanOrEqual(45);
    expect(yaw(meta.mirrors.right.center)).toBeGreaterThanOrEqual(55);
    expect(yaw(meta.mirrors.right.center)).toBeLessThanOrEqual(65);
    expect(meta.mirrors.center.center[1]).toBeGreaterThan(meta.eye[1]); // above the eye, not across the road
  });

  it('records a forward view of at least 60 degrees and the road visible 12 m ahead', () => {
    expect(meta.view.forwardViewDeg).toBeGreaterThanOrEqual(60);
    expect(meta.view.roadAt12mVisible).toBe(true);
    expect(meta.view.roadVisibleFromM).toBeLessThanOrEqual(12);
  });

  it('gives the wheel a pivot ahead of and below the eye, and a unit axis toward the driver', () => {
    const { pivot, axis } = meta.wheel;
    expect(pivot[2]).toBeLessThan(0);
    expect(pivot[1]).toBeLessThan(meta.eye[1]);
    expect(len(axis)).toBeCloseTo(1, 3);
    expect(axis[2]).toBeGreaterThan(0);
  });

  it('gives the windshield opening four corners ahead of the eye, wider at the bottom', () => {
    const { bottomLeft, bottomRight, topRight, topLeft } = meta.windshield.corners;
    for (const c of [bottomLeft, bottomRight, topRight, topLeft]) expect(c[2]).toBeLessThan(-0.5);
    expect(bottomLeft[0]).toBeLessThan(0);
    expect(bottomRight[0]).toBeGreaterThan(meta.carCenterX);
    expect(topLeft[1]).toBeGreaterThan(bottomLeft[1]);
    expect(bottomRight[0] - bottomLeft[0]).toBeGreaterThan(topRight[0] - topLeft[0]);
  });
});

describe.each(FILES)('%s', (file, key, budget) => {
  const doc = glbJson(file);

  it('has the named nodes, the Wheel at the pivot, and no other transforms', () => {
    const names = doc.nodes.map((n) => n.name);
    expect(names.sort()).toEqual([...NODES].sort());
    for (const n of doc.nodes) {
      expect(n.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
      expect(n.scale ?? [1, 1, 1]).toEqual([1, 1, 1]);
    }
    const wheel = doc.nodes.find((n) => n.name === 'Wheel');
    wheel.translation.forEach((t, i) => expect(t).toBeCloseTo(meta.wheel.pivot[i], 4));
    for (const n of doc.nodes.filter((n) => n.name !== 'Wheel')) expect(n.translation ?? [0, 0, 0]).toEqual([0, 0, 0]);
  });

  it(`stays within ${budget} triangles and matches cabin.json`, () => {
    const t = triangles(doc);
    expect(t).toBeLessThanOrEqual(budget);
    expect(t).toBe(meta.triangles[key]);
  });

  it('uses only the stable plain materials, with no textures and no brand-like names', () => {
    const names = doc.materials.map((m) => m.name);
    expect(new Set(names)).toEqual(new Set(MATERIALS));
    expect(doc.images ?? []).toHaveLength(0);
    expect(doc.textures ?? []).toHaveLength(0);
    for (const n of [...names, ...doc.nodes.map((x) => x.name), ...doc.meshes.map((x) => x.name)]) {
      expect(n).not.toMatch(/logo|badge|brand|emblem/i);
    }
  });

  it('gives the mirror and display faces UVs, and puts the eye point inside the cabin bounds', () => {
    for (const name of ['MirrorLeft', 'MirrorRight', 'MirrorCenter', 'Instruments', 'CenterScreen']) {
      const node = doc.nodes.find((n) => n.name === name);
      const prim = doc.meshes[node.mesh].primitives[0];
      expect(prim.attributes.TEXCOORD_0).toBeDefined();
      const uv = vec2Values(doc, prim.attributes.TEXCOORD_0);
      expect(Math.min(...uv)).toBeGreaterThanOrEqual(-1e-3);
      expect(Math.max(...uv)).toBeLessThanOrEqual(1 + 1e-3);
      expect(Math.max(...uv) - Math.min(...uv)).toBeGreaterThan(0.99); // spans the whole 0..1 square
    }
    const cabin = doc.nodes.find((n) => n.name === 'Cabin');
    const pos = doc.accessors[doc.meshes[cabin.mesh].primitives[0].attributes.POSITION];
    const all = doc.meshes[cabin.mesh].primitives.map((p) => doc.accessors[p.attributes.POSITION]);
    const min = [0, 1, 2].map((i) => Math.min(...all.map((a) => a.min[i])));
    const max = [0, 1, 2].map((i) => Math.max(...all.map((a) => a.max[i])));
    expect(pos).toBeDefined();
    meta.eye.forEach((e, i) => {
      expect(e).toBeGreaterThan(min[i]);
      expect(e).toBeLessThan(max[i]);
    });
    expect(min[1]).toBeGreaterThan(0.2); // the cabin floats above the road datum; the app adds no offset
  });
});

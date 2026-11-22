// The traffic bodies (plan 02, D6.3): public/models/drive/vehicles.glb and its sidecar vehicles.json.
// Reads the GLB's JSON and binary chunks directly (no loader) and checks names, the one-material/vertex-colour
// contract, triangle budgets, dimensions inside the class ranges, and that every lamp sits on its body.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../../public/models/drive/', import.meta.url);
const sidecar = JSON.parse(readFileSync(new URL('vehicles.json', dir), 'utf8'));
const glb = readFileSync(new URL('vehicles.glb', dir));

function chunks(buf) {
  expect(buf.toString('latin1', 0, 4)).toBe('glTF');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), kind = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (kind === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    if (kind === 0x004e4942) bin = body;
    off += 8 + len;
  }
  return { json, bin };
}
const { json: doc, bin } = chunks(glb);

// Class ranges, metres (see the table at the top of models/drive/vehicles/build_vehicles.py)
const RANGES = {
  sedan: { length: [4.8, 5.0], width: [1.8, 1.87], height: [1.42, 1.48], wheelbase: [2.75, 2.92] },
  crossover: { length: [4.5, 4.75], width: [1.82, 1.9], height: [1.62, 1.75], wheelbase: [2.62, 2.78] },
  pickup: { length: [5.8, 5.95], width: [2.0, 2.06], height: [1.9, 2.0], wheelbase: [3.6, 3.7] },
  van: { length: [5.9, 6.0], width: [2.0, 2.05], height: [2.45, 2.6], wheelbase: [3.6, 3.7] },
  tractor_trailer: { length: [21.3, 22.9], width: [2.55, 2.6], height: [3.9, 4.12], wheelbase: [5.5, 6.4] },
  coach: { length: [13.6, 13.8], width: [2.55, 2.6], height: [3.4, 3.7], wheelbase: [7.0, 7.5] },
};
const LOD0_MAX = { tractor_trailer: 950, coach: 800 };
const BODIES = Object.keys(RANGES);

const meshByNode = Object.fromEntries(doc.nodes.map((n) => [n.name, doc.meshes[n.mesh]]));

function accessorData(index) {
  const acc = doc.accessors[index];
  const view = doc.bufferViews[acc.bufferView];
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type];
  const read = { 5126: [4, (o) => bin.readFloatLE(o)], 5123: [2, (o) => bin.readUInt16LE(o)], 5125: [4, (o) => bin.readUInt32LE(o)] }[acc.componentType];
  const stride = view.byteStride || read[0] * n;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const t = [];
    for (let c = 0; c < n; c++) t.push(read[1](base + i * stride + c * read[0]));
    out.push(n === 1 ? t[0] : t);
  }
  return out;
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
/** Distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) q = b;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) q = add(a, ab, d1 / (d1 - d3));
    else if (d6 >= 0 && d5 <= d6) q = c;
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) q = add(a, ac, d2 / (d2 - d6));
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) q = add(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
    else {
      const den = 1 / (va + vb + vc);
      q = add(add(a, ab, vb * den), ac, vc * den);
    }
  }
  const d = sub(p, q);
  return Math.sqrt(dot(d, d));
}

function allLamps(lamps) {
  const out = [];
  lamps.head.forEach((p, i) => out.push({ name: `head ${i ? 'right' : 'left'}`, p, facing: 'front' }));
  lamps.tail.forEach((p, i) => out.push({ name: `tail ${i ? 'right' : 'left'}`, p, facing: 'rear' }));
  if (lamps.chmsl) out.push({ name: 'chmsl', p: lamps.chmsl, facing: 'rear' });
  lamps.side_marker_front.forEach((p, i) => out.push({ name: `front side marker ${i}`, p, facing: i ? 'right' : 'left' }));
  lamps.side_marker_rear.forEach((p, i) => out.push({ name: `rear side marker ${i}`, p, facing: i ? 'right' : 'left' }));
  lamps.clearance.forEach((c, i) => out.push({ name: `${c.kind} ${i}`, p: c.p, facing: c.facing }));
  return out;
}

describe('vehicles.glb', () => {
  it('has exactly the twelve nodes, each one mesh with one primitive and the one shared material', () => {
    const names = doc.nodes.map((n) => n.name).sort();
    expect(names).toEqual(BODIES.flatMap((b) => [`${b}_lod0`, `${b}_lod1`]).sort());
    expect(doc.materials.map((m) => m.name)).toEqual([sidecar.material]);
    for (const n of doc.nodes) {
      const prims = doc.meshes[n.mesh].primitives;
      expect(prims).toHaveLength(1);
      expect(prims[0].material).toBe(0);
      expect(Object.keys(prims[0].attributes).sort()).toEqual(['COLOR_0', 'NORMAL', 'POSITION', sidecar.paint.attribute].sort());
      expect(n.translation ?? [0, 0, 0]).toEqual([0, 0, 0]);
      expect(n.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
    }
    expect(glb.length).toBeLessThan(300_000);
  });

  it('carries no brand names in node, mesh or material names', () => {
    const names = [...doc.nodes, ...doc.meshes, ...doc.materials].map((x) => x.name).join(' ');
    expect(names).toMatch(/^[a-zA-Z_0-9 ]+$/);
    expect(names.split(/\s+/).every((n) => /^(sedan|crossover|pickup|van|tractor_trailer|coach)_lod[01]$|^VehicleBody$/.test(n))).toBe(true);
  });

  it('marks paint with 0/1 values only, and paint is white in COLOR_0', () => {
    for (const n of doc.nodes) {
      const attrs = doc.meshes[n.mesh].primitives[0].attributes;
      const paint = accessorData(attrs[sidecar.paint.attribute]);
      const col = doc.accessors[attrs.COLOR_0];
      expect(col.normalized && col.componentType === 5121).toBe(true);
      const view = doc.bufferViews[col.bufferView];
      const ones = paint.filter((v) => v === 1).length;
      expect(paint.every((v) => v === 0 || v === 1)).toBe(true);
      expect(ones).toBeGreaterThan(0);
      paint.forEach((v, i) => {
        if (v === 1) {
          const o = view.byteOffset + (col.byteOffset || 0) + i * view.byteStride;
          expect([bin[o], bin[o + 1], bin[o + 2]]).toEqual([255, 255, 255]);
        }
      });
    }
  });
});

describe.each(BODIES)('%s', (body) => {
  const spec = sidecar.bodies[body];
  const range = RANGES[body];
  const prim = (lod) => meshByNode[`${body}_${lod}`].primitives[0];
  const pos = doc.accessors[prim('lod0').attributes.POSITION];

  it('triangle counts match the sidecar and stay in budget', () => {
    for (const lod of ['lod0', 'lod1']) {
      expect(doc.accessors[prim(lod).indices].count / 3).toBe(spec.triangles[lod]);
    }
    expect(spec.triangles.lod0).toBeGreaterThanOrEqual(400);
    expect(spec.triangles.lod0).toBeLessThanOrEqual(LOD0_MAX[body] ?? 700);
    expect(spec.triangles.lod1).toBeGreaterThanOrEqual(40);
    expect(spec.triangles.lod1).toBeLessThanOrEqual(100);
  });

  it('dimensions are inside the class range, and the mesh matches them', () => {
    for (const k of ['length', 'width', 'height', 'wheelbase']) {
      expect(spec[k]).toBeGreaterThanOrEqual(range[k][0]);
      expect(spec[k]).toBeLessThanOrEqual(range[k][1]);
    }
    for (const lod of ['lod0', 'lod1']) {
      const a = doc.accessors[prim(lod).attributes.POSITION];
      expect(a.min[1]).toBeCloseTo(0, 2);                                   // stands on the ground
      expect(a.max[1]).toBeCloseTo(spec.height, 2);
      expect(a.max[2] - a.min[2]).toBeGreaterThanOrEqual(spec.length - 0.01);
      expect(a.max[2] - a.min[2]).toBeLessThanOrEqual(spec.length + 0.06);  // bumpers stand proud by a few cm
      expect(a.max[0] - a.min[0]).toBeGreaterThanOrEqual(spec.width - 0.01);
      expect(a.max[0] - a.min[0]).toBeLessThanOrEqual(spec.width + 0.45);   // mirrors
      expect(Math.abs(a.max[0] + a.min[0])).toBeLessThan(0.01);             // centred
      expect(Math.abs(a.max[2] + a.min[2])).toBeLessThan(0.05);
    }
  });

  it('has the lamps its class needs', () => {
    const L = spec.lamps;
    for (const k of ['head', 'tail', 'side_marker_front', 'side_marker_rear']) expect(L[k]).toHaveLength(2);
    expect(L.head[0][0]).toBeLessThan(0);                                   // [left, right], left = -X
    expect(L.head[1][0]).toBeGreaterThan(0);
    const wide = spec.width >= 2.032;                                       // 80 in (FMVSS 108)
    expect(L.chmsl === null).toBe(wide);
    if (wide) {
      const kinds = new Set(L.clearance.map((c) => `${c.kind}/${c.color}/${c.facing}`));
      for (const k of ['clearance/amber/front', 'clearance/red/rear', 'identification/amber/front', 'identification/red/rear']) {
        expect(kinds.has(k)).toBe(true);
      }
      expect(L.clearance.filter((c) => c.kind === 'identification' && c.facing === 'rear')).toHaveLength(3);
    } else {
      expect(L.clearance).toEqual([]);
    }
    // FMVSS 108 mounting heights: headlamps 0.56-1.37 m, tail lamps 0.38-1.83 m
    for (const p of L.head) expect(p[1]).toBeGreaterThanOrEqual(0.56), expect(p[1]).toBeLessThanOrEqual(1.37);
    for (const p of L.tail) expect(p[1]).toBeGreaterThanOrEqual(0.38), expect(p[1]).toBeLessThanOrEqual(1.83);
  });

  it('every lamp lies on or just outside the body: inside the bounding box + 5 cm and within 6 cm of the surface', () => {
    const attrs = prim('lod0').attributes;
    const P = accessorData(attrs.POSITION);
    const I = accessorData(prim('lod0').indices);
    for (const lamp of allLamps(spec.lamps)) {
      const p = lamp.p;
      for (let a = 0; a < 3; a++) {
        expect(p[a], `${lamp.name} axis ${a}`).toBeGreaterThanOrEqual(pos.min[a] - 0.05);
        expect(p[a], `${lamp.name} axis ${a}`).toBeLessThanOrEqual(pos.max[a] + 0.05);
      }
      let best = Infinity;
      for (let t = 0; t < I.length; t += 3) best = Math.min(best, pointTriangle(p, P[I[t]], P[I[t + 1]], P[I[t + 2]]));
      expect(best, `${lamp.name} distance to surface`).toBeLessThan(0.06);
      // the lamps that face along the body sit at its ends: head at the front (-Z), tail at the rear
      if (lamp.name.startsWith('head')) expect(p[2]).toBeLessThan(pos.min[2] + 0.25);
      if (lamp.name.startsWith('tail')) expect(p[2]).toBeGreaterThan(pos.max[2] - 0.25);
      if (lamp.name.includes('side marker')) expect(Math.abs(p[0])).toBeGreaterThan(0.8 * spec.width / 2); // a tractor's hood is narrower than its trailer
    }
  });
});

describe('traffic mix and palette', () => {
  it('are flagged as assumptions and their weights sum to 1', () => {
    expect(sidecar.mix.assumed).toBe(true);
    expect(sidecar.palette.assumed).toBe(true);
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(sidecar.mix.light)).toBeCloseTo(1, 6);
    expect(sum(sidecar.mix.truck)).toBeCloseTo(1, 6);
    expect(Object.keys({ ...sidecar.mix.light, ...sidecar.mix.truck }).sort()).toEqual([...BODIES].sort());
    expect(sidecar.palette.colors.length).toBeGreaterThanOrEqual(10);
    expect(sidecar.palette.colors.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(1, 6);
    for (const c of sidecar.palette.colors) expect(c.hex).toMatch(/^[0-9A-F]{6}$/);
  });
});

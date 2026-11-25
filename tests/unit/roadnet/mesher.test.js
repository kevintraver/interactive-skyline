import { describe, it, expect } from 'vitest';
import { meshChunk, rowStations, rowPieces, reflineOf, EMBANKMENT } from '../../../src/drive/roadnet/mesher.js';
import { edgesAt } from '../../../src/drive/roadnet/crosssection.js';
import { KIND, CYCLE } from '../../../src/drive/roadnet/atlas.js';
import { createMesherHandler } from '../../../src/drive/roadnet/mesher.worker.js';
import { fixture, BASE, EARTH_R } from './helpers.js';

const [main, south] = fixture().roads;
const mesh = (args) => meshChunk({ road: main, base: BASE, earthR: EARTH_R, ...args });

/** World (scene) position of vertex i. */
const world = (m, i) => [m.origin[0] + m.positions[3 * i], m.origin[1] + m.positions[3 * i + 1], m.origin[2] + m.positions[3 * i + 2]];
/** Height above sea level of a scene point, with the curvature drop taken back out. */
const height = ([x, y, z]) => y + BASE + (x * x + z * z) / (2 * EARTH_R);

/** Every row of a mesh in order: { s, v (first vertex), pieces, cs }. Rows are emitted span by span. */
function rowsOf(road, m, split = 0) {
  const out = [];
  let v = 0;
  for (const sp of rowStations(road, m.s0, m.s1, m.lod, split)) {
    sp.rows.forEach((s, r) => {
      const cs = edgesAt(road, s, r === sp.rows.length - 1 ? 'before' : 'after');
      const pieces = rowPieces(cs);
      out.push({ s, v, pieces, cs, last: r === sp.rows.length - 1 });
      v += pieces.length * 2;
    });
  }
  return out;
}

/** Vertices of the row at chainage s: [first vertex index, pieces] (the first such row). */
function rowAt(road, m, s, split = 0) {
  const row = rowsOf(road, m, split).find((x) => Math.abs(x.s - s) < 1e-9);
  if (!row) throw new Error(`no row at ${s}`);
  return [row.v, row.pieces];
}

/** Lateral offset (positive left) of a vertex from the reference line at s, in plan. */
function lateral(road, m, i, s) {
  const p = reflineOf(road).at(s);
  const [x, , z] = world(m, i);
  return (x - p.x) * -Math.sin(p.heading) + (-z - p.y) * Math.cos(p.heading);
}

describe('mesher', () => {
  const m = mesh({ s0: 256, s1: 512, lod: 0 });

  it('produces finite, chunk-local buffers of matching sizes', () => {
    const n = m.positions.length / 3;
    expect(m.normals.length).toBe(n * 3);
    expect(m.uvs.length).toBe(n * 2);
    expect(m.kind.length).toBe(n);
    for (const arr of [m.positions, m.normals, m.uvs]) expect(arr.every(Number.isFinite)).toBe(true);
    for (const v of m.positions) expect(Math.abs(v)).toBeLessThan(200); // 55 km out, the GPU sees only this
    expect(Math.hypot(m.origin[0], m.origin[2])).toBeGreaterThan(54000);
    for (const i of m.indices) expect(i).toBeLessThan(n);
    expect(new Set(m.kind)).toEqual(new Set([KIND.lane, KIND.marking, KIND.shoulder, KIND.embankment]));
    expect(m.ranges).toEqual([{ s0: 256, s1: 512, start: 0, count: m.indices.length }]);
  });

  it('faces every triangle up, with unit normals that agree', () => {
    const p = m.positions;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      const u = [p[3 * b] - p[3 * a], p[3 * b + 1] - p[3 * a + 1], p[3 * b + 2] - p[3 * a + 2]];
      const w = [p[3 * c] - p[3 * a], p[3 * c + 1] - p[3 * a + 1], p[3 * c + 2] - p[3 * a + 2]];
      const ny = u[2] * w[0] - u[0] * w[2];
      expect(ny).toBeGreaterThan(0);
      expect(m.normals[3 * a + 1]).toBeGreaterThan(0.4);
      if (m.kind[a] !== KIND.embankment) expect(m.normals[3 * a + 1]).toBeGreaterThan(0.999);
    }
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])).toBeCloseTo(1, 5);
  });

  it('makes the pavement the right width, with crossfall applied and the left edge higher', () => {
    const [v, pieces] = rowAt(main, m, 400);
    const pave = pieces.map((pc, q) => [pc, q]).filter(([pc]) => pc.kind !== KIND.embankment);
    const left = world(m, v + 2 * pave[0][1]), right = world(m, v + 2 * pave[pave.length - 1][1] + 1);
    const plan = Math.hypot(left[0] - right[0], left[2] - right[2]);
    expect(plan).toBeCloseTo(3 * 3.66 + 2 * 3.05, 3);
    // crossfall 2% across the pavement, once the curvature drop (0.5% sideways tilt out here) is taken out
    expect(height(left) - height(right)).toBeCloseTo(0.02 * plan, 3);
  });

  it('builds the embankment: 1 in 4 for 24 m, then 40 m more over 20 m', () => {
    const [v, pieces] = rowAt(main, m, 400);
    const edge = world(m, v + 2 * 1 + 1), slopeFoot = world(m, v + 2 * 1), skirtFoot = world(m, v);
    expect(pieces[0].kind).toBe(KIND.embankment);
    const run1 = Math.hypot(edge[0] - slopeFoot[0], edge[2] - slopeFoot[2]);
    const run2 = Math.hypot(slopeFoot[0] - skirtFoot[0], slopeFoot[2] - skirtFoot[2]);
    expect(run1).toBeCloseTo(EMBANKMENT[0][0], 3);
    expect(height(edge) - height(slopeFoot)).toBeCloseTo(6, 2);
    expect(run2).toBeCloseTo(20, 3);
    expect(height(slopeFoot) - height(skirtFoot)).toBeCloseTo(40, 2);
  });

  it('bakes the curvature drop into the heights against the formula', () => {
    const [v, pieces] = rowAt(main, m, 300);
    // the middle lane of three is centred on the reference line
    const q = pieces.findIndex((pc) => pc.kind === KIND.lane && Math.abs(pc.dl + pc.dr) < 1e-9);
    const a = world(m, v + 2 * q), b = world(m, v + 2 * q + 1);
    const p = reflineOf(main).at(300);
    const drop = (p.x * p.x + p.y * p.y) / (2 * EARTH_R);
    expect(drop).toBeGreaterThan(200);
    expect((a[0] + b[0]) / 2).toBeCloseTo(p.x, 3);
    expect(-(a[2] + b[2]) / 2).toBeCloseTo(p.y, 3);
    expect((a[1] + b[1]) / 2).toBeCloseTo(p.h - BASE - drop, 3);
  });

  it('keys v on chainage so dashes line up across chunks', () => {
    const [v] = rowAt(main, m, 400);
    const vBase = Math.floor(256 / CYCLE) * CYCLE;
    expect(m.uvs[2 * v + 1] * CYCLE + vBase).toBeCloseTo(400, 3);
  });

  it('leaves no cracks between neighbouring chunks at any mix of levels', () => {
    const variants = [0, 1, 2].flatMap((lo) => [0, 1, 2].map((hi) => [lo, hi]));
    for (const [lo, hi] of variants) {
      const a = mesh({ s0: 0, s1: 256, lod: lo }), b = mesh({ s0: 256, s1: 512, lod: hi });
      const [va, pa] = rowAt(main, a, 256), [vb] = rowAt(main, b, 256);
      for (let k = 0; k < pa.length * 2; k++) {
        const p = world(a, va + k), q = world(b, vb + k);
        expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(0.002);
      }
    }
    // and between a long batch at level 2 (split every 256 m) and a fine chunk inside it
    const batch = mesh({ s0: 0, s1: 3000, lod: 2, split: 256 });
    expect(batch.ranges.map((r) => r.s0)).toEqual([0, 256, 512, 768, 1024, 1280, 1536, 1792, 2048, 2304, 2560, 2816]);
    const fine = mesh({ s0: 1536, s1: 1792, lod: 0 });
    for (const s of [1536, 1792]) {
      const [vb, pb] = rowAt(main, batch, s, 256), [vf] = rowAt(main, fine, s);
      // at a split point the batch has the row twice (end of one range, start of the next); compare the first
      for (let k = 0; k < pb.length * 2; k++) {
        const p = world(batch, vb + k), q = world(fine, vf + k);
        expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(0.002);
      }
    }
  });

  it('meshes the coarser levels on subsets of the finer stations', () => {
    const rows = (lod) => rowStations(main, 0, 512, lod).flatMap((sp) => sp.rows);
    const [r0, r1, r2] = [rows(0), rows(1), rows(2)];
    expect(r1.every((s) => r0.includes(s))).toBe(true);
    expect(r2.every((s) => r1.includes(s))).toBe(true);
    expect(r2).toEqual([0, 64, 128, 192, 256, 320, 384, 448, 512]);
  });

  it('splits at a section boundary and at the ends and middle of a taper', () => {
    const c = mesh({ s0: 1536, s1: 1792, lod: 2 });
    const spans = rowStations(main, 1536, 1792, 2);
    expect(spans.map((sp) => [sp.s0, sp.s1])).toEqual([[1536, 1600], [1600, 1728.1], [1728.1, 1792]]);
    const n = rowsOf(main, c).reduce((a, row) => a + row.pieces.length * 2, 0);
    expect(c.positions.length / 3).toBe(n);
  });

  describe('across a taper', () => {
    // lane 4 opens over 1600..1856.2, lane 1 closes over 2143.8..2400
    const chunks = [[1536, 1792], [1792, 2048], [2048, 2304], [2304, 2560]];

    it('makes the pavement exactly as wide as the cross-section at every row, at every level', () => {
      for (const lod of [0, 1, 2]) {
        for (const [a, b] of chunks) {
          const m = mesh({ s0: a, s1: b, lod });
          for (const row of rowsOf(main, m)) {
            const pave = row.pieces.map((pc, q) => [pc, q]).filter(([pc]) => pc.kind !== KIND.embankment);
            const l = lateral(main, m, row.v + 2 * pave[0][1], row.s);
            const r = lateral(main, m, row.v + 2 * pave[pave.length - 1][1] + 1, row.s);
            expect(l).toBeCloseTo(row.cs.left, 3);
            expect(r).toBeCloseTo(row.cs.right, 3);
          }
        }
      }
    });

    it('has no step, slit or fold: rows at a cut coincide, and every row runs left to right', () => {
      for (const [a, b] of chunks) {
        const m = mesh({ s0: a, s1: b, lod: 0 });
        const rows = rowsOf(main, m);
        rows.forEach((row, k) => {
          // across: offsets never turn back (the embankment does not fold over the road)
          const n = row.pieces.length * 2;
          let last = Infinity;
          for (let i = 0; i < n; i++) {
            const d = lateral(main, m, row.v + i, row.s);
            expect(d).toBeLessThanOrEqual(last + 1e-3);
            last = d;
          }
          // a span's last row and the next span's first row are at the same chainage: same outer edges
          const next = rows[k + 1];
          if (row.last && next && Math.abs(next.s - row.s) < 1e-9) {
            for (const [i, j] of [[0, 0], [n - 1, next.pieces.length * 2 - 1]]) {
              const p = world(m, row.v + i), q = world(m, next.v + j);
              expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(0.002);
            }
            expect(row.cs.left).toBeCloseTo(next.cs.left, 9);
            expect(row.cs.right).toBeCloseTo(next.cs.right, 9);
          }
        });
      }
    });

    it('leaves no cracks between chunks inside a taper at any mix of levels', () => {
      for (const [lo, hi] of [0, 1, 2].flatMap((x) => [0, 1, 2].map((y) => [x, y]))) {
        for (const cut of [1792, 2304]) {
          const a = mesh({ s0: cut - 256, s1: cut, lod: lo }), b = mesh({ s0: cut, s1: cut + 256, lod: hi });
          const [va, pa] = rowAt(main, a, cut), [vb, pb] = rowAt(main, b, cut);
          expect(pb.length).toBe(pa.length);
          for (let k = 0; k < pa.length * 2; k++) {
            const p = world(a, va + k), q = world(b, vb + k);
            expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeLessThan(0.002);
          }
        }
      }
    });

    it('meshes the coarser levels on subsets of the finer rows', () => {
      const rows = (lod) => rowStations(main, 1536, 2560, lod).flatMap((sp) => sp.rows);
      const [r0, r1, r2] = [rows(0), rows(1), rows(2)];
      expect(r1.every((s) => r0.includes(s))).toBe(true);
      expect(r2.every((s) => r1.includes(s))).toBe(true);
      for (const s of [1600, 1728.1, 1856.2, 2143.8, 2271.9, 2400]) expect(r2).toContain(s);
    });

    it('drops the line beside a lane narrower than half its width, and keeps one draw', () => {
      const m = mesh({ s0: 1536, s1: 1792, lod: 0 });
      const marks = (s) => rowsOf(main, m).find((row) => Math.abs(row.s - s) < 1e-9 && !row.last)?.pieces.filter((pc) => pc.kind === KIND.marking).length;
      expect(marks(1700)).toBe(4); // two lane lines and two edge lines: lane 4 is still under half
      expect(marks(1728.1)).toBe(5);
      expect(m.ranges).toHaveLength(1);
      for (let i = 0; i < m.normals.length; i += 3) expect(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])).toBeCloseTo(1, 5);
    });
  });

  it('meshes the second road too', () => {
    const c = meshChunk({ road: south, s0: 0, s1: 256, lod: 0, base: BASE, earthR: EARTH_R });
    expect(c.positions.every(Number.isFinite)).toBe(true);
  });

  it('builds a 256 m chunk at the finest level in under 8 ms (Node, as a proxy for the worker)', () => {
    for (let i = 0; i < 20; i++) mesh({ s0: 512, s1: 768, lod: 0 }); // warm up the JIT
    const times = [];
    for (let i = 0; i < 30; i++) {
      const t = performance.now();
      mesh({ s0: 1280 + (i % 3) * 256, s1: 1536 + (i % 3) * 256, lod: 0 });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`chunk build: median ${times[15].toFixed(2)} ms, max ${times[29].toFixed(2)} ms`);
    expect(times[15]).toBeLessThan(8);
  });

  it('answers worker messages with transferable buffers', () => {
    const out = [];
    const handle = createMesherHandler((data, transfer) => out.push({ data, transfer }));
    handle({ type: 'init', roads: [main], base: BASE, earthR: EARTH_R });
    handle({ type: 'mesh', id: 7, road: 0, s0: 0, s1: 256, lod: 1 });
    handle({ type: 'mesh', id: 8, road: 3, s0: 0, s1: 256, lod: 1 });
    expect(out[0].data.id).toBe(7);
    expect(out[0].transfer).toHaveLength(8); // origin, positions, normals, uvs, kind, retro, indices, sphere
    expect(out[0].transfer).toContain(out[0].data.mesh.positions.buffer);
    expect(out[1].data.error).toBeTruthy();
  });
});

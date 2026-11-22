// The corridor mesher (src/drive/corridor/mesher.js) on three footprints: a square on flat ground, a block
// with a courtyard, and a square on a slope; and the worker handler and the triangulator on their own.
import { describe, it, expect } from 'vitest';
import { encodeCell, decodeCell, TYPE } from '../../../src/drive/corridor/format.js';
import { meshCell, groundUnder, SINK, CANOPY_M } from '../../../src/drive/corridor/mesher.js';
import { createCorridorHandler } from '../../../src/drive/corridor/mesher.worker.js';
import { triangulate } from '../../../src/drive/corridor/earcut.js';

const BASE = 620, R = (6371000 * 7) / 6;
const O = [1000, -50000];
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const cellOf = (buildings) => encodeCell({ origin: O, buildings });
const drop = (x, y) => (x * x + y * y) / (2 * R);

/** Every triangle's normal from its winding, in scene axes, and its area. */
function triangles(m) {
  const P = m.positions, out = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]].map((k) => [P[3 * k], P[3 * k + 1], P[3 * k + 2]]);
    const u = b.map((v, j) => v - a[j]), w = c.map((v, j) => v - a[j]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n);
    out.push({ n: n.map((v) => v / l), area: l / 2, verts: [a, b, c], idx: [m.indices[i], m.indices[i + 1], m.indices[i + 2]] });
  }
  return out;
}

describe('corridor mesher', () => {
  it('a square on flat ground: four walls and a roof, facing out and up, standing a metre into the ground', () => {
    const buf = cellOf([{ rings: [sq(990, -50010, 20)], height: 6, type: TYPE.house, rung: 3 }]);
    const flat = () => 700;
    const { groundMin, groundMean } = groundUnder(decodeCell(buf), flat);
    const m = meshCell({ buf, groundMin, groundMean, base: BASE, earthR: R });
    expect(m.buildings).toBe(1);
    expect(m.triangles).toBe(4 * 2 + 2);
    expect(m.origin).toEqual([O[0], 0, -O[1]]);
    const tris = triangles(m);
    const roof = tris.filter((t) => t.n[1] > 0.99), walls = tris.filter((t) => Math.abs(t.n[1]) < 1e-6);
    expect(roof.reduce((a, t) => a + t.area, 0)).toBeCloseTo(400, 1); // the roof follows the curvature: a hair over 400
    expect(walls.length).toBe(8);
    // each wall faces away from the footprint's centre (scene x = 0, z = 0 here)
    for (const t of walls) {
      const c = [0, 1, 2].map((j) => (t.verts[0][j] + t.verts[1][j] + t.verts[2][j]) / 3);
      expect(c[0] * t.n[0] + c[2] * t.n[2]).toBeGreaterThan(0);
      // and the stored normals agree with the winding
      for (const k of t.idx) expect(m.normals[3 * k] * t.n[0] + m.normals[3 * k + 2] * t.n[2]).toBeCloseTo(1, 5);
    }
    const ys = Array.from({ length: m.positions.length / 3 }, (_, k) => m.positions[3 * k + 1]);
    const d = drop(1000, -50000);
    expect(Math.min(...ys)).toBeCloseTo(700 - SINK - BASE - drop(990, -50010), 2);
    expect(Math.max(...ys)).toBeCloseTo(706 - BASE - d + 0.05, 1);
    // the sphere holds every vertex
    const [sx, sy, sz, r] = m.sphere;
    for (let k = 0; k < m.positions.length; k += 3) expect(Math.hypot(m.positions[k] - sx, m.positions[k + 1] - sy, m.positions[k + 2] - sz)).toBeLessThanOrEqual(r + 1e-6);
  });

  it('a block with a courtyard: the roof leaves the hole open and the hole walls face into it', () => {
    const outer = sq(900, -50100, 60), hole = [[920, -50080], [920, -50060], [940, -50060], [940, -50080]]; // clockwise
    const buf = cellOf([{ rings: [outer, hole], height: 10, type: TYPE.warehouse, rung: 2 }]);
    const { groundMin, groundMean } = groundUnder(decodeCell(buf), () => 650);
    const m = meshCell({ buf, groundMin, groundMean, base: BASE, earthR: R });
    const tris = triangles(m);
    const roofArea = tris.filter((t) => t.n[1] > 0.99).reduce((a, t) => a + t.area, 0);
    expect(Math.abs(roofArea - 3200)).toBeLessThan(0.2);
    const walls = tris.filter((t) => Math.abs(t.n[1]) < 1e-6);
    expect(walls.length).toBe(2 * (4 + 4));
    // the courtyard's centre in mesh coordinates: map (930, -50070) -> (930 - 1000, -(-50070 + 50000))
    const hc = [-70, 70];
    const inner = walls.filter((t) => t.verts.every(([x, , z]) => x >= -80.01 && x <= -59.99 && z >= 59.99 && z <= 80.01));
    expect(inner.length).toBe(8);
    for (const t of inner) {
      const c = [0, 2].map((j) => (t.verts[0][j] + t.verts[1][j] + t.verts[2][j]) / 3);
      expect((c[0] - hc[0]) * t.n[0] + (c[1] - hc[1]) * t.n[2]).toBeLessThan(0);
    }
  });

  it('a square on a slope: the base is a metre under its lowest corner, the roof over the mean ground', () => {
    const buf = cellOf([{ rings: [sq(1000, -50000, 30)], height: 8, type: TYPE.other, rung: 2 }]);
    const slope = (x) => 700 + 0.1 * (x - 1000); // 3 m across the footprint
    const cell = decodeCell(buf);
    const { groundMin, groundMean } = groundUnder(cell, slope);
    expect(groundMin[0]).toBeCloseTo(700, 4);
    expect(groundMean[0]).toBeCloseTo(701.5, 4);
    const m = meshCell({ buf, groundMin, groundMean, base: BASE, earthR: R });
    for (let k = 0; k < m.positions.length; k += 3) {
      const mx = m.positions[k] + O[0], my = -m.positions[k + 2] + O[1];
      const h = m.positions[k + 1] + BASE + drop(mx, my);
      // every vertex is on the base or on the roof; no wall foot is above the ground beneath it
      expect(Math.min(Math.abs(h - (700 - SINK)), Math.abs(h - 709.5))).toBeLessThan(1e-3);
      if (h < 705) expect(h).toBeLessThan(slope(mx));
    }
  });

  it('a canopy is a slab, with an underside', () => {
    const buf = cellOf([{ rings: [sq(1000, -50000, 20)], height: 5, type: TYPE.canopy, rung: 3 }]);
    const { groundMin, groundMean } = groundUnder(decodeCell(buf), () => 700);
    const m = meshCell({ buf, groundMin, groundMean, base: BASE, earthR: R });
    const tris = triangles(m);
    expect(tris.filter((t) => t.n[1] < -0.99).length).toBe(2);
    const hs = Array.from({ length: m.positions.length / 3 }, (_, k) => m.positions[3 * k + 1] + BASE + drop(m.positions[3 * k] + O[0], -m.positions[3 * k + 2] + O[1]));
    expect(Math.min(...hs)).toBeCloseTo(705 - CANOPY_M, 3);
  });

  it('the worker handler meshes a cell and reports the time, or an error', () => {
    const posts = [];
    const handle = createCorridorHandler((data, transfer) => posts.push({ data, transfer }));
    const buf = cellOf([{ rings: [sq(990, -50010, 20)], height: 6, type: TYPE.house, rung: 3 }]);
    handle({ type: 'mesh', id: 7, buf, groundMin: new Float32Array([700]), groundMean: new Float32Array([700]), base: BASE, earthR: R });
    expect(posts[0].data.id).toBe(7);
    expect(posts[0].data.mesh.triangles).toBe(10);
    expect(posts[0].transfer.length).toBe(5);
    handle({ type: 'mesh', id: 8, buf: new ArrayBuffer(4) });
    expect(posts[1].data.error).toMatch(/corridor/);
  });

  it('triangulates a concave outline with two holes, covering its area exactly', () => {
    const outer = [0, 0, 100, 0, 100, 100, 50, 40, 0, 100];
    const holes = [20, 10, 30, 10, 30, 20, 20, 20, 70, 10, 80, 10, 80, 20, 70, 20];
    const t = triangulate([...outer, ...holes], [5, 9]);
    let a = 0;
    const p = [...outer, ...holes];
    for (let i = 0; i < t.length; i += 3) {
      const [x0, y0, x1, y1, x2, y2] = [p[2 * t[i]], p[2 * t[i] + 1], p[2 * t[i + 1]], p[2 * t[i + 1] + 1], p[2 * t[i + 2]], p[2 * t[i + 2] + 1]];
      a += Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
    }
    const shoelace = (r) => Math.abs(r.reduce((s, _, i) => (i % 2 ? s : s + r[i] * r[(i + 3) % r.length] - r[(i + 2) % r.length] * r[i + 1]), 0)) / 2;
    expect(a).toBeCloseTo(shoelace(outer) - 200, 6);
  });
});

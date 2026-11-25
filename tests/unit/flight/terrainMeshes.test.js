// The drawn nested terrain's geometry (plan 03, sections 7.9 and 9.1; F4.7): chunks, holes where a finer grid is drawn,
// the ring sunk under the map's far mesh, skirts, the datum's curve and its tilt in the normals, and the stride choice.
// Pure: the arrays meshes.js hands to three.js.
import { describe, expect, it } from 'vitest';
import {
  CHUNK, STRIDES, SINK, holeBreaks, axisLines, planChunks, chunkIndices, chunkVertices, edgeDeviation, chooseStrides,
  outerGroundArrays, MIN_SKIRT, perimeterSkirt,
} from '../../../src/flight/terrain/meshes.js';
import { gridField } from '../../../src/flight/terrain/nested.js';
import { curveDrop, EFFECTIVE_RADIUS } from '../../../src/core/earth.js';

/** A synthetic grid: heights from f(x, y), quantised as the encoder does. */
function synth({ nx, ny, x0 = 0, y0 = 0, step = 100, scale = 0.1, offset = -500, f = () => 1000 }) {
  const q = new Uint16Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) q[j * nx + i] = Math.round((f(x0 + i * step, y0 + j * step) - offset) / scale);
  return gridField({ nx, ny, x0, y0, step, scale, offset, q });
}
const BASE = 620;

/** Every surface triangle of a grid as drawn at one stride, in map metres: [[x, y, sceneY] x 3]. */
function drawn(g, holes, stride, { skirts = false } = {}) {
  const breaks = holeBreaks(g, holes), cx = 0, cy = 0, tris = [];
  for (const c of planChunks(g, holes)) {
    const ix = chunkIndices(g, c, holes, breaks);
    const v = chunkVertices(g, c, { base: BASE, cx, cy, holes, bottoms: ix.bottoms, skirt: 50 });
    const r = ix.ranges.find((x) => x.stride === stride);
    const from = skirts ? r.start + r.surface * 3 : r.start, to = skirts ? r.start + r.count : r.start + r.surface * 3;
    for (let k = from; k < to; k += 3) {
      tris.push([0, 1, 2].map((m) => { const p = ix.index[k + m] * 3; return [v.position[p] + cx, cy - v.position[p + 2], v.position[p + 1]]; }));
    }
  }
  return tris;
}
const inTri = ([x, y], t) => {
  const [[ax, ay], [bx, by], [cx, cy]] = t;
  const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / d, v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / d;
  return u >= -1e-9 && v >= -1e-9 && 1 - u - v >= -1e-9;
};
const cover = (tris, p) => tris.filter((t) => inTri(p, t)).length;
/** A deterministic scatter of points. */
function scatter(n, x0, x1, y0, y1) {
  let s = 12345;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, () => [x0 + r() * (x1 - x0), y0 + r() * (y1 - y0)]);
}

describe('planning a grid into chunks', () => {
  it('cuts 128-cell chunks from the south-west post, the last ones smaller', () => {
    const g = synth({ nx: 300, ny: 140 });
    const c = planChunks(g);
    expect(c.length).toBe(3 * 2);
    expect(c[0]).toMatchObject({ i0: 0, i1: CHUNK, j0: 0, j1: CHUNK });
    expect(c[2]).toMatchObject({ i0: 256, i1: 299 });
    expect(c[5]).toMatchObject({ j0: 128, j1: 139 });
  });

  it('leaves out a chunk wholly inside a hole', () => {
    const g = synth({ nx: 513, ny: 513 });
    const hole = { x0: 100 * 128, x1: 100 * 384, y0: 100 * 128, y1: 100 * 384 };
    expect(planChunks(g, [hole]).length).toBe(16 - 4);
  });

  it('keeps the lines of every hole edge at every stride, on and off the posts', () => {
    const g = synth({ nx: 129, ny: 129 });
    const { bx, by } = holeBreaks(g, [{ x0: 1000, x1: 3730, y0: 2050, y1: 5000 }]);
    expect(bx).toEqual([10, 37, 38]); // 3,730 m lies between posts 37 and 38
    expect(by).toEqual([20, 21, 50]);
    expect(axisLines(0, 128, 16, bx)).toEqual([0, 10, 16, 32, 37, 38, 48, 64, 80, 96, 112, 128]);
  });
});

describe('holes where a finer grid is drawn', () => {
  // a parent with a child on its posts but not on its stride-4 or stride-16 lines (as valley sits in approaches)
  const g = synth({ nx: 201, ny: 161, f: (x, y) => 1000 + 300 * Math.sin(x / 1700) * Math.cos(y / 2300) });
  const child = { x0: 1000 * 3.7, x1: 100 * 151, y0: 100 * 33, y1: 100 * 129 }; // posts 37..151 x 33..129
  const pts = scatter(4000, 0, 20000, 0, 16000);

  for (const s of STRIDES) {
    it(`at stride ${s} draws every point outside the child once and none inside`, () => {
      const tris = drawn(g, [child], s);
      for (const p of pts) {
        const inChild = p[0] > child.x0 && p[0] < child.x1 && p[1] > child.y0 && p[1] < child.y1;
        expect(cover(tris, p), `(${p[0].toFixed(0)}, ${p[1].toFixed(0)}) inside ${inChild}`).toBe(inChild ? 0 : 1);
      }
    });
  }

  it('shares the child\'s edge with it at stride 1: the parent\'s edge posts are the parent\'s heights', () => {
    const tris = drawn(g, [child], 1);
    const onEdge = tris.flat().filter(([x, y]) => (Math.abs(x - child.x0) < 1e-3 || Math.abs(x - child.x1) < 1e-3) && y >= child.y0 && y <= child.y1);
    expect(onEdge.length).toBeGreaterThan(100);
    for (const [x, y, Y] of onEdge) expect(Y).toBeCloseTo(g.sample(x, y) - BASE - curveDrop(x, y), 1);
  });
});

describe('the ring under the map\'s far mesh', () => {
  // valley's posts are 128 m; far's edges are not on them (only its west edge is)
  const g = synth({ nx: 257, ny: 257, x0: -60416, y0: -64000, step: 128, f: (x, y) => 900 + 100 * Math.sin(x / 3000) });
  const far = { x0: -48000, x1: -30000, y0: -34000, y1: -20000, sink: SINK };

  it('draws the cells that straddle far\'s edge and leaves out those inside it', () => {
    const tris = drawn(g, [far], 1);
    // a point just inside far's edge is still on valley's ring; one a cell further in is not drawn
    expect(cover(tris, [-40000, -34000 + 50])).toBe(1);
    expect(cover(tris, [-40000, -34000 + 300])).toBe(0);
    expect(cover(tris, [-48000 + 50, -32030])).toBe(0); // the west edge lies on valley's posts: no ring there
    expect(cover(tris, [-48000 - 50, -32030])).toBe(1);
  });

  it(`sinks valley's posts inside far by ${SINK} m and no others`, () => {
    const holes = [far], breaks = holeBreaks(g, holes);
    let sunk = 0, level = 0;
    for (const c of planChunks(g, holes)) {
      const ix = chunkIndices(g, c, holes, breaks);
      const v = chunkVertices(g, c, { base: BASE, cx: 0, cy: 0, holes, bottoms: [] });
      for (let j = c.j0; j <= c.j1; j++) for (let i = c.i0; i <= c.i1; i++) {
        const k = ((j - c.j0) * (c.i1 - c.i0 + 1) + (i - c.i0)) * 3, x = g.x0 + i * g.step, y = g.y0 + j * g.step;
        const d = g.at(i, j) - BASE - curveDrop(x, y) - v.position[k + 1];
        const inside = x > far.x0 && x < far.x1 && y > far.y0 && y < far.y1;
        expect(d, `${i},${j}`).toBeCloseTo(inside ? SINK : 0, 3);
        if (inside) sunk++; else level++;
      }
      expect(ix.index.length).toBeGreaterThan(0);
    }
    expect(sunk).toBeGreaterThan(0);
    expect(level).toBeGreaterThan(sunk);
  });
});

describe('skirts', () => {
  const g = synth({ nx: 201, ny: 161, f: (x, y) => 1000 + 300 * Math.sin(x / 1700) * Math.cos(y / 2300) });
  const child = { x0: 3700, x1: 15100, y0: 3300, y1: 12900 };

  for (const s of [1, 4, 16]) {
    it(`at stride ${s} hang a wall ${50} m deep from every open edge of each chunk's surface, and only there`, () => {
      const holes = [child], breaks = holeBreaks(g, holes);
      for (const c of planChunks(g, holes)) {
        const ix = chunkIndices(g, c, holes, breaks);
        const v = chunkVertices(g, c, { base: BASE, cx: 0, cy: 0, holes, bottoms: ix.bottoms, skirt: 50 });
        const posts = (c.i1 - c.i0 + 1) * (c.j1 - c.j0 + 1);
        const r = ix.ranges.find((x) => x.stride === s);
        const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
        const uses = new Map();
        for (let k = r.start; k < r.start + r.surface * 3; k += 3) {
          for (let m = 0; m < 3; m++) { const e = key(ix.index[k + m], ix.index[k + (m + 1) % 3]); uses.set(e, (uses.get(e) || 0) + 1); }
        }
        const open = new Set([...uses].filter(([, n]) => n === 1).map(([e]) => e));
        const tops = new Set();
        for (let k = r.start + r.surface * 3; k < r.start + r.count; k += 6) {
          const [p, pb, q, q2, pb2, qb] = ix.index.slice(k, k + 6);
          expect(p).toBeLessThan(posts); expect(q).toBeLessThan(posts);
          expect(pb).toBeGreaterThanOrEqual(posts); expect(qb).toBeGreaterThanOrEqual(posts);
          expect([q2, pb2]).toEqual([q, pb]);
          expect(v.position[p * 3 + 1] - v.position[pb * 3 + 1]).toBeCloseTo(50, 3);
          expect(v.position[pb * 3]).toBe(v.position[p * 3]);
          tops.add(key(p, q));
        }
        expect([...tops].sort()).toEqual([...open].sort());
      }
    });
  }

  it('face away from the cell they hang from', () => {
    const flat = synth({ nx: 9, ny: 9, f: () => 700 });
    const c = planChunks(flat)[0];
    const ix = chunkIndices(flat, c, [], { bx: [], by: [] }, [1]);
    const v = chunkVertices(flat, c, { base: BASE, cx: 400, cy: 400, bottoms: ix.bottoms, skirt: 50 });
    const r = ix.ranges[0];
    for (let k = r.start + r.surface * 3; k < r.start + r.count; k += 3) {
      const [a, b, d] = [0, 1, 2].map((m) => { const p = ix.index[k + m] * 3; return [v.position[p], v.position[p + 1], v.position[p + 2]]; });
      const e1 = b.map((x, m) => x - a[m]), e2 = d.map((x, m) => x - a[m]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const mid = [(a[0] + b[0] + d[0]) / 3, (a[2] + b[2] + d[2]) / 3]; // relative to the grid's centre: outward is away from 0
      expect(n[0] * mid[0] + n[2] * mid[1]).toBeGreaterThan(0);
    }
  });

  it('hang deeper where the coarsest stride strays further from the posts', () => {
    const flat = synth({ nx: 129, ny: 129, f: () => 700 });
    const rough = synth({ nx: 129, ny: 129, f: (x) => 700 + 200 * Math.sin(x / 300) });
    const c = planChunks(flat)[0];
    expect(edgeDeviation(flat, c)).toBeLessThan(0.1);
    expect(edgeDeviation(rough, c)).toBeGreaterThan(100);
    expect(MIN_SKIRT).toBeGreaterThan(26); // more than valley and far ever disagree
  });
});

describe('the datum\'s curve', () => {
  it('lowers a post 370 km out by curveDrop, 9.2 km on the app\'s 7/6 radius', () => {
    const g = synth({ nx: 129, ny: 129, x0: -6400, y0: 370000 - 6400, f: () => 1500 });
    const c = planChunks(g)[0];
    const cx = g.x0 + 64 * g.step, cy = g.y0 + 64 * g.step;
    const v = chunkVertices(g, c, { base: BASE, cx, cy });
    const k = (64 * 129 + 64) * 3; // the post at (0, 370 km)
    expect(v.position[k]).toBeCloseTo(0, 6);
    expect(v.position[k + 1]).toBeCloseTo(1500 - BASE - 9209.2, 0);
    expect(1500 - BASE - v.position[k + 1]).toBeCloseTo(curveDrop(0, 370000), 3);
  });

  it('leans the normals of level ground with the datum (localUp)', () => {
    const g = synth({ nx: 129, ny: 129, x0: 200000, y0: -300000, f: () => 1500 });
    const c = planChunks(g)[0];
    const v = chunkVertices(g, c, { base: BASE, cx: 0, cy: 0 });
    const k = (40 * 129 + 70) * 3, x = g.x0 + 70 * g.step, y = g.y0 + 40 * g.step;
    const l = Math.hypot(x, EFFECTIVE_RADIUS, y);
    expect(v.normal[k]).toBeCloseTo(x / l, 4);
    expect(v.normal[k + 1]).toBeCloseTo(EFFECTIVE_RADIUS / l, 4);
    expect(v.normal[k + 2]).toBeCloseTo(-y / l, 4); // scene z is south
  });
});

describe('choosing strides', () => {
  const ranges = STRIDES.map((s) => ({ stride: s, surface: 2 * (128 / s) ** 2, skirt: 8 * (128 / s) }));
  const chunk = (x, step = 128) => ({ step, ranges, box: { min: [x, 0, 0], max: [x + 128 * step, 100, 128 * step] } });

  it('draws the chunk under the eye at stride 1 and a chunk far off coarser', () => {
    const { strides } = chooseStrides([chunk(0), chunk(200000)], { eye: [100, 3000, 100], focalPx: 1000, budget: 1e9 });
    expect(strides[0]).toBe(1);
    expect(strides[1]).toBeGreaterThan(1);
  });

  it('aims at four pixels a cell: 128 m cells at 64 km are 2 px at stride 1, 4 px at stride 2', () => {
    const { strides } = chooseStrides([chunk(64000)], { eye: [0, 0, 64000], focalPx: 1000, budget: 1e9 });
    expect(strides[0]).toBe(2);
  });

  it('coarsens until the budget holds', () => {
    const cs = Array.from({ length: 30 }, (_, k) => chunk(k * 16384));
    const free = chooseStrides(cs, { eye: [0, 2000, 0], focalPx: 1500, budget: 1e9 });
    const held = chooseStrides(cs, { eye: [0, 2000, 0], focalPx: 1500, budget: free.triangles / 3 });
    expect(held.triangles).toBeLessThanOrEqual(free.triangles / 3);
    expect(held.targetPx).toBeGreaterThan(free.targetPx);
  });

  it('draws nothing for a chunk out of view', () => {
    const { strides, triangles } = chooseStrides([chunk(0)], { eye: [0, 0, 0], focalPx: 1000, budget: 1e9, visible: [false] });
    expect(strides[0]).toBe(0);
    expect(triangles).toBe(0);
  });
});

describe('the ground beyond region', () => {
  const region = synth({ nx: 65, ny: 65, x0: -524288, y0: -524288, step: 16384, f: (x) => 800 + x / 1000 });

  it('starts tucked just under region\'s edge and falls with the curve out to a million metres beyond it', () => {
    const a = outerGroundArrays(region, BASE, { per: 16 });
    const P = 64;
    for (let k = 0; k < P; k++) {
      const x = a.position[k * 3] + a.cx, y = a.cy - a.position[k * 3 + 2];
      expect(a.position[k * 3 + 1]).toBeCloseTo(region.sample(x, y) - BASE - curveDrop(x, y) - 20, 2); // float32
    }
    const last = a.position.length / 3 - P;
    const x = a.position[last * 3] + a.cx, y = a.cy - a.position[last * 3 + 2];
    expect(Math.max(Math.abs(x), Math.abs(y))).toBeCloseTo(1524288, -1);
    expect(a.position[last * 3 + 1]).toBeCloseTo(a.mean - BASE - curveDrop(x, y), 1);
  });

  it('faces up', () => {
    const a = outerGroundArrays(region, BASE, { per: 4 });
    for (let k = 0; k < a.index.length; k += 3) {
      const [p, q, r] = [0, 1, 2].map((m) => [0, 1, 2].map((c) => a.position[a.index[k + m] * 3 + c]));
      const e1 = q.map((v, m) => v - p[m]), e2 = r.map((v, m) => v - p[m]);
      expect(e1[2] * e2[0] - e1[0] * e2[2]).toBeGreaterThan(0);
    }
  });
});

describe('the skirt hung from the map\'s far grid', () => {
  // a far-like grid as the map's provider holds it (heightfield.js: raw * scale, no offset), off valley's posts
  const nx = 7, ny = 5, raw = new Uint16Array(nx * ny);
  for (let k = 0; k < raw.length; k++) raw[k] = 6000 + 37 * k;
  const far = { nx, ny, x0: -48000, y0: -34000, step: 80, scale: 0.1, raw, at: (i, j) => raw[j * nx + i] * 0.1 };

  it('starts at the far mesh\'s own edge posts, as the map builds them, and hangs 50 m', () => {
    const a = perimeterSkirt(far, { base: BASE, cx: 1000, cy: -2000, depth: 50 });
    const P = 2 * (nx - 1) + 2 * (ny - 1);
    expect(a.position.length).toBe(P * 2 * 3);
    for (let k = 0; k < P; k++) {
      const x = a.position[k * 6] + 1000, y = -2000 - a.position[k * 6 + 2];
      const i = Math.round((x - far.x0) / far.step), j = Math.round((y - far.y0) / far.step);
      expect(i === 0 || i === nx - 1 || j === 0 || j === ny - 1).toBe(true);
      expect(a.position[k * 6 + 1]).toBeCloseTo(far.at(i, j) - BASE - curveDrop(x, y), 2);
      expect(a.position[k * 6 + 1] - a.position[k * 6 + 4]).toBeCloseTo(50, 3);
    }
  });

  it('faces out, away from the far grid', () => {
    const a = perimeterSkirt(far, { base: BASE, cx: -48000 + 240, cy: -34000 + 160, depth: 50 });
    for (let k = 0; k < a.index.length; k += 3) {
      const [p, q, r] = [0, 1, 2].map((m) => [0, 1, 2].map((c) => a.position[a.index[k + m] * 3 + c]));
      const e1 = q.map((v, m) => v - p[m]), e2 = r.map((v, m) => v - p[m]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const mid = [(p[0] + q[0] + r[0]) / 3, (p[2] + q[2] + r[2]) / 3]; // relative to the far grid's centre
      expect(n[0] * mid[0] + n[2] * mid[1]).toBeGreaterThan(0);
    }
  });
});

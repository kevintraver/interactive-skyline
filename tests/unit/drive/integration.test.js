// Pure pieces of the Drive integration: the skirt under terrain edges, the sight-line march, the look
// rule and the rolling timings.
import { describe, it, expect } from 'vitest';
import { skirtArrays } from '../../../src/world/terrain/skirt.js';
import { sightOverGround } from '../../../src/drive/sightline.js';
import { isNightAt, NIGHT_BELOW } from '../../../src/drive/look.js';
import { createTimings } from '../../../src/drive/timing.js';

/** A grid laid out as terrainMesh() lays it out: post (i, j) at x = i * step, scene z = -j * step. */
function grid(nx, ny, step = 10, h = (i, j) => i + j) {
  const positions = [], normals = [], uvs = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      positions.push(i * step, h(i, j), -j * step);
      normals.push(0, 1, 0);
      uvs.push(i / (nx - 1), j / (ny - 1));
    }
  }
  return { positions, normals, uvs, nx, ny };
}

describe('skirtArrays', () => {
  const g = grid(4, 3);
  const a = skirtArrays({ ...g, depth: 16 });
  const P = 2 * (g.nx - 1) + 2 * (g.ny - 1);
  const v = (k) => [a.positions[k * 3], a.positions[k * 3 + 1], a.positions[k * 3 + 2]];

  it('has a top and a bottom vertex for every perimeter post, corners once', () => {
    expect(a.positions.length).toBe(P * 2 * 3);
    expect(a.indices.length).toBe(P * 6);
    const tops = new Set();
    for (let k = 0; k < P; k++) {
      const top = v(2 * k), bot = v(2 * k + 1);
      expect(bot[0]).toBe(top[0]);
      expect(bot[2]).toBe(top[2]);
      expect(top[1] - bot[1]).toBeCloseTo(16, 5);
      tops.add(top.join(','));
    }
    expect(tops.size).toBe(P);
  });

  it('hangs from the grid posts themselves, with their uv and normal', () => {
    for (let k = 0; k < P; k++) {
      const [x, y, z] = v(2 * k);
      const i = x / 10, j = -z / 10;
      expect(Number.isInteger(i) && Number.isInteger(j)).toBe(true);
      expect(i === 0 || i === g.nx - 1 || j === 0 || j === g.ny - 1).toBe(true);
      expect(y).toBe(i + j);
      expect(a.uvs[2 * k * 2]).toBeCloseTo(i / (g.nx - 1), 6);
      expect(a.normals[2 * k * 3 + 1]).toBe(1);
    }
  });

  it('faces outward, away from the grid, all the way round', () => {
    const cx = 15, cz = -10; // the grid's middle
    for (let t = 0; t < a.indices.length; t += 3) {
      const [p, q, r] = [0, 1, 2].map((c) => v(a.indices[t + c]));
      const u = q.map((x, c) => x - p[c]), w = r.map((x, c) => x - p[c]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const mid = [0, 2].map((c) => (p[c] + q[c] + r[c]) / 3);
      const out = [mid[0] - cx, mid[1] - cz];
      expect(n[0] * out[0] + n[2] * out[1]).toBeGreaterThan(0);
      expect(Math.abs(n[1])).toBeLessThan(1e-9); // a vertical curtain
    }
  });
});

describe('sightOverGround', () => {
  const flat = () => 0;
  const from = { x: 0, y: 1.2, z: 0 };

  it('clears flat ground to a raised target', () => {
    expect(sightOverGround(from, { x: 0, y: 300, z: -40000 }, flat).clear).toBe(true);
  });

  it('is blocked by a ridge in between, and clears it once the target stands high enough', () => {
    const ridge = (x, y) => (Math.abs(y - 10000) < 200 ? 100 : 0); // map y north = -z
    expect(sightOverGround(from, { x: 0, y: 300, z: -40000 }, ridge).clear).toBe(false);
    expect(sightOverGround(from, { x: 0, y: 600, z: -40000 }, ridge).clear).toBe(true);
  });

  it('ignores the ground under the eye and reports the worst clearance', () => {
    const bump = (x, y) => (Math.hypot(x, y) < 1.5 ? 50 : 0);
    const r = sightOverGround(from, { x: 0, y: 1.2, z: -1000 }, bump);
    expect(r.clear).toBe(true);
    expect(r.worst).toBeCloseTo(1.2, 6);
  });
});

describe('isNightAt', () => {
  it('switches to the night look 1.5 degrees below the horizon', () => {
    expect(NIGHT_BELOW).toBe(1.5);
    expect(isNightAt(10)).toBe(false);
    expect(isNightAt(-1.4)).toBe(false);
    expect(isNightAt(-1.6)).toBe(true);
    expect(isNightAt(-30)).toBe(true);
  });
});

describe('createTimings', () => {
  it('summarises a rolling window', () => {
    const t = createTimings(20);
    for (let i = 1; i <= 100; i++) t.add(i);
    const s = t.summary();
    expect(s.count).toBe(20);
    expect(s.last).toBe(100);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(90.5, 9);
    expect(s.p95).toBe(99);
    t.reset();
    expect(t.summary().count).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { createRefline } from '../../../src/drive/roadnet/refline.js';
import { fixture } from './helpers.js';
import { heightA } from '../../fixtures/roadnet/synthetic.js';

const road = fixture().roads[0];
const ref = createRefline(road);

/** Length of the curve between s0 and s1 walked in 1 cm steps. */
function walk(s0, s1) {
  const p = {}, q = {};
  ref.at(s0, p);
  let len = 0;
  for (let s = s0 + 0.01; s <= s1 + 1e-9; s += 0.01) {
    ref.at(s, q);
    len += Math.hypot(q.x - p.x, q.y - p.y);
    p.x = q.x; p.y = q.y;
  }
  return len;
}

describe('refline', () => {
  it('passes through every station with its heading', () => {
    const p = {};
    for (const i of [0, 1, 200, 400, 750]) {
      ref.at(i * 4, p);
      expect(p.x).toBe(road.x[i]);
      expect(p.y).toBe(road.y[i]);
      expect(p.heading).toBeCloseTo(road.heading[i], 9);
    }
    expect(ref.length).toBe(3000);
  });

  it('is continuous in position and tangent across stations', () => {
    const a = {}, b = {};
    for (let i = 1; i < 750; i += 7) {
      ref.at(i * 4 - 1e-7, a);
      ref.at(i * 4 + 1e-7, b);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-5);
      expect(Math.abs(a.heading - b.heading)).toBeLessThan(1e-6);
      expect(Math.abs(a.h - b.h)).toBeLessThan(1e-5);
      expect(Math.abs(a.grade - b.grade)).toBeLessThan(1e-5);
    }
  });

  it('measures honest arc length: 100 m of s is 100 m of curve to within 1 cm', () => {
    for (const s0 of [10, 790, 1000, 1513.3, 2850]) {
      expect(Math.abs(walk(s0, s0 + 100) - 100)).toBeLessThan(0.01);
    }
  });

  it('reports heading, curvature, grade and crossfall', () => {
    const p = ref.at(1200);
    expect(p.curvature).toBeCloseTo(1 / 600, 8);
    expect(p.crossfall).toBeCloseTo(-0.03, 6);
    ref.at(1700, p);
    expect(p.grade).toBeCloseTo(0.04, 4);
    expect(p.h).toBeCloseTo(heightA(1700), 3);
    ref.at(500, p);
    expect(p.grade).toBeCloseTo(0, 6);
    expect(p.heading).toBeCloseTo(0.6, 6);
    // heading changes by the integral of curvature through the curve
    expect(ref.at(1632).heading - ref.at(788).heading).toBeCloseTo((700 + 60) / 600, 6);
    // between stations the tangent wobbles only by millimetre rounding of positions (0.5 mm / 4 m)
    for (let s = 1; s < 3000; s += 7.3) expect(Math.abs(ref.at(s).heading - ref.at(Math.round(s / 4) * 4).heading)).toBeLessThan(2.5e-4 + 4 / 600);
  });

  it('clamps s to the road', () => {
    expect(ref.at(-5).s).toBe(0);
    expect(ref.at(1e6).x).toBe(road.x[750]);
  });
});

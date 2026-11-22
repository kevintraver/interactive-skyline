import { describe, it, expect } from 'vitest';
import { simplify, routeShape } from '../../../src/drive/ui/routemap.js';
import { fixture } from './helpers.js';

describe('simplify', () => {
  it('keeps the ends and the corners, drops points on a straight line', () => {
    const pts = [[0, 0], [1, 0.01], [2, 0], [3, 0], [3, 1], [3, 2]];
    expect(simplify(pts, 0.1)).toEqual([[0, 0], [3, 0], [3, 2]]);
  });
});

describe('routeShape', () => {
  // an L-shaped road, 4 m stations: 4 km east, then 4 km north, 8 km south-west of the origin
  const x = [], y = [];
  for (let i = 0; i <= 1000; i++) { x.push(-8000 + i * 4); y.push(-8000); }
  for (let i = 1; i <= 1000; i++) { x.push(-4000); y.push(-8000 + i * 4); }
  const road = { x, y, spacing: 4 };

  it('draws north up inside the box, with the origin in frame', () => {
    const shape = routeShape(road, { size: 64, pad: 4 });
    expect(shape.points).toBe(3);
    const [sx, sy] = shape.at(0), [cx, cy] = shape.at(4000), [ex, ey] = shape.at(8000);
    expect(cx).toBeGreaterThan(sx); // east is right
    expect(ey).toBeLessThan(cy); // north is up
    expect(ex).toBeCloseTo(cx, 6);
    const [ox, oy] = shape.mark(0, 0);
    for (const v of [sx, sy, ex, ey, ox, oy]) { expect(v).toBeGreaterThanOrEqual(4 - 1e-9); expect(v).toBeLessThanOrEqual(60 + 1e-9); }
    expect(shape.d).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
  });

  it('decimates a real road to a few dozen points and follows it', () => {
    const { roadnet } = fixture();
    const r = roadnet.roads[0];
    const shape = routeShape(r, {});
    expect(shape.points).toBeGreaterThanOrEqual(2);
    expect(shape.points).toBeLessThan(200);
    const mid = Math.floor(r.count / 2);
    expect(shape.at(mid * r.spacing)).toEqual(shape.mark(r.x[mid], r.y[mid]));
  });
});

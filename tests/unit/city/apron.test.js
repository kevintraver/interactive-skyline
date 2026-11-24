// The terrain apron (stability pass, plan 01): rings around the far grid, starting at the grid's own border heights,
// falling with the Earth's curve, facing up, a few thousand triangles at most.
import { describe, it, expect } from 'vitest';
import { apronGeometry, borderSamples, APRON_RINGS } from '../../../src/city/apron.js';
import { curveDrop } from '../../../src/core/earth.js';

// a small fake height field: a tilted plane with a bump, 40 x 30 km
const hf = {
  x0: -20000, y0: -15000, nx: 401, ny: 301, step: 100,
  sample: (x, y) => 800 + 0.01 * x + 300 * Math.exp(-((x - 15000) ** 2 + y ** 2) / 4e7),
};

describe('apron', () => {
  const g = apronGeometry(hf, 600);
  const n = g.samples.length;
  it('walks the whole border, corners included', () => {
    const s = borderSamples(hf);
    expect(s.some((p) => p.x === -20000 && p.y === -15000)).toBe(true);
    expect(s.some((p) => p.x === 20000 && p.y === 15000)).toBe(true);
    for (const p of s) expect(p.x === -20000 || p.x === 20000 || p.y === -15000 || p.y === 15000).toBe(true);
  });
  it('its border ring follows the grid\'s border heights on the curved Earth, never above the edge between samples', () => {
    const r = APRON_RINGS.indexOf(0);
    for (let i = 0; i < n; i++) {
      const k = (r * n + i) * 3, x = g.pos[k], y = -g.pos[k + 2];
      const h = g.pos[k + 1] + 600 + curveDrop(x, y);
      expect(h).toBeLessThanOrEqual(hf.sample(x, y) - 1 + 1e-3);
      expect(h).toBeGreaterThan(hf.sample(x, y) - 60); // close below: a 2 km stretch of this edge varies by tens of metres
      // and below the edge half way to the next sample
      const k2 = (r * n + ((i + 1) % n)) * 3, mx = (x + g.pos[k2]) / 2, my = (y - g.pos[k2 + 2]) / 2;
      const hm = (g.pos[k + 1] + g.pos[k2 + 1]) / 2 + 600 + curveDrop(mx, my);
      expect(hm).toBeLessThanOrEqual(hf.sample(mx, my) + 0.5);
    }
  });
  it('the ring under the grid stays below the grid', () => {
    for (let i = 0; i < n; i++) {
      const x = g.pos[i * 3], y = -g.pos[i * 3 + 2];
      expect(g.pos[i * 3 + 1]).toBeLessThan(hf.sample(x, y) - 600 - curveDrop(x, y));
    }
  });
  it('the outer ring is past where the fog hides the ground, and has fallen with the curve', () => {
    const r = APRON_RINGS.length - 1;
    for (let i = 0; i < n; i++) {
      const k = (r * n + i) * 3;
      expect(Math.max(Math.abs(g.pos[k]) - 20000, Math.abs(g.pos[k + 2]) - 15000)).toBeGreaterThanOrEqual(150000);
      expect(g.pos[k + 1]).toBeLessThan(-1500);
    }
  });
  it('every triangle faces up, and there are few', () => {
    const tris = g.idx.length / 3;
    expect(tris).toBeLessThan(4000);
    for (let t = 0; t < g.idx.length; t += 3) {
      const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]].map((i) => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const ny = u[2] * v[0] - u[0] * v[2];
      expect(ny).toBeGreaterThan(0);
    }
  });
});

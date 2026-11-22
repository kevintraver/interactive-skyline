import { describe, it, expect } from 'vitest';
import { rand, hash32 } from '../../../src/core/rng.js';

describe('rng', () => {
  it('is a pure function of seed and keys', () => {
    expect(rand(1, 2, 'a', 3.5)).toBe(rand(1, 2, 'a', 3.5));
    expect(rand(1, 2)).not.toBe(rand(2, 2));
    expect(rand(1, 2)).not.toBe(rand(1, 3));
    expect(rand(1, 'ab')).not.toBe(rand(1, 'ba'));
    expect(hash32(7, 1e12)).toBe(hash32(7, 1e12));
  });
  it('is uniform (chi-square over 1e5 draws, 100 bins)', () => {
    const bins = new Array(100).fill(0), n = 100000;
    for (let i = 0; i < n; i++) {
      const r = rand(42, i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      bins[Math.floor(r * 100)]++;
    }
    const e = n / 100, chi2 = bins.reduce((a, o) => a + (o - e) ** 2 / e, 0);
    expect(chi2).toBeLessThan(148.2); // 99 degrees of freedom, p = 0.001
  });
  it('gives this exact value on every run and machine', () => {
    expect(hash32(1, 2, 'x')).toMatchInlineSnapshot(`3888325216`);
  });
});

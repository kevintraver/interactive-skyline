// Thinning the lamps of far cells with their light kept, and without popping (src/flight/ground/thin.js).
import { describe, it, expect } from 'vitest';
import { hashOrder, cellScreenArea, drawShares, writeDrawList, MIN_PER_CELL } from '../../../src/flight/ground/thin.js';

describe('hashOrder', () => {
  const start = Uint32Array.from([0, 5, 5, 12]); // three cells: 5, 0 and 7 lamps
  const order = hashOrder(start, 3);
  it('is a permutation that keeps every cell on its own run', () => {
    expect(Array.from(order).sort((a, b) => a - b)).toEqual([...Array(12).keys()]);
    expect(Array.from(order.slice(0, 5)).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(order.slice(5, 12)).sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });
  it('shuffles within a run, the same way every time', () => {
    expect(Array.from(order)).toEqual(Array.from(hashOrder(start, 3)));
    expect(Array.from(order.slice(5, 12))).not.toEqual([5, 6, 7, 8, 9, 10, 11]);
  });
});

describe('cellScreenArea', () => {
  it('is the cell squared in pixels, foreshortened by the elevation', () => {
    const pa = 1e-3; // a milliradian per pixel
    expect(cellScreenArea({ d: 10000, r: 500, sinEl: 1, pixelAngle: pa })).toBeCloseTo(101 * 101, 6);
    expect(cellScreenArea({ d: 10000, r: 500, sinEl: 0.1, pixelAngle: pa })).toBeCloseTo(101 * 101 * 0.1, 6);
  });
});

describe('drawShares', () => {
  it('draws every lamp of a near cell and thins a far one to the density', () => {
    const counts = Float64Array.from([400, 400]);
    const areas = Float64Array.from([1e6, 400]); // pixels: the near cell is large, the far one is 400 px
    const { f } = drawShares({ counts, areas, n: 2, density: 0.25, budget: 1e6 });
    expect(f[0]).toBe(400);
    expect(f[1]).toBeCloseTo(100, 9);
  });
  it('never thins a cell below MIN_PER_CELL (or its count)', () => {
    const { f } = drawShares({ counts: Float64Array.from([400, 5]), areas: Float64Array.from([1, 1]), n: 2, density: 0.25, budget: 1e6 });
    expect(f[0]).toBe(MIN_PER_CELL);
    expect(f[1]).toBe(5);
  });
  it('keeps within the budget by thinning everything alike', () => {
    const n = 50;
    const counts = new Float64Array(n).fill(1000), areas = new Float64Array(n).fill(1e9);
    const { f, total } = drawShares({ counts, areas, n, density: 0.25, budget: 20000 });
    expect(total).toBeLessThanOrEqual(20000);
    let s = 0;
    for (let k = 0; k < n; k++) s += Math.ceil(f[k]);
    expect(s).toBe(total);
    expect(total).toBeGreaterThan(19000);
  });
});

describe('writeDrawList', () => {
  const firsts = Uint32Array.from([0, 100]);
  const counts = Float64Array.from([100, 50]);
  it('keeps every cell\'s light: its weights sum to its count', () => {
    const out = new Float32Array(400);
    const f = Float64Array.from([12.4, 50]);
    const m = writeDrawList(out, { firsts, counts, f, n: 2, budget: 200 });
    expect(m).toBe(13 + 50);
    let a = 0, b = 0;
    for (let j = 0; j < 13; j++) { expect(out[2 * j]).toBe(j); a += out[2 * j + 1]; }
    for (let j = 13; j < m; j++) { expect(out[2 * j]).toBe(100 + j - 13); b += out[2 * j + 1]; }
    expect(a).toBeCloseTo(100, 3);
    expect(b).toBeCloseTo(50, 3);
  });
  it('does not pop: a small change in the share changes each lamp a little', () => {
    const a = new Float32Array(400), b = new Float32Array(400);
    writeDrawList(a, { firsts, counts, f: Float64Array.from([12.999, 50]), n: 2, budget: 200 });
    const m = writeDrawList(b, { firsts, counts, f: Float64Array.from([13.001, 50]), n: 2, budget: 200 });
    // the 14th lamp of cell 0 arrives with almost nothing; the others barely change
    expect(b[2 * 13 + 1]).toBeLessThan(0.01);
    for (let j = 0; j < 13; j++) expect(Math.abs(a[2 * j + 1] - b[2 * j + 1])).toBeLessThan(0.02);
    expect(m).toBe(14 + 50);
  });
  it('stops at the budget', () => {
    const out = new Float32Array(400);
    expect(writeDrawList(out, { firsts, counts, f: Float64Array.from([100, 50]), n: 2, budget: 120 })).toBe(120);
  });
});

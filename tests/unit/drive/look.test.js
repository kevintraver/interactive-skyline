// The drive's dusk curve (src/drive/look.js); the look from plan 01's env.state is in port.test.js.
import { describe, it, expect } from 'vitest';
import { duskAt, elevationForDusk, isNightAt, beamsAt, DAY_ELEVATION, NIGHT_ELEVATION, NIGHT_DUSK, NIGHT_BELOW } from '../../../src/drive/look.js';

const range = (a, b, step) => { const out = []; for (let x = a; x >= b - 1e-9; x -= step) out.push(x); return out; };

describe('duskAt', () => {
  it('is 0 in full day and 1 at night, exactly', () => {
    for (const el of [90, 45, 20, DAY_ELEVATION]) expect(duskAt(el)).toBe(0);
    for (const el of [NIGHT_ELEVATION, -12, -18, -40, -90]) expect(duskAt(el)).toBe(1);
  });
  it('is monotonic and continuous in elevation', () => {
    let prev = -1;
    for (const el of range(10, -12, 0.01)) {
      const d = duskAt(el);
      expect(d).toBeGreaterThanOrEqual(prev);
      if (prev >= 0) expect(d - prev).toBeLessThan(0.002); // no step anywhere: at most 0.002 per 0.01 degree
      prev = d;
    }
  });
  it('changes fastest in civil twilight, between 0 and -6 degrees', () => {
    const rate = (el) => duskAt(el - 0.5) - duskAt(el + 0.5);
    let best = null;
    for (const el of range(6, -9, 0.25)) if (!best || rate(el) > rate(best)) best = el;
    expect(best).toBeLessThan(0);
    expect(best).toBeGreaterThan(-6);
    expect(duskAt(2)).toBeLessThan(0.05); // still day a few degrees up
    expect(duskAt(-6)).toBeGreaterThan(0.7);
  });
  it('inverts', () => {
    for (const d of [0.05, 0.3, 0.5, 0.9]) expect(duskAt(elevationForDusk(d))).toBeCloseTo(d, 6);
  });
});

describe('night boolean', () => {
  it('switches where the old switch was, before the default moment', () => {
    expect(NIGHT_BELOW).toBe(1.5);
    expect(NIGHT_DUSK).toBeCloseTo(duskAt(-1.5), 12);
    expect(isNightAt(10)).toBe(false);
    expect(isNightAt(-1.4)).toBe(false);
    expect(isNightAt(-1.6)).toBe(true);
    expect(isNightAt(-3)).toBe(true); // the default moment shows the night interface
  });
});

describe('beamsAt', () => {
  it('is 0 by day, 1 from mid civil twilight, and monotonic between', () => {
    expect(beamsAt(0)).toBe(0);
    expect(beamsAt(0.45)).toBe(1);
    expect(beamsAt(1)).toBe(1);
    let prev = -1;
    for (let d = 0; d <= 1; d += 0.01) { expect(beamsAt(d)).toBeGreaterThanOrEqual(prev); prev = beamsAt(d); }
  });
});

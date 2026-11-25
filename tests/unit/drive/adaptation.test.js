// The driver's night adaptation (src/drive/adaptation.js; plan 02, third stretch, decision 13): the CPU twin of
// the afterBloom stage and the gain's ramp with the light.
import { describe, it, expect } from 'vitest';
import { ADAPTATION, adaptationGain, adaptRgb, lumaOf } from '../../../src/drive/adaptation.js';

const { G, W, dayEv, nightEv } = ADAPTATION;

describe('adaptationGain', () => {
  it('is 1 by day (EV100 at and above the day end)', () => {
    for (const ev of [dayEv, 10, 14, 20]) expect(adaptationGain(ev)).toBe(1);
  });
  it('is G at night (EV100 at and below the night end)', () => {
    for (const ev of [nightEv, 0, -4, -12]) expect(adaptationGain(ev)).toBe(G);
  });
  it('falls monotonically from night to day, log-linear in stops as the eye key', () => {
    let last = Infinity;
    for (let ev = nightEv; ev <= dayEv; ev += 0.25) {
      const g = adaptationGain(ev);
      expect(g).toBeLessThanOrEqual(last);
      last = g;
    }
    expect(adaptationGain((nightEv + dayEv) / 2)).toBeCloseTo(Math.sqrt(G), 10);
  });
  it('is 1 for a missing EV (no environment yet)', () => {
    expect(adaptationGain(NaN)).toBe(1);
    expect(adaptationGain(undefined)).toBe(1);
  });
});

describe('adaptRgb', () => {
  it('is the identity when g is 1, bit for bit', () => {
    for (const c of [[0, 0, 0], [0.001, 0.002, 0.0005], [0.18, 0.18, 0.18], [1.2, 0.9, 0.3], [40, 30, 20]]) {
      expect(adaptRgb(c, 1)).toEqual(c);
    }
  });
  it('leaves a value whose luminance is W where it is', () => {
    const c = [W, W, W];
    adaptRgb(c, G).forEach((x, i) => expect(x).toBeCloseTo(c[i], 12));
    const tinted = [1.6, 1.1, 0.4].map((x) => (x * W) / lumaOf([1.6, 1.1, 0.4]));
    adaptRgb(tinted, G).forEach((x, i) => expect(x).toBeCloseTo(tinted[i], 12));
  });
  it('multiplies the darkest values by g', () => {
    const c = [1e-5, 2e-5, 5e-6];
    adaptRgb(c, G).forEach((x, i) => expect(x / c[i]).toBeCloseTo(G, 3));
  });
  it('is monotonic in luminance', () => {
    let last = -1;
    for (let y = 0; y < 50; y += 0.01) {
      const out = lumaOf(adaptRgb([y, y, y], G));
      expect(out).toBeGreaterThan(last);
      last = out;
    }
  });
  it('keeps the hue: every channel is scaled by the same factor', () => {
    for (const c of [[0.02, 0.01, 0.003], [0.5, 0.2, 0.9], [3, 0.1, 0.1]]) {
      const o = adaptRgb(c, G), k = o[0] / c[0];
      expect(o[1] / c[1]).toBeCloseTo(k, 12);
      expect(o[2] / c[2]).toBeCloseTo(k, 12);
    }
  });
  it('approaches W g / (g - 1) far above W, and never passes it', () => {
    const lim = (W * G) / (G - 1);
    expect(lumaOf(adaptRgb([1e6, 1e6, 1e6], G))).toBeCloseTo(lim, 3);
    for (const y of [2, 10, 100, 1e4]) expect(lumaOf(adaptRgb([y, y, y], G))).toBeLessThan(lim);
  });
  it('lifts values below W and lowers values above it', () => {
    expect(lumaOf(adaptRgb([0.5, 0.5, 0.5], G))).toBeGreaterThan(0.5);
    expect(lumaOf(adaptRgb([3, 3, 3], G))).toBeLessThan(3);
  });
});

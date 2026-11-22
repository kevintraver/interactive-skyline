// T2.6: automatic exposure (plan 01, section 7.2): the prior against the ANSI exposure table, the clamp, the Eye
// key, adaptation, and the pre-exposure that follows.
import { describe, it, expect } from 'vitest';
import { priorEv100, exposureFromEv100, ev100FromExposure, physicalLights, PHOTOMETRY } from '../../../src/render/photometry.js';
import { eyeKey, targetEv, adaptEv, exposureFor, ADAPT_UP_S, ADAPT_DOWN_S } from '../../../src/render/exposure.js';

describe('the prior against the ANSI table', () => {
  it('sunlit scene: EV 15 +- 1', () => {
    expect(priorEv100({ keyLux: 100000, keyAltDeg: 45, ambientLux: 15000, cityLux: 0 })).toBeCloseTo(15, -0.3);
    const ev = priorEv100({ keyLux: 100000, keyAltDeg: 45, ambientLux: 15000, cityLux: 0 });
    expect(Math.abs(ev - 15)).toBeLessThanOrEqual(1);
  });
  it('heavy overcast: EV 12 +- 1 (no direct Sun, 5,000 lux of sky)', () => {
    const ev = priorEv100({ keyLux: 0, keyAltDeg: 45, ambientLux: 5000, cityLux: 0 });
    expect(Math.abs(ev - 12)).toBeLessThanOrEqual(1);
  });
  it('landscape under a full Moon: EV -2.5 +- 1', () => {
    const ev = priorEv100({ keyLux: PHOTOMETRY.fullMoonLux, keyAltDeg: 45, ambientLux: 0.01, cityLux: 0 });
    expect(Math.abs(ev - -2.5)).toBeLessThanOrEqual(1);
  });
  it('the pinned day and night', () => {
    const day = physicalLights({ keyBody: 'sun', keyWeight: 1, sunPower: 2.7 }, { pinned: true, moonLux: 0, ambientLux: 15000, street: 0 });
    expect(day.keyLux).toBe(100000);
    const night = physicalLights({ keyBody: 'moon', keyWeight: 1, sunPower: 0.2 }, { pinned: true, moonLux: 0.001, ambientLux: 0.0006, street: 1 });
    expect(night).toEqual({ keyLux: 0.25, ambientLux: 0.0006, cityLux: PHOTOMETRY.cityLux, emissionLux: PHOTOMETRY.cityEmissionLux });
  });
});

describe('exposure', () => {
  it('EV100 and exposure invert each other (1 / (1.2 2^EV))', () => {
    for (const ev of [-6, 0, 9, 15]) expect(ev100FromExposure(exposureFromEv100(ev))).toBeCloseTo(ev, 9);
    expect(exposureFromEv100(0)).toBeCloseTo(1 / 1.2, 12);
  });
  it('the meter is clamped to [prior - 3, prior + 2] and falls back to the prior', () => {
    expect(targetEv(20, 10)).toBe(12);
    expect(targetEv(1, 10)).toBe(7);
    expect(targetEv(10.5, 10)).toBe(10.5);
    expect(targetEv(null, 10)).toBe(10);
    expect(targetEv(NaN, 10)).toBe(10);
  });
  it('Eye mode lowers the key from 0.18 at EV 9 to 0.03 at EV 0; Camera keeps middle grey', () => {
    expect(eyeKey(9)).toBeCloseTo(0.18, 9);
    expect(eyeKey(15)).toBeCloseTo(0.18, 9);
    expect(eyeKey(0)).toBeCloseTo(0.03, 9);
    expect(eyeKey(-10)).toBeCloseTo(0.03, 9);
    expect(eyeKey(4.5)).toBeCloseTo(0.105, 9);
    expect(exposureFor(-4, 'eye') / exposureFor(-4, 'camera')).toBeCloseTo(0.03 / 0.18, 9);
    expect(exposureFor(12, 'eye')).toBeCloseTo(exposureFor(12, 'camera'), 12);
    expect(exposureFor(12, 'camera', 1)).toBeCloseTo(2 * exposureFor(12, 'camera'), 12);
  });
  it('adapts fast toward brighter scenes (0.6 s) and slowly toward darker ones (3 s)', () => {
    // one time constant gets 63 % of the way there
    expect(adaptEv(10, 12, ADAPT_UP_S)).toBeCloseTo(12 - 2 * Math.exp(-1), 9);
    expect(adaptEv(12, 10, ADAPT_DOWN_S)).toBeCloseTo(10 + 2 * Math.exp(-1), 9);
    expect(adaptEv(NaN, 7, 0.1)).toBe(7);
  });
});

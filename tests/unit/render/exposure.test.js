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
  it('Eye mode lowers the key from 0.18 at EV 9 to 0.005 at EV 1, evenly in stops; Camera keeps middle grey', () => {
    expect(eyeKey(9)).toBeCloseTo(0.18, 9);
    expect(eyeKey(15)).toBeCloseTo(0.18, 9);
    expect(eyeKey(1)).toBeCloseTo(0.005, 9);
    expect(eyeKey(-10)).toBeCloseTo(0.005, 9);
    expect(eyeKey(5)).toBeCloseTo(Math.sqrt(0.18 * 0.005), 9); // half way in stops
    // monotonic, so a dusk scrub never brightens as the light falls
    for (let ev = -2; ev < 12; ev += 0.25) expect(eyeKey(ev + 0.25)).toBeGreaterThanOrEqual(eyeKey(ev));
    expect(exposureFor(-4, 'eye') / exposureFor(-4, 'camera')).toBeCloseTo(0.005 / 0.18, 9);
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

// Decision 13 (the stability pass): in Eye mode the exposure is the prior's alone; the meter exists only in Camera mode.
describe('createExposure', async () => {
  const { createExposure } = await import('../../../src/render/exposure.js');
  const { Texture } = await import('three');
  const fake = () => {
    const calls = { reads: 0, invalidate: 0 };
    const renderer = { getRenderTarget: () => null, setRenderTarget() {}, render() {}, readRenderTargetPixelsAsync: () => { calls.reads++; return new Promise(() => {}); } };
    const pipeline = { scenePass: { getTexture: () => new Texture() } };
    return { renderer, pipeline, calls };
  };
  it('Eye mode: the exposure follows the prior only, never asks for frames and meters nothing', () => {
    const { renderer, pipeline, calls } = fake();
    let prior = 14;
    const u = { value: 0 };
    const x = createExposure({ renderer, pipeline, prior: () => prior, uniform: u, settings: { exposureMode: 'eye', exposureComp: 0 }, offsetEv: 0.5, invalidate: () => calls.invalidate++ });
    expect(x.metering).toBe(false);
    for (let i = 0; i < 5; i++) {
      x.update({ nowMs: i * 16 });
      x.afterRender();
      expect(u.value).toBe(exposureFor(14, 'eye', 0.5));
      expect(x.demand()).toBe('idle');
    }
    x.snap(true); // a new view
    x.update({ nowMs: 100 });
    expect(u.value).toBe(exposureFor(14, 'eye', 0.5));
    prior = 2; // the light changed: at once, no adaptation
    x.update({ nowMs: 116 });
    expect(u.value).toBe(exposureFor(2, 'eye', 0.5));
    x.setCompensation(1);
    x.update({ nowMs: 132 });
    expect(u.value).toBe(exposureFor(2, 'eye', 1.5));
    expect(x.demand()).toBe('idle');
    expect(calls.reads).toBe(0);
    expect(calls.invalidate).toBe(0);
  });
  it('Camera mode creates the meter, and leaving it drops the meter', () => {
    const { renderer, pipeline } = fake();
    const u = { value: 0 };
    const x = createExposure({ renderer, pipeline, prior: () => 10, uniform: u, settings: { exposureMode: 'eye' } });
    x.update({ nowMs: 0 });
    x.setMode('camera');
    expect(x.metering).toBe(true);
    x.update({ nowMs: 16 });
    expect(u.value).toBe(exposureFor(10, 'camera')); // the first frame after the switch: the prior, awaiting a reading
    expect(x.demand()).toBe('continuous');
    x.setMode('eye');
    expect(x.metering).toBe(false);
    x.update({ nowMs: 32 });
    expect(u.value).toBe(exposureFor(10, 'eye'));
    expect(x.demand()).toBe('idle');
  });
  it('without a pipeline (the classic renderer) Camera mode cannot meter and exposes at the prior', () => {
    const u = { value: 0 };
    const x = createExposure({ renderer: null, pipeline: null, prior: () => 10, uniform: u, settings: { exposureMode: 'camera' } });
    x.update({ nowMs: 0 });
    expect(x.metering).toBe(false);
    expect(x.demand()).toBe('idle');
  });
});

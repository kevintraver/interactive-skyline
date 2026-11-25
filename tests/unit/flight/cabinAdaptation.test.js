// The cabin's own adaptation (src/flight/cabin/cabin.js cabinAdaptation; the cabin pass of 25 Nov 2026): the cabin is
// laid over the finished outside picture and shown with an adaptation of its own. By day nothing changes; at dusk the
// cabin takes back exactly what the highlight guard took from it; at night a dimmed cabin is lifted part of the way
// toward the day's level, never to it, never by more than the cap, with the order of levels kept. Levels: the
// measured walls of the exposure pass (25 Nov 2026), L k over the buffer's mid-grey.
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  cabinAdaptation, guardEv, cabinCdM2, stepLift, CABIN_ADAPT, CABIN_GAIN, cabinLightLevel,
  createModelledCabin, setExposureSource,
} from '../../../src/flight/cabin/cabin.js';
import { priorLuminance } from '../../../src/render/photometry.js';
import { flightPriorTerms } from '../../../src/flight/exposure.js';
import { defaultSeat } from '../../../src/flight/cabin/lopa.js';
import { createEnvNodes } from '../../../src/env/nodes.js';
import { exposure as exposureUniform } from '../../../src/render/materials/shared.js';

const at = (L, k) => ({ cabinCdM2: L, exposure: k });

describe('cabinAdaptation: by day nothing changes', () => {
  it('a window-lit cabin (lamps a few per cent of its light) is not lifted, whatever its level', () => {
    for (const [L, k] of [[490, 8.6e-5], [600, 6.8e-5], [370, 8.6e-5], [50, 6.8e-5], [5, 6.8e-5]]) {
      const a = cabinAdaptation({ ...at(L, k), lampShare: 0.03, guardEv: 0 });
      expect(a.liftEv).toBe(0);
      expect(a.gain).toBe(1);
    }
  });
});

describe('cabinAdaptation: at dusk the guard is taken back', () => {
  it('a guard that leaves the cabin under the ceiling is taken back exactly', () => {
    const k = 0.00101, a = cabinAdaptation({ ...at(20, k), lampShare: 0, guardEv: 1.0 });
    expect(a.liftEv).toBeCloseTo(1.0, 6);
    expect(a.evShown).toBeCloseTo(Math.log2((20 * k * 2) / CABIN_ADAPT.keyBuffer), 6);
  });
  it('lv-19-dusk at 10,000 ft (the guard 1.84 EV, the cabin 42.8 cd/m^2 at k 0.00101): lifted to the ceiling, not over it', () => {
    const a = cabinAdaptation({ ...at(42.8, 0.00101), lampShare: 0.15, guardEv: 1.84 });
    expect(a.evShown).toBeCloseTo(CABIN_ADAPT.ceilEv, 6);
    expect(a.liftEv).toBeGreaterThan(1.0);
    expect(a.liftEv).toBeLessThan(1.84);
  });
  it('never darkens: a cabin above the ceiling stays as it is', () => {
    expect(cabinAdaptation({ ...at(1.1, 0.256), lampShare: 1, guardEv: 0 }).liftEv).toBe(0);
    expect(cabinAdaptation({ ...at(1.1, 0.256), lampShare: 1, guardEv: 1 }).liftEv).toBe(0);
  });
  it('the guard taken back is capped', () => {
    expect(cabinAdaptation({ ...at(2, 0.001), lampShare: 0, guardEv: 7 }).liftEv).toBe(CABIN_ADAPT.guardMaxEv);
    expect(cabinAdaptation({ ...at(41, 0.001), lampShare: 0, guardEv: -3 }).liftEv).toBe(0);
  });
});

describe('cabinAdaptation: at night a dimmed cabin is lifted part of the way', () => {
  const night = (L, k) => cabinAdaptation({ ...at(L, k), lampShare: 1 });
  it('on final (wall 0.19 cd/m^2 at k 0.075) lifted, but shown below the knee', () => {
    const a = night(0.19, 0.0753);
    expect(a.liftEv).toBeGreaterThan(0.8);
    expect(a.evShown).toBeLessThan(CABIN_ADAPT.kneeEv);
    expect(a.evShown).toBeCloseTo(CABIN_ADAPT.kneeEv + (1 - CABIN_ADAPT.share) * (a.ev - CABIN_ADAPT.kneeEv), 9);
  });
  it('a cabin above the knee (the bright cruise cabin) is not lifted', () => {
    expect(night(1.1, 0.256).liftEv).toBe(0);
  });
  it('keeps the order of levels: a darker cabin never shows brighter', () => {
    let prev = -Infinity;
    for (let L = 0.0005; L < 3; L *= 1.15) {
      const a = night(L, 0.08);
      expect(a.evShown).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = a.evShown;
    }
  });
  it('never more than the cap, never invisible within it', () => {
    const a = night(1e-6, 0.08);
    expect(a.liftEv).toBe(CABIN_ADAPT.maxLiftEv);
    expect(a.gain).toBeCloseTo(2 ** CABIN_ADAPT.maxLiftEv, 9);
    expect(night(0.01, 0.08).evShown).toBeGreaterThan(night(0.01, 0.08).ev + 1.5);
    for (let L = 0.001; L < 1e4; L *= 2) for (const g of [0, 1, 2]) expect(cabinAdaptation({ ...at(L, 0.01), lampShare: 1, guardEv: g }).evShown).toBeLessThanOrEqual(Math.max(CABIN_ADAPT.ceilEv, Math.log2((L * 0.01) / 0.18)) + 1e-9);
  });
  it('moves smoothly with the lamps\' share through the twilight (no step)', () => {
    let prev = cabinAdaptation({ ...at(0.19, 0.08), lampShare: 0 }).liftEv;
    for (let s = 0.01; s <= 1.0001; s += 0.01) {
      const l = cabinAdaptation({ ...at(0.19, 0.08), lampShare: s }).liftEv;
      expect(Math.abs(l - prev)).toBeLessThan(0.06);
      prev = l;
    }
  });
  it('nothing without light or exposure', () => {
    for (const o of [at(0, 0.1), at(NaN, 0.1), at(1, 0), at(1, NaN)]) expect(cabinAdaptation(o).gain).toBe(1);
  });
});

describe('guardEv: what the dusk guard took from the exposure', () => {
  const terms = { keyLux: 20000, keyAltDeg: 0.2, ambientLux: 400, cityLux: 0.25, emissionLux: 0 };
  it('is the prior with the guarded key over the prior with the Sun where it is', () => {
    const guarded = flightPriorTerms(terms, { keyIsSun: true });
    expect(guarded.keyAltDeg).toBeGreaterThan(3);
    expect(guardEv(guarded, 0.2)).toBeCloseTo(Math.log2(priorLuminance(guarded) / priorLuminance({ ...guarded, keyAltDeg: 0.2 })), 9);
    expect(guardEv(guarded, 0.2)).toBeGreaterThan(0.5);
  });
  it('is nothing by day, at night, or without terms', () => {
    expect(guardEv({ ...terms, keyAltDeg: 30 }, 30)).toBe(0);
    expect(guardEv({ ...terms, keyLux: 0.1, keyAltDeg: 40 }, -20)).toBe(0); // the Moon is the key
    expect(guardEv(null, 1)).toBe(0);
  });
});

describe('cabinCdM2 and stepLift', () => {
  it('by day the window lights the wall; at night the lamps', () => {
    const day = cabinCdM2({ windowL: 1700, level: 1 }), nightC = cabinCdM2({ windowL: 0.001, level: cabinLightLevel(0.3, true) });
    expect(day.lampShare).toBeLessThan(0.1);
    expect(nightC.lampShare).toBeGreaterThan(0.95);
    expect(nightC.cdM2).toBeGreaterThan(0.05);
    expect(nightC.cdM2).toBeLessThan(0.6);
  });
  it('follows smoothly while frames pass and jumps on a cut', () => {
    expect(stepLift(0, 1, 0)).toBe(1);
    expect(stepLift(0, 1, 5)).toBe(1);
    expect(stepLift(NaN, 1, 0.016)).toBe(1);
    const a = stepLift(0, 1, 0.016);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(0.05);
  });
});

describe("the cabin's update drives the gain", () => {
  it('lifts at night with the outside dark and leaves the day alone; the guard from the terms when handed in', async () => {
    const nodes = createEnvNodes({ state: null });
    const c = createModelledCabin({ nodes, seat: defaultSeat(), load: async () => { throw new Error('none'); } });
    await c.ready;
    exposureUniform.value = 0.0753;
    c.update(null, { cabinLight: 0.3, night: true, outside: { windowL: 0.0005, sunLux: 0, sunWorld: new Vector3(0, -0.5, 0.87) } });
    expect(CABIN_GAIN.value).toBeGreaterThan(1.7);
    expect(c.adaptation.liftEv).toBeGreaterThan(0.8);
    exposureUniform.value = 6.8e-5;
    c.update(null, { cabinLight: 1, outside: { windowL: 1700, sunLux: 90000, sunWorld: new Vector3(0, 0.5, 0.87) } });
    expect(CABIN_GAIN.value).toBe(1);
    // dusk: the prior's own terms, guarded 1 EV
    exposureUniform.value = 0.001;
    const sun = new Vector3(0, Math.sin(0.2 * Math.PI / 180), 1).normalize();
    const terms = flightPriorTerms({ keyLux: 20000, keyAltDeg: 0.2, ambientLux: 400, cityLux: 0.25 }, { keyIsSun: true });
    c.update(null, { cabinLight: 1, outside: { windowL: 150, sunLux: 20000, sunWorld: sun }, exposure: { on: true, terms } });
    expect(c.adaptation.exact).toBe(true);
    expect(c.adaptation.guardEv).toBeCloseTo(guardEv(terms, 0.2), 2);
    // without the terms the guard is not guessed; a source set for the harness gives them
    c.update(null, { cabinLight: 1, outside: { windowL: 150, sunLux: 20000, sunWorld: sun } });
    expect(c.adaptation.exact).toBe(false);
    expect(c.adaptation.guardEv).toBe(0);
    setExposureSource(() => ({ on: true, terms }));
    c.update(null, { cabinLight: 1, outside: { windowL: 150, sunLux: 20000, sunWorld: sun } });
    expect(c.adaptation.guardEv).toBeCloseTo(guardEv(terms, 0.2), 2);
    setExposureSource(null);
    exposureUniform.value = 1;
    c.update(null, {});
    expect(CABIN_GAIN.value).toBe(1);
    c.dispose();
  });
});

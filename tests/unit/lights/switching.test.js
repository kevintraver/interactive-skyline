// D5.5: street lamps switching on at dusk (src/drive/lights/switching.js) against env's ambientLux.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEphemeris, ambientLux } from '../../../src/drive/env.js';
import {
  lampHash, switchThresholdLux, isLit, litShare, elevationForLux, switchOnTime, lampState, SWITCH_MID_LUX,
} from '../../../src/drive/lights/switching.js';

const LV = JSON.parse(readFileSync(new URL('../../../data/cities.json', import.meta.url), 'utf8')).lv;
const eph = createEphemeris(LV);
const N = 20000;

describe('thresholds', () => {
  it('hashes indices uniformly into [0, 1)', () => {
    const bins = new Array(10).fill(0);
    for (let i = 0; i < N; i++) {
      const u = lampHash(i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      bins[Math.floor(u * 10)]++;
    }
    for (const b of bins) expect(Math.abs(b / (N / 10) - 1)).toBeLessThan(0.06);
    expect(lampHash(7)).toBe(lampHash(7));
  });

  it('spreads thresholds around the middle value, and the counted share follows litShare', () => {
    const ts = Array.from({ length: N }, (_, i) => switchThresholdLux(i)).sort((a, b) => a - b);
    expect(ts[N / 2] / SWITCH_MID_LUX).toBeGreaterThan(0.95);
    expect(ts[N / 2] / SWITCH_MID_LUX).toBeLessThan(1.05);
    for (const lux of [1, 5, 16, 50, 200]) {
      let lit = 0;
      for (let i = 0; i < N; i++) if (isLit(i, lux)) lit++;
      expect(Math.abs(lit / N - litShare(lux))).toBeLessThan(0.015);
    }
    expect(litShare(0)).toBe(1);
  });

  it('inverts ambientLux', () => {
    for (const el of [-10, -4.2, -1, 3]) expect(elevationForLux(ambientLux(el))).toBeCloseTo(el, 6);
  });
});

describe('dusk at Las Vegas (acceptance)', () => {
  const evenings = ['2026-11-21T12:00:00Z', '2026-06-21T12:00:00Z', '2026-03-20T12:00:00Z'];

  it.each(evenings)('on the evening of %s the lit share goes from under 5% to over 95% as the sun goes 0 to -6 deg, never more than 10% in 30 s', (iso) => {
    const t0 = eph.timeOfSunElevation(0, Date.parse(iso), true);
    const t1 = eph.timeOfSunElevation(-6, Date.parse(iso), true);
    expect(t1 - t0).toBeGreaterThan(20 * 60000); // the sun takes over 20 minutes for those 6 degrees at 36 N
    const counted = (t) => {
      const lux = ambientLux(eph.sun(t).elevation);
      let lit = 0;
      for (let i = 0; i < N; i++) if (isLit(i, lux)) lit++;
      return lit / N;
    };
    const shares = [];
    for (let t = t0; t <= t1 + 30000; t += 30000) shares.push(counted(Math.min(t, t1)));
    expect(shares[0]).toBeLessThan(0.05);
    expect(shares[shares.length - 1]).toBeGreaterThan(0.95);
    let maxStep = 0;
    for (let k = 1; k < shares.length; k++) maxStep = Math.max(maxStep, Math.abs(shares[k] - shares[k - 1]));
    expect(maxStep).toBeLessThanOrEqual(0.1);
  });
});

describe('switch-on time', () => {
  const dusk = eph.timeOfSunElevation(-8, Date.parse('2026-11-21T12:00:00Z'), true);

  it('is when ambient light crossed the lamp threshold this evening, and a pure function of time', () => {
    const i = 42;
    const on = switchOnTime(i, dusk, eph);
    expect(on).toBeLessThanOrEqual(dusk);
    expect(ambientLux(eph.sun(on).elevation)).toBeCloseTo(switchThresholdLux(i), 2);
    // scrubbing to any later time that night gives the same moment
    expect(Math.abs(switchOnTime(i, dusk + 3 * 3600000, eph) - on)).toBeLessThan(2);
    const s = lampState(i, on + 90000, eph);
    expect(s.lit).toBe(true);
    expect(s.secondsOn).toBeCloseTo(90, 2);
  });

  it('after midnight it is the previous evening, and by day the lamp is off', () => {
    const on = switchOnTime(5, dusk, eph);
    const night = Date.parse('2026-11-22T11:00:00Z'); // 03:00 local, Nov 22
    expect(Math.abs(switchOnTime(5, night, eph) - on)).toBeLessThan(2);
    const noon = eph.solarNoon(Date.parse('2026-11-22T20:00:00Z'));
    expect(switchOnTime(5, noon, eph)).toBeNaN();
    expect(lampState(5, noon, eph)).toEqual({ lit: false, onAtMs: NaN, secondsOn: NaN });
  });
});

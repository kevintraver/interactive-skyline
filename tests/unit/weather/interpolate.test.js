// T5.1: interpolation between hourly samples (plan 01, section 6.4): linear for scalars, the shortest arc for
// directions, cloud layers matched by level and cross-faded, codes held until the next report; continuous across
// hour boundaries.
import { describe, it, expect } from 'vitest';
import { lerpAngle, lerpSample, sampleSeries } from '../../../src/weather/interpolate.js';
import { presetSample } from '../../../src/weather/presets.js';
import { validateSample } from '../../../src/weather/schema.js';

const H = 3600000;
const T0 = Date.UTC(2026, 6, 14, 18);

describe('lerpAngle', () => {
  it('wind 350 to 10 degrees passes through 0, not 180', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpAngle(350, 10, 0.25)).toBeCloseTo(355, 9);
    expect(lerpAngle(350, 10, 0.75)).toBeCloseTo(5, 9);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0, 9);
  });
  it('stays in [0, 360)', () => {
    for (let f = 0; f <= 1; f += 0.05) {
      const a = lerpAngle(300, 60, f);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(360);
    }
  });
  it('the ends are the inputs', () => {
    expect(lerpAngle(123, 321, 0)).toBe(123);
    expect(lerpAngle(123, 321, 1)).toBeCloseTo(321, 9);
  });
});

describe('lerpSample', () => {
  const a = presetSample('cumulus', T0, 620), b = presetSample('overcast', T0 + H, 620);
  a.wind = { dirDeg: 350, speedMs: 4, gustMs: 6 };
  b.wind = { dirDeg: 10, speedMs: 8, gustMs: 12 };
  a.wxCodes = ['FEW'];
  b.wxCodes = ['-RA'];

  it('the ends are the samples', () => {
    expect(lerpSample(a, b, 0)).toEqual(a);
    expect(lerpSample(a, b, 1)).toEqual(b);
  });
  it('scalars are linear, directions take the short way', () => {
    const m = lerpSample(a, b, 0.5);
    expect(m.t).toBe(T0 + H / 2);
    expect(m.tempC).toBeCloseTo((a.tempC + b.tempC) / 2, 9);
    expect(m.wind.speedMs).toBeCloseTo(6, 9);
    expect(m.wind.dirDeg).toBeCloseTo(0, 9);
    expect(m.aerosol.aod550).toBeCloseTo((a.aerosol.aod550 + b.aerosol.aod550) / 2, 9);
  });
  it('codes are held until the next sample', () => {
    expect(lerpSample(a, b, 0.99).wxCodes).toEqual(['FEW']);
    expect(lerpSample(a, b, 0.99).precip.kind).toBe(a.precip.kind);
  });
  it('a layer only one side has fades in or out; layers at the same level cross-fade', () => {
    const c = presetSample('clear', T0, 620), d = presetSample('cumulus', T0 + H, 620);
    const m = lerpSample(c, d, 0.25);
    expect(m.clouds).toHaveLength(1);
    expect(m.clouds[0].cover).toBeCloseTo(d.clouds[0].cover * 0.25, 9);
    expect(m.clouds[0].baseM).toBe(d.clouds[0].baseM);
    const e = structuredClone(d);
    e.clouds[0].baseM += 400; e.clouds[0].topM += 400; e.clouds[0].cover = 0.6;
    const n = lerpSample(d, e, 0.5);
    expect(n.clouds).toHaveLength(1);
    expect(n.clouds[0].baseM).toBeCloseTo(d.clouds[0].baseM + 200, 6);
  });
  it('every blend is a valid sample', () => {
    const presets = ['clear', 'hazy', 'cumulus', 'cirrus', 'overcast', 'rain', 'monsoon', 'haboob', 'virga'];
    for (const x of presets) for (const y of presets) for (const f of [0.1, 0.5, 0.9]) {
      expect(validateSample(lerpSample(presetSample(x, T0, 620), presetSample(y, T0 + H, 620), f)), `${x} ${y} ${f}`).toEqual([]);
    }
  });
});

describe('sampleSeries', () => {
  // hourly samples whose temperature and wind change every hour
  const points = Array.from({ length: 6 }, (_, i) => {
    const s = presetSample(i % 2 ? 'cumulus' : 'clear', T0 + i * H, 620);
    s.tempC = 20 + i * 3;
    s.wind = { dirDeg: (340 + i * 10) % 360, speedMs: 2 + i, gustMs: 4 + i };
    return s;
  });

  it('at a point: that sample', () => expect(sampleSeries(points, T0 + 2 * H)).toEqual(points[2]));
  it('between points: the blend', () => expect(sampleSeries(points, T0 + 2.5 * H).tempC).toBeCloseTo(27.5, 9));
  it('outside: the nearest end', () => {
    expect(sampleSeries(points, T0 - H).tempC).toBe(20);
    expect(sampleSeries(points, T0 + 99 * H).tempC).toBe(35);
  });
  it('empty: null', () => expect(sampleSeries([], T0)).toBe(null));

  it('continuous across hour boundaries: a second either side differs by a second of change', () => {
    for (let i = 1; i < 5; i++) {
      const at = T0 + i * H;
      const before = sampleSeries(points, at - 1000), after = sampleSeries(points, at + 1000);
      expect(Math.abs(after.tempC - before.tempC)).toBeLessThan(0.01);
      expect(Math.abs(after.wind.speedMs - before.wind.speedMs)).toBeLessThan(0.01);
      const dd = Math.abs(((after.wind.dirDeg - before.wind.dirDeg + 540) % 360) - 180);
      expect(dd).toBeLessThan(0.01);
      const cover = (s) => s.clouds.reduce((m, c) => Math.max(m, c.cover), 0);
      expect(Math.abs(cover(after) - cover(before))).toBeLessThan(0.01);
    }
  });
});

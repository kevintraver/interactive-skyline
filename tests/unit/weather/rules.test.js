// The drive's rain shorthand and the rules that derive the wet road from the rain rate (src/drive/env.js weatherFor),
// and the rain address parameter (src/drive/url.js). env.weather over plan 01's weather is in adapter.test.js.
import { describe, it, expect } from 'vitest';
import { weatherFor, RAIN_PRESETS, DRY_VISIBILITY_M } from '../../../src/drive/env.js';
import { encodeDriveState, decodeDriveState, clearDriveState, withRain } from '../../../src/drive/url.js';

describe('the rain\'s rules', () => {
  it('is dry at 0 mm/h', () => {
    expect(weatherFor(0)).toMatchObject({ precipMmPerHour: 0, precipKind: 'none', wetness: 0, visibilityM: DRY_VISIBILITY_M, overcast: 0, skyDim: 1, windMps: 0, hasTemperature: false });
  });
  it('has four presets at about 0, 1, 4 and 12 mm/h', () => {
    expect(RAIN_PRESETS.map((p) => [p.id, p.mmPerHour])).toEqual([['clear', 0], ['light', 1], ['moderate', 4], ['heavy', 12]]);
  });
  it('derives wetness, visibility and the sky from the rate by its rules', () => {
    const l = weatherFor(1), m = weatherFor(4), h = weatherFor(12);
    expect(l.wetness).toBeCloseTo(1 - Math.exp(-0.5), 6);
    expect(m.wetness).toBeCloseTo(0.8647, 3);
    expect(h.wetness).toBeGreaterThan(0.99);
    expect(l.visibilityM).toBeCloseTo(16000, 0);
    expect(h.visibilityM).toBeCloseTo(16000 * 12 ** -0.6, 3);
    expect(l.skyDim).toBeCloseTo(0.45, 6);
    expect(h.skyDim).toBeLessThan(m.skyDim);
    for (const s of [l, m, h]) { expect(s.overcast).toBe(1); expect(s.precipKind).toBe('rain'); }
    // monotonic
    let prev = weatherFor(0);
    for (let r = 0.5; r < 40; r *= 1.5) {
      const s = weatherFor(r);
      expect(s.wetness).toBeGreaterThanOrEqual(prev.wetness);
      expect(s.visibilityM).toBeLessThanOrEqual(prev.visibilityM);
      prev = s;
    }
  });
});

describe('the rain address parameter', () => {
  it('reads presets and rates, and ignores anything else', () => {
    expect(decodeDriveState('mode=drive&rain=heavy').rain).toBe('heavy');
    expect(decodeDriveState('mode=drive&rain=4').rain).toBe(4);
    expect(decodeDriveState('mode=drive&rain=soup').rain).toBeUndefined();
    expect(decodeDriveState('mode=drive&rain=-1').rain).toBeUndefined();
  });
  it('is kept by the drive address and dropped on leaving', () => {
    const p = encodeDriveState({ route: 'i15n', s: 10 }, 'city=lv&mode=drive&rain=light');
    expect(p.get('rain')).toBe('light');
    expect(encodeDriveState({ route: 'i15n', rain: 'clear' }, 'rain=light').has('rain')).toBe(false);
    expect(clearDriveState('city=lv&mode=drive&rain=light').has('rain')).toBe(false);
    expect(withRain('city=lv', 'moderate').get('rain')).toBe('moderate');
    expect(withRain('city=lv&rain=heavy', 'clear').has('rain')).toBe(false);
  });
});

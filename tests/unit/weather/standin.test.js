import { describe, it, expect } from 'vitest';
import { createEnv, createWeather, weatherFor, RAIN_PRESETS, DRY_VISIBILITY_M } from '../../../src/drive/env.js';
import { encodeDriveState, decodeDriveState, clearDriveState, withRain } from '../../../src/drive/url.js';
import { weatheredLook } from '../../../src/drive/skyblend.js';

const city = { origin: { lat: 36.17, lon: -115.14 }, tz: 'America/Los_Angeles' };

describe('weather stand-in', () => {
  it('is clear by default, with the dry state the lamps had before', () => {
    const s = createEnv({ city }).weather.state();
    expect(s).toMatchObject({ preset: 'clear', precipMmPerHour: 0, precipKind: 'none', wetness: 0, visibilityM: DRY_VISIBILITY_M, overcast: 0, skyDim: 1, windMps: 0, hasTemperature: false });
    expect(createEnv({ city }).weather.hasTemperature).toBe(false);
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
  it('is a pure function of the preset: choosing Rain is wet at once, whatever came before', () => {
    const a = createWeather(), b = createWeather();
    a.setPreset('heavy').setPreset('light').setPreset('moderate');
    b.setPreset('moderate');
    expect(a.state()).toEqual(b.state());
    expect(a.state().wetness).toBeGreaterThan(0.85);
  });
  it('emits change once per change of state, not for the same state', () => {
    const w = createWeather();
    const seen = [];
    const off = w.on('change', (s) => seen.push(s.preset));
    w.setPreset('light'); w.setPreset('light'); w.setRain(12); w.setPreset('clear'); w.setPreset('nonsense');
    expect(seen).toEqual(['light', 'heavy', 'clear']);
    off(); w.setPreset('heavy');
    expect(seen.length).toBe(3);
    expect(typeof w.on('lightning', () => {})).toBe('function');
  });
  it('setRain takes any rate', () => {
    const w = createWeather();
    w.setRain(2.5);
    expect(w.state()).toMatchObject({ preset: null, precipMmPerHour: 2.5 });
    w.setRain(0);
    expect(w.state()).toEqual(weatherFor(0, { preset: 'clear' }));
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

describe('the sky hook', () => {
  const look = { lights: 0, sky: { haze: [0.7, 0.8, 0.9], zenith: [0.3, 0.5, 0.9], glow: [1, 0.6, 0.3], glowAmount: 0.5, skyLight: [0.8, 0.85, 1], groundLight: [0.4, 0.35, 0.3], hemi: 0.8 }, light: { intensity: 2.7, shadow: 0.6, color: [1, 1, 1], source: 'sun' } };
  it('leaves the look and the fog exactly as they were when dry', () => {
    const r = weatheredLook(look, { overcast: 0, skyDim: 1, visibilityM: Infinity }, 0.000014);
    expect(r.look).toBe(look);
    expect(r.fogDensity).toBe(0.000014);
  });
  it('greys, dims and fogs in rain', () => {
    const s = weatherFor(12);
    const r = weatheredLook(look, s, 0.000014);
    expect(r.look.light.intensity).toBeLessThan(0.2);
    expect(r.look.light.shadow).toBe(0);
    const sat = (c) => Math.max(...c) - Math.min(...c);
    expect(sat(r.look.sky.zenith)).toBeLessThan(sat(look.sky.zenith) * 0.3);
    // 95% fog at the visibility
    expect(1 - Math.exp(-((r.fogDensity * s.visibilityM) ** 2))).toBeCloseTo(0.95, 6);
  });
});

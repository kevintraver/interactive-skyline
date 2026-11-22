// T5.3 and T5.5: what the chip and its source line say (plan 01, section 4.2).
import { describe, it, expect } from 'vitest';
import { summarize, formatWeather, describeSource, describeOverride, compass } from '../../../src/weather/describe.js';
import { presetSample, PRESETS } from '../../../src/weather/presets.js';

const fmt = { time: (t) => new Date(t).toISOString().slice(11, 16), date: (t) => new Date(t).toISOString().slice(0, 10) };
const p = (id) => presetSample(id, 0, 620);

describe('the chip', () => {
  it('a word for every preset', () => {
    expect(PRESETS.map(({ id }) => summarize(p(id)))).toEqual(['Clear', 'Hazy', 'Dusty', 'Few clouds', 'Partly cloudy', 'Overcast', 'Rain',
      'Thunderstorm', 'Dust storm', 'Virga']);
  });
  it('the line of section 4.2, in feet or metres', () => {
    const s = { ...p('clear'), tempC: 16.1, visibilityM: 16093.44, visibilityCensored: true, wind: { dirDeg: 315, speedMs: 2.2352, gustMs: 3 } };
    expect(formatWeather(s, 'ft')).toBe('Clear · 10+ mi · 61 °F · NW 5 mph');
    expect(formatWeather(s, 'm')).toBe('Clear · 16 km · 16 °C · NW 8 km/h');
    expect(formatWeather({ ...s, visibilityCensored: false, visibilityM: 56327 }, 'ft')).toMatch(/· 35 mi ·/);
    expect(formatWeather({ ...s, visibilityM: 805, visibilityCensored: false }, 'ft')).toMatch(/^Fog · 0\.50 mi ·/);
    expect(formatWeather({ ...s, wind: { dirDeg: 0, speedMs: 0, gustMs: 0 } }, 'ft')).toMatch(/· calm$/);
  });
  it('compass points', () => {
    expect([0, 22.5, 90, 180, 270, 348.75, 359].map(compass)).toEqual(['N', 'NNE', 'E', 'S', 'W', 'N', 'N']);
  });
});

describe('the source line', () => {
  const base = { kind: 'live', dataKind: 'live', loading: false, unavailable: false, stale: false, partial: false, via: 'function', observedAtMs: Date.UTC(2026, 10, 22, 14, 56),
    station: 'KLAS', sources: [{ id: 'open-meteo', ok: true }], attribution: [], overridden: [], aerosol: 'cams', preset: null, year: null, dataTimeMs: Date.UTC(2026, 10, 22, 15) };
  it('live, history, this date in history', () => {
    expect(describeSource(base, fmt)).toBe('Live · KLAS report 14:56');
    expect(describeSource({ ...base, dataKind: 'archive', aerosol: 'climatology', observedAtMs: null }, fmt)).toBe('History · 2026-11-22 · reanalysis · aerosols: climatology');
    expect(describeSource({ ...base, kind: 'history', year: 1975 }, fmt)).toBe('This date in 1975 · KLAS report 14:56');
  });
  it('says what did not answer, and when it is stale or loading or unavailable', () => {
    expect(describeSource({ ...base, sources: [{ id: 'open-meteo-air', ok: false }, { id: 'iem', ok: false }] }, fmt)).toBe('Live · KLAS report 14:56 · no aerosols, archived reports');
    expect(describeSource({ ...base, sources: [{ id: 'aviationweather', ok: false }, { id: 'nws', ok: true }] }, fmt)).toBe('Live · KLAS report 14:56');
    expect(describeSource({ ...base, via: 'open-meteo', observedAtMs: null }, fmt)).toBe('Live · model · reports unavailable');
    expect(describeSource({ ...base, stale: true }, fmt)).toBe('Live · KLAS report 14:56 · not updated lately');
    expect(describeSource({ ...base, loading: true }, fmt)).toBe('Loading the weather…');
    expect(describeSource({ ...base, unavailable: true }, fmt)).toBe('Weather unavailable · showing Clear');
  });
  it('every override is visible', () => {
    expect(describeOverride(base)).toBe(null);
    expect(describeOverride({ ...base, kind: 'preset', preset: 'monsoon' })).toBe('Preset: Monsoon storm');
    expect(describeOverride({ ...base, overridden: ['haze', 'windDir'] })).toBe('Adjusted: haze, wind direction');
    expect(describeOverride({ ...base, kind: 'preset', preset: 'haboob', overridden: ['rain'] })).toBe('Preset: Haboob, adjusted: rain');
  });
});

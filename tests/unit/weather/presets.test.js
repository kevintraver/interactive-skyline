// T5.1: presets are complete samples (plan 01, sections 4.2 and 6.4); overrides are a sparse layer on top that
// never touches the data: applying then clearing one returns the data value exactly.
import { describe, it, expect } from 'vitest';
import { PRESETS, presetSample } from '../../../src/weather/presets.js';
import { OVERRIDES, applyOverrides } from '../../../src/weather/overrides.js';
import { validateSample } from '../../../src/weather/schema.js';

const T = Date.UTC(2026, 7, 1, 1);
const GROUND = 620;

describe('presets', () => {
  it('the ten of section 4.2, in order', () => {
    expect(PRESETS.map((p) => p.label)).toEqual(['Clear', 'Hazy', 'Dusty', 'Fair-weather cumulus', 'High cirrus', 'Overcast', 'Rain',
      'Monsoon storm', 'Haboob', 'Virga at sunset']);
  });
  it('each is labelled as a preset and carries the time asked for', () => {
    for (const { id } of PRESETS) {
      const s = presetSample(id, T, GROUND);
      expect(s.t).toBe(T);
      expect(s.source).toEqual({ surface: 'preset', clouds: 'preset', aerosol: 'preset' });
    }
  });
  it('say what their names say', () => {
    const p = (id) => presetSample(id, T, GROUND);
    expect(p('clear').clouds).toEqual([]);
    expect(p('hazy').visibilityM).toBeLessThan(p('clear').visibilityM / 3);
    expect(p('dusty').aerosol.dustUgM3).toBeGreaterThan(100);
    expect(p('cumulus').clouds.map((c) => c.genus)).toEqual(['cu']);
    expect(p('cirrus').clouds.map((c) => c.genus)).toEqual(['ci']);
    expect(Math.max(...p('overcast').clouds.map((c) => c.cover))).toBe(1);
    expect(p('rain').precip.kind).toBe('rain');
    expect(p('monsoon').storm.thunder).toBe(true);
    expect(p('monsoon').clouds.some((c) => c.genus === 'cb')).toBe(true);
    expect(p('haboob').dustWall.active).toBe(true);
    expect(p('virga').precip.kind).toBe('virga');
    expect(p('virga').precip.virgaBaseM).toBeGreaterThan(GROUND + 2000);
  });
  it('cloud bases follow the ground (heights are above sea level)', () => {
    const lv = presetSample('cumulus', T, 620).clouds[0], slc = presetSample('cumulus', T, 1300).clouds[0];
    expect(slc.baseM - lv.baseM).toBeCloseTo(680, 6);
  });
  it('an unknown preset is the clear one', () => expect(presetSample('nope', T, GROUND)).toEqual(presetSample('clear', T, GROUND)));
  it('returns a fresh object each time', () => {
    const a = presetSample('monsoon', T, GROUND);
    a.clouds[0].cover = 0;
    expect(presetSample('monsoon', T, GROUND).clouds[0].cover).not.toBe(0);
  });
});

describe('overrides', () => {
  const data = () => presetSample('cumulus', T, GROUND);

  it('the ten sliders of section 4.2', () => {
    expect(OVERRIDES.map((o) => o.key)).toEqual(['lowCloud', 'highCloud', 'cloudBase', 'haze', 'dust', 'humidity', 'windSpeed', 'windDir', 'rain', 'lightning']);
    for (const o of OVERRIDES) expect(o.max).toBeGreaterThan(o.min);
  });

  it('none: the sample unchanged, and the same object', () => {
    const s = data();
    expect(applyOverrides(s, {}, { groundM: GROUND })).toBe(s);
  });

  it('applying then clearing returns the data value exactly, for every key', () => {
    for (const o of OVERRIDES) {
      const s = data();
      const before = structuredClone(s);
      const v = o.min + (o.max - o.min) * 0.37;
      const out = applyOverrides(s, { [o.key]: v }, { groundM: GROUND });
      expect(out, o.key).not.toEqual(before);
      expect(validateSample(out), o.key).toEqual([]);
      expect(s, `${o.key} left the data alone`).toEqual(before);
      expect(applyOverrides(s, {}, { groundM: GROUND }), o.key).toEqual(before);
    }
  });

  it('each moves what it names', () => {
    const at = (k, v) => applyOverrides(data(), { [k]: v }, { groundM: GROUND });
    expect(at('lowCloud', 0.8).clouds[0].cover).toBeCloseTo(0.8, 9);
    expect(at('lowCloud', 0).clouds).toEqual([]);
    expect(at('highCloud', 0.5).clouds.find((c) => c.genus === 'ci' || c.genus === 'cs').cover).toBeCloseTo(0.5, 9);
    expect(at('cloudBase', 3000).clouds[0].baseM).toBeCloseTo(GROUND + 3000, 6);
    expect(at('haze', 0.6).aerosol.aod550).toBe(0.6);
    expect(at('haze', 0.6).visibilityM).toBeLessThan(data().visibilityM);
    expect(at('dust', 2000).aerosol.dustUgM3).toBe(2000);
    expect(at('dust', 2000).visibilityM).toBeLessThan(10000);
    const humid = at('humidity', 0.9);
    expect(humid.rh).toBe(0.9);
    expect(humid.tempC - humid.dewPointC).toBeLessThan(2);
    expect(at('windSpeed', 12).wind.speedMs).toBe(12);
    expect(at('windSpeed', 12).wind.gustMs).toBeGreaterThanOrEqual(12);
    expect(at('windDir', 270).wind.dirDeg).toBe(270);
    expect(at('rain', 6).precip).toMatchObject({ rateMmH: 6, kind: 'rain' });
    expect(at('lightning', 10).storm).toMatchObject({ thunder: true, flashRatePerMin: 10 });
    expect(at('lightning', 0).storm.thunder).toBe(false);
  });

  it('low cloud on a clear day adds a layer; high cloud likewise', () => {
    const clear = presetSample('clear', T, GROUND);
    const a = applyOverrides(clear, { lowCloud: 0.3 }, { groundM: GROUND });
    expect(a.clouds).toHaveLength(1);
    expect(a.clouds[0].baseM).toBeGreaterThan(GROUND);
    const b = applyOverrides(clear, { highCloud: 0.4, lowCloud: 0.2, cloudBase: 2500 }, { groundM: GROUND });
    expect(b.clouds.map((c) => c.genus)).toEqual(['cu', 'ci']);
    expect(b.clouds[0].baseM).toBeCloseTo(GROUND + 2500, 6);
  });
});

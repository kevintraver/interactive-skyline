// T5.1: the WeatherSample validator (plan 01, section 6.4). Hand-written, no dependency: it rejects missing fields,
// wrong types and values out of range, and accepts every preset.
import { describe, it, expect } from 'vitest';
import { validateSample, GENERA, PRECIP_KINDS } from '../../../src/weather/schema.js';
import { PRESETS, presetSample } from '../../../src/weather/presets.js';
import { rand } from '../../../src/core/rng.js';

const T = Date.UTC(2026, 6, 14, 22);
const good = () => presetSample('cumulus', T, 620);

/** Every leaf path of an object, for the fuzz below. */
function leaves(o, at = []) {
  if (o === null || typeof o !== 'object') return [at];
  if (Array.isArray(o)) return o.length ? o.flatMap((v, i) => leaves(v, [...at, i])) : [at];
  return Object.entries(o).flatMap(([k, v]) => leaves(v, [...at, k]));
}
const getAt = (o, p) => p.reduce((a, k) => a[k], o);
function setAt(o, p, v) { const parent = getAt(o, p.slice(0, -1)); parent[p[p.length - 1]] = v; }
function deleteAt(o, p) { const parent = getAt(o, p.slice(0, -1)); if (Array.isArray(parent)) parent.splice(p[p.length - 1], 1); else delete parent[p[p.length - 1]]; }

describe('validateSample', () => {
  it('accepts a complete sample', () => expect(validateSample(good())).toEqual([]));

  it('rejects things that are not samples', () => {
    for (const v of [null, undefined, 3, 'clear', [], {}]) expect(validateSample(v).length).toBeGreaterThan(0);
  });

  it('names the field that is wrong', () => {
    const s = good();
    s.rh = 1.4;
    expect(validateSample(s)).toEqual([expect.stringContaining('rh')]);
    const w = good();
    w.wind.dirDeg = 360;
    expect(validateSample(w)).toEqual([expect.stringContaining('wind.dirDeg')]);
  });

  it('checks the cloud layers: genus, order, base below top, at most four', () => {
    const s = good();
    s.clouds = [{ genus: 'cu', baseM: 3000, topM: 4000, cover: 0.3 }, { genus: 'ci', baseM: 9000, topM: 10000, cover: 0.2 }];
    expect(validateSample(s)).toEqual([]);
    expect(validateSample({ ...s, clouds: [...s.clouds].reverse() })).toEqual([expect.stringContaining('lowest first')]);
    expect(validateSample({ ...s, clouds: [{ genus: 'nimbus', baseM: 1, topM: 2, cover: 1 }] })[0]).toMatch(/genus/);
    expect(validateSample({ ...s, clouds: [{ genus: 'st', baseM: 900, topM: 800, cover: 1 }] })[0]).toMatch(/topM/);
    const five = Array.from({ length: 5 }, (_, i) => ({ genus: 'ac', baseM: 4000 + i * 100, topM: 4050 + i * 100, cover: 0.1 }));
    expect(validateSample({ ...s, clouds: five })[0]).toMatch(/at most four/);
  });

  it('knows the genera and precipitation kinds of section 6.4 (plus snow, for Salt Lake City)', () => {
    expect(GENERA).toEqual(['cu', 'tcu', 'cb', 'sc', 'st', 'ac', 'as', 'ci', 'cs']);
    expect(PRECIP_KINDS).toEqual(['none', 'drizzle', 'rain', 'snow', 'virga', 'hail']);
  });

  // fuzz: from a valid sample, delete any one field, or set it to a value of the wrong type or far out of range;
  // the validator must notice every time. 600 seeded cases.
  it('fuzz: any one field deleted, retyped or out of range is rejected', () => {
    const base = good();
    base.clouds = [{ genus: 'cu', baseM: 2500, topM: 3500, cover: 0.3 }];
    base.windAloft = [{ level: 700, dirDeg: 250, speedMs: 12 }];
    base.dustWall = { active: true, bearingDeg: 120, distanceM: 20000, speedMs: 15, heightM: 1500 };
    base.wxCodes = ['HZ'];
    const paths = leaves(base).filter((p) => p.length);
    const nullable = new Set(['precip.virgaBaseM', 'storm.capeJKg']);
    const BAD = [undefined, 'x', NaN, Infinity, -1e9, 1e9, {}, true];
    let rejected = 0, cases = 0;
    for (let i = 0; i < 600; i++) {
      const p = paths[Math.floor(rand(7, i, 0) * paths.length)];
      const s = structuredClone(base);
      const how = Math.floor(rand(7, i, 1) * (BAD.length + 1));
      if (how === BAD.length) deleteAt(s, p); else setAt(s, p, BAD[how]);
      const key = p.filter((k) => typeof k === 'string').join('.');
      // some mutations are still valid (a string in wxCodes, true for a boolean, a deleted wxCodes entry)
      const v = how === BAD.length ? '(deleted)' : BAD[how];
      const stillValid = (key === 'wxCodes' && (v === 'x' || v === '(deleted)'))
        || (typeof getAt(base, p) === 'boolean' && v === true)
        || (nullable.has(key) && v === '(deleted)' && false)
        || (key === 't' && (v === -1e9 || v === 1e9));
      if (stillValid) continue;
      cases++;
      if (validateSample(s).length) rejected++;
      else throw new Error(`accepted ${key} = ${String(v)}`);
    }
    expect(rejected).toBe(cases);
    expect(cases).toBeGreaterThan(400);
  });

  it('every preset validates, at the ground of either city', () => {
    for (const { id } of PRESETS) for (const ground of [620, 1300]) expect(validateSample(presetSample(id, T, ground)), id).toEqual([]);
  });
});

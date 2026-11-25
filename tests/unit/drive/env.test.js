// env.js: the drive's port over plan 01's clock, ephemeris, environment and weather (plan 02, section 11.1; third
// stretch, decisions 4, 5 and 9), and the clear sky's illuminance by the sun's elevation.
import { describe, it, expect } from 'vitest';
import { createEnv, ephemerisOn, ambientLux, NIGHT_SKY_LUX } from '../../../src/drive/env.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createEphemeris } from '../../../src/sky/ephemeris.js';
import { LV } from './helpers.js';

// Reference positions at the Las Vegas origin (36.1147 N, 115.1728 W), from an independent published algorithm: NREL's
// Solar Position Algorithm (Reda and Andreas 2004) as implemented by pvlib.solarposition.spa_python, with pressure
// 101325 Pa, 10 C, delta_t 69 s; apparent (refracted) elevation, degrees. Above the horizon only: below it the two
// refraction models part (plan 01's ephemeris has its own tests, tests/unit/sky/ephemeris.test.js).
const REFERENCE = [
  ['2026-01-15T19:00:00Z', 31.6764, 166.2187],
  ['2026-03-20T16:30:00Z', 31.6767, 116.6815],
  ['2026-06-21T20:00:00Z', 76.7788, 197.7296],
  ['2026-08-10T14:15:00Z', 14.8342, 81.4628],
  ['2026-10-05T22:45:00Z', 28.4724, 238.7750],
  ['2026-12-21T00:20:00Z', 1.2135, 239.8016], // near sunset, Dec 20 local
];

/** The drive's port over plan 01's clock and ephemeris, with a stand-in for plan 01's environment state. */
function adapter(state = null) {
  const clock = createSimClock({ zone: LV.tz, timeMs: Date.parse('2026-11-21T20:00:00Z') });
  const ephemeris = createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: 610 });
  return createEnv({ city: LV, app: { clock, env: { state, ephemeris, nodes: {} }, quality: null } });
}

describe('ephemeris (ephemerisOn over plan 01\'s)', () => {
  const env = adapter();

  it.each(REFERENCE)('sun at %s matches SPA within 0.3 degrees', (iso, el, az) => {
    const sun = env.ephemeris.sun(Date.parse(iso));
    expect(Math.abs(sun.elevation - el)).toBeLessThan(0.3);
    expect(Math.abs(sun.azimuth - az)).toBeLessThan(0.3);
  });

  /** The first second at which sun() is at or below `el` (evening) or above it (morning), scanning. */
  const scan = (from, el, evening) => {
    for (let t = from; t < from + 86400000; t += 1000) {
      const e = env.ephemeris.sun(t).elevation;
      if (evening ? e <= el : e >= el) return t;
    }
    return NaN;
  };

  // plan 01's search is on the geometric altitude: the port turns it into the apparent elevation sun() reports (the
  // default moment's -3 degrees was 0.63 degrees early before it did)
  it.each([
    ['2026-11-21T12:00:00Z', true], ['2026-06-21T12:00:00Z', true], ['2026-03-01T12:00:00Z', false],
  ])('timeOfSunElevation(-3) on the local day of %s (evening %s) is within 60 s of sun()', (iso, evening) => {
    const day = Date.parse(iso);
    const t = env.ephemeris.timeOfSunElevation(-3, day, evening);
    const noon = env.ephemeris.solarNoon(day);
    const from = evening ? noon : noon - 43200000;
    expect(Math.abs(t - scan(from, -3, evening))).toBeLessThan(60000);
    expect(Math.abs(env.ephemeris.sun(t).elevation + 3)).toBeLessThan(0.01);
  });

  it('works on the local calendar day, not the UTC one', () => {
    // 2026-11-22T03:00Z is still Nov 21 in Las Vegas; dusk that evening is about 00:45Z on Nov 22
    const t = env.ephemeris.timeOfSunElevation(-3, Date.parse('2026-11-22T03:00:00Z'), true);
    expect(new Date(t).toISOString().slice(0, 13)).toBe('2026-11-22T00');
    const morning = env.ephemeris.timeOfSunElevation(-3, Date.parse('2026-11-22T03:00:00Z'), false);
    expect(morning).toBeLessThan(t);
    expect(new Date(morning).toISOString().slice(0, 10)).toBe('2026-11-21');
  });

  it('returns NaN when the sun never gets there', () => {
    expect(env.ephemeris.timeOfSunElevation(89, Date.parse('2026-11-21T20:00:00Z'), true)).toBeNaN();
  });

  it('answers with plan 01\'s ephemeris directly as well', () => {
    const eph = ephemerisOn(createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: 610 }), LV.tz);
    const t = Date.parse('2026-06-21T20:00:00Z');
    expect(eph.sun(t)).toEqual(env.ephemeris.sun(t));
  });

  it('has quality High and dry weather without plan 01\'s quality and weather service', () => {
    expect(env.quality.preset).toBe('high');
    expect(typeof env.quality.onChange(() => {})).toBe('function');
    expect(env.weather.state().precipKind).toBe('none');
  });
});

describe('the clear sky\'s illuminance (ambientLux)', () => {
  // Schlyter, radfaq section 10 (the table env.js carries): values at its own nodes, plus the night sky's 0.002 lux.
  it.each([
    [90, 129000], [30, 46300], [0, 759], [-0.83, 450], [-6, 3.41], [-12, 0.00806], [-18, 0.000645],
  ])('ambientLux(%s) is the tabulated %s lux', (el, lux) => {
    const tol = el === -0.83 ? 0.06 : 0.012; // -0.83 (sunset) is between nodes
    expect(Math.abs((ambientLux(el) - NIGHT_SKY_LUX) / lux - 1)).toBeLessThan(tol);
  });

  it('runs from full day through the twilights to a moonless night, monotonically', () => {
    expect(ambientLux(-40)).toBeCloseTo(NIGHT_SKY_LUX, 5);
    expect(ambientLux(120)).toBe(ambientLux(90));
    expect(ambientLux(NaN)).toBe(NIGHT_SKY_LUX);
    let prev = 0;
    for (let el = -30; el <= 90; el += 0.1) {
      const e = ambientLux(el);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
    // civil twilight ends near the "dark limit of civil twilight" (3.4 lux), nautical near 0.01 lux
    expect(ambientLux(-6)).toBeCloseTo(3.4, 1);
    expect(ambientLux(-12)).toBeLessThan(0.02);
  });

  it('on the port, is env.state\'s for the sun now and the table for another elevation', () => {
    const env = adapter({ sun: { altDeg: -4 }, sky: { horizontalLux: 37 } });
    expect(env.lighting.ambientLux()).toBe(37);
    expect(env.lighting.ambientLux(-4.01)).toBe(37);
    expect(env.lighting.ambientLux(-6)).toBe(ambientLux(-6));
    expect(env.lighting.ambientLux(20)).toBeGreaterThan(10000);
  });
});

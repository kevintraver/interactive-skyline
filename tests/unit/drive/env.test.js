import { describe, it, expect, vi } from 'vitest';
import { createEnv, createClock, RATE_MIN, RATE_MAX } from '../../../src/drive/env.js';
import { LV } from './helpers.js';

// Reference positions at the Las Vegas origin (36.1147 N, 115.1728 W). NOAA's online calculator
// could not be driven from here, so these come from an independent published algorithm: NREL's
// Solar Position Algorithm (Reda and Andreas 2004) as implemented by pvlib.solarposition.spa_python,
// with pressure 101325 Pa, 10 C, delta_t 69 s; apparent (refracted) elevation, degrees.
// SPA stops refracting below -0.83 degrees, NOAA does not (about 0.12 degrees at -2.7), hence 0.3.
const REFERENCE = [
  ['2026-01-15T19:00:00Z', 31.6764, 166.2187],
  ['2026-03-20T16:30:00Z', 31.6767, 116.6815],
  ['2026-06-21T20:00:00Z', 76.7788, 197.7296],
  ['2026-08-10T14:15:00Z', 14.8342, 81.4628],
  ['2026-10-05T22:45:00Z', 28.4724, 238.7750],
  ['2026-12-21T00:20:00Z', 1.2135, 239.8016], // near sunset, Dec 20 local
  ['2026-11-21T00:40:00Z', -2.7221, 247.2596], // civil twilight, Nov 20 local
];

describe('ephemeris', () => {
  const env = createEnv({ city: LV, nowMs: Date.parse('2026-11-21T20:00:00Z') });

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

  it('has the stand-in quality and weather', () => {
    expect(env.quality.preset).toBe('high');
    expect(typeof env.quality.onChange(() => {})).toBe('function');
    expect(env.weather.state().precipKind).toBe('none');
  });
});

describe('clock', () => {
  it('moves only when playing, by dt * rate', () => {
    const c = createClock({ nowMs: 1000 });
    expect(c.playing).toBe(false);
    c.advance(500);
    expect(c.now()).toBe(1000);
    c.play();
    c.advance(500);
    expect(c.now()).toBe(1500);
    c.setRate(4);
    c.advance(250);
    expect(c.now()).toBe(2500);
    c.pause();
    c.advance(1000);
    expect(c.now()).toBe(2500);
  });

  it('clamps the rate', () => {
    const c = createClock();
    c.setRate(100);
    expect(c.rate).toBe(RATE_MAX);
    c.setRate(0);
    expect(c.rate).toBe(RATE_MIN);
    c.setRate('junk');
    expect(c.rate).toBe(1);
  });

  it('emits events and unsubscribes', () => {
    const c = createClock({ nowMs: 0 });
    const seen = [];
    const fns = ['tick', 'seek', 'rate', 'play', 'pause'].map((type) => c.on(type, (e) => seen.push([type, e.simMs, e.dtSimMs])));
    c.seek(100);
    c.play();
    c.play(); // no second event
    c.setRate(2);
    c.advance(10);
    c.pause();
    c.advance(10); // paused: no tick
    expect(seen).toEqual([['seek', 100, 100], ['play', 100, 0], ['rate', 100, 0], ['tick', 120, 20], ['pause', 120, 0]]);
    fns.forEach((off) => off());
    const spy = vi.fn();
    c.seek(5);
    expect(spy).not.toHaveBeenCalled();
    expect(seen.length).toBe(5);
    expect(() => c.on('nope', spy)).toThrow();
  });
});

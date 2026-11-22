import { describe, it, expect } from 'vitest';
import { EARTH_RADIUS, REFRACTION_K, EFFECTIVE_RADIUS, curveDrop, horizonDistance, toLocal, toGeodetic, planetCenter, altitudeOf } from '../../../src/core/earth.js';
import cities from '../../../data/cities.json' with { type: 'json' };

describe('earth', () => {
  it('uses the radius the app has always used', () => {
    expect(EFFECTIVE_RADIUS).toBe(6371000 * (7 / 6));
    expect(EFFECTIVE_RADIUS).toBeCloseTo(EARTH_RADIUS / (1 - REFRACTION_K), 6);
  });

  it('curveDrop equals the original expression to the last bit', () => {
    const EARTH_R = 6371000 * (7 / 6);
    const old = (x, z) => (x * x + z * z) / (2 * EARTH_R);
    for (const [x, z] of [[0, 0], [1, 2], [-48000, 34000], [12345.678, -9876.5], [60000, -65000]]) expect(curveDrop(x, z)).toBe(old(x, z));
  });

  it('horizonDistance from cruise altitude is 398.2 km', () => {
    expect(horizonDistance(10668) / 1000).toBeCloseTo(398.2, 1);
  });

  it('puts Primm where PROJ does', () => {
    // pyproj 3 with the +proj=tmerc string of public/data/lv/terrain.json gives (-19525.3607, -55911.7702).
    // The plan's acceptance line said (-19.4 km, -56.1 km) +- 0.2 km; that is 0.13 and 0.19 km off the true value.
    const p = toLocal(35.6106, -115.3883, cities.lv.origin);
    expect(Math.abs(p.x - -19525.3607)).toBeLessThan(0.01);
    expect(Math.abs(p.y - -55911.7702)).toBeLessThan(0.01);
  });

  it('round-trips latitude and longitude', () => {
    for (const city of Object.values(cities)) {
      for (const [x, y] of [[0, 0], [5000, -3000], [-60000, 50000]]) {
        const g = toGeodetic(x, y, city.origin), back = toLocal(g.lat, g.lon, city.origin);
        expect(Math.abs(back.x - x)).toBeLessThan(1e-3);
        expect(Math.abs(back.y - y)).toBeLessThan(1e-3);
      }
      expect(toLocal(city.origin.lat, city.origin.lon, city.origin)).toEqual({ x: 0, y: 0 });
    }
  });

  it('places the origin at the city base elevation', () => {
    const city = cities.lv;
    expect(planetCenter(city).y).toBe(-(city.base + EFFECTIVE_RADIUS));
    expect(altitudeOf({ x: 0, y: 0, z: 0 }, city)).toBeCloseTo(city.base, 3);
  });
});

// T0.7: every city carries the fields plan 01 reads, with the right shapes. Add a field here when a plan task
// starts reading it, so a city that lacks it fails here and not in the browser.
import { describe, it, expect } from 'vitest';
import cities from '../../data/cities.json' with { type: 'json' };

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => typeof v === 'string' && v.length > 0;

describe.each(Object.entries(cities))('cities.json: %s', (id, c) => {
  it('has a name, origin, base, bbox and LiDAR year', () => {
    expect(str(c.name)).toBe(true);
    expect(num(c.origin.lat) && num(c.origin.lon)).toBe(true);
    expect(num(c.base)).toBe(true);
    expect(c.bbox).toHaveLength(4);
    expect(num(c.lidar.year)).toBe(true);
  });
  it('has terrain grids, a shadow square and views', () => {
    for (const g of ['far', 'near']) for (const k of ['x0', 'y0', 'x1', 'y1', 'step']) expect(num(c.terrain[g][k]), `${g}.${k}`).toBe(true);
    for (const k of ['x', 'y', 'half']) expect(num(c.shadow[k])).toBe(true);
    expect(c.views.length).toBeGreaterThan(0);
    for (const v of c.views) {
      expect(str(v.id) && str(v.label)).toBe(true);
      expect(num(v.eye.x) && num(v.eye.y) && (num(v.eye.agl) || num(v.eye.elev))).toBe(true);
      expect(num(v.target.x) && num(v.target.y) && num(v.target.agl)).toBe(true);
    }
  });
  it('has the night-lights grids that the lamp and night-lights pipelines share (plan 01, T4.0, T4.4)', () => {
    for (const g of ['metro', 'region']) {
      const n = c.nightlights[g];
      for (const k of ['x0', 'y0', 'x1', 'y1', 'cell']) expect(num(n[k]), `${g}.${k}`).toBe(true);
      expect(Number.isInteger((n.x1 - n.x0) / n.cell) && Number.isInteger((n.y1 - n.y0) / n.cell)).toBe(true);
    }
    expect(c.nightlights.metro.cell).toBe(500);
  });
  it('has a time zone, a weather station and its elevation (plan 01, T0.7)', () => {
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: c.tz })).not.toThrow();
    expect(c.icao).toMatch(/^K[A-Z]{3}$/);
    expect(c.iemStation).toBe(c.icao.slice(1));
    expect(c.iemNetwork).toMatch(/^[A-Z]{2}_ASOS$/);
    expect(num(c.stationElevationM)).toBe(true);
    // the airport is near the city's base elevation (within 300 m)
    expect(Math.abs(c.stationElevationM - c.base)).toBeLessThan(300);
    expect(str(c.stationNote)).toBe(true);
  });
});

// Plan 03, F0.1: a city with an airport says which one and where its detailed area is. The box must hold all four
// runways and the terminals.
describe('cities.json: airport block (plan 03, F0.1)', () => {
  it('lv has the airport, its box and its arrival runways', () => {
    const a = cities.lv.airport;
    expect(a.faa).toBe('LAS');
    expect(a.box).toHaveLength(4);
    expect(a.box.every(num)).toBe(true);
    const [x0, y0, x1, y1] = a.box;
    expect(x1 > x0 && y1 > y0).toBe(true);
    expect(a.arrivals).toEqual(['19L', '19R', '26L', '26R']);
    expect(str(a.boxNote)).toBe(true);
  });
  it('the lv box holds the four runways and the terminals, with room to spare', () => {
    const [x0, y0, x1, y1] = cities.lv.airport.box;
    const inside = ([x, y], margin = 250) => x >= x0 + margin && x <= x1 - margin && y >= y0 + margin && y <= y1 - margin;
    // every runway end, map metres, from FAA NASR (cycle of 29 Oct 2026) through scripts/build_airport.py
    const points = {
      '1L': [219, -4369], '19R': [1474, -1668], '1R': [479, -4489], '19L': [1733, -1789],
      '8L': [137, -4254], '26R': [4658, -4248], '8R': [1024, -4557], '26L': [4232, -4553],
      // the terminals and the gates, from the map (estimates: the building data stops at y = -3,300)
      'Terminal 1': [2000, -2900], 'Terminal 3': [2300, -3600], 'D gates': [1200, -3500],
    };
    for (const [name, p] of Object.entries(points)) expect(inside(p), name).toBe(true);
    // the box is the airport, not the valley: under 7 km by 5 km
    expect(x1 - x0).toBeLessThan(7000);
    expect(y1 - y0).toBeLessThan(5000);
  });
  it('no other city has an airport block yet', () => {
    for (const [id, c] of Object.entries(cities)) if (id !== 'lv') expect(c.airport, id).toBeUndefined();
  });
});

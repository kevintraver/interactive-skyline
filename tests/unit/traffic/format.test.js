// D6.2: the traffic v1 file, its checker and the synthetic generator. If the real file for i15n is
// present (D6.1's output), it must pass the same checker.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseTraffic, syntheticTraffic, TrafficError, weeklyShape } from '../../../src/drive/traffic/format.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

describe('parseTraffic', () => {
  const good = syntheticTraffic({ length: 12000, segmentLength: 4000 });

  it('accepts the synthetic file and keeps unknown fields', () => {
    const f = parseTraffic({ ...clone(good), extra: { a: 1 } });
    expect(f.range).toEqual([0, 12000]);
    expect(f.directions.with.segments).toHaveLength(3);
    expect(f.extra).toEqual({ a: 1 });
    expect(f.directions.against.road).toBe('synthetic.opp');
  });
  it('accepts a JSON string', () => expect(parseTraffic(JSON.stringify(good)).route).toBe('synthetic'));
  it('rescales lane shares that sum to nearly 1', () => {
    const g = clone(good);
    g.directions.with.segments[0].laneShares = [0.334, 0.333, 0.336];
    const s = parseTraffic(g).directions.with.segments[0].laneShares;
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  const broken = [
    ['a wrong version', (g) => { g.version = 2; }, /version/],
    ['an unknown time zone', (g) => { g.tz = 'Mars/Olympus'; }, /tz/],
    ['a gap between segments', (g) => { g.directions.with.segments[1].s0 += 5; }, /does not start/],
    ['s1 <= s0', (g) => { g.directions.with.segments[0].s1 = g.directions.with.segments[0].s0; }, /s0 < s1/],
    ['a flow table of the wrong length', (g) => { g.directions.against.segments[0].flow[2].pop(); }, /168/],
    ['a negative flow', (g) => { g.directions.with.segments[0].flow[0][5] = -1; }, /flow\[0\]\[5\]/],
    ['shares of the wrong count', (g) => { g.directions.with.segments[0].laneShares = [0.5, 0.5]; }, /laneShares/],
    ['shares far from 1', (g) => { g.directions.with.segments[0].laneShares = [0.5, 0.5, 0.5]; }, /sum/],
    ['directions covering different ranges', (g) => { g.directions.against.segments.at(-1).s1 += 100; }, /covers/],
    ['a missing direction', (g) => { delete g.directions.against; }, /against/],
    ['too many lanes', (g) => { const s = g.directions.with.segments[0]; s.lanes = 9; }, /lanes/],
    ['a bad season map', (g) => { g.seasonOfMonth[3] = 7; }, /seasonOfMonth/],
  ];
  for (const [what, edit, msg] of broken) {
    it(`rejects ${what}`, () => {
      const g = clone(good);
      edit(g);
      expect(() => parseTraffic(g)).toThrow(TrafficError);
      expect(() => parseTraffic(g)).toThrow(msg);
    });
  }
});

describe('syntheticTraffic', () => {
  it('has the plan\'s weekly shape: Friday out, Sunday back', () => {
    const w = weeklyShape(24000);
    const day = (d) => w.slice(d * 24, d * 24 + 24).reduce((a, b) => a + b, 0);
    const mean = [0, 1, 2, 3, 4, 5, 6].reduce((a, d) => a + day(d), 0) / 7;
    expect(day(4) / mean).toBeCloseTo(1.36, 2);
  });
  it('takes a constant or a function for the flow', () => {
    expect(syntheticTraffic({ flow: 1234 }).directions.with.segments[0].flow[1][77]).toBe(1234);
    const f = syntheticTraffic({ flow: (how, season, i, dir) => (dir === 'with' ? how : season) });
    expect(f.directions.with.segments[1].flow[0][100]).toBe(100);
    expect(f.directions.against.segments[1].flow[3][100]).toBe(3);
  });
});

const real = new URL('../../../public/data/lv/traffic/i15n.json', import.meta.url);
describe.skipIf(!fs.existsSync(real))('public/data/lv/traffic/i15n.json (D6.1 output)', () => {
  it('passes parseTraffic and covers the route', () => {
    const f = parseTraffic(fs.readFileSync(real, 'utf8'));
    expect(f.route).toBe('i15n');
    const routes = JSON.parse(fs.readFileSync(new URL('../../../public/data/lv/routes.json', import.meta.url), 'utf8'));
    const r = routes.routes.find((x) => x.id === 'i15n');
    expect(f.range[0]).toBeLessThanOrEqual(r.s0 + 1);
    expect(f.range[1]).toBeGreaterThanOrEqual(r.s1 - 1);
    expect(f.directions.with.road).toBe(r.road);
  });
});

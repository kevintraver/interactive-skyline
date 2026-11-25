import { describe, it, expect } from 'vitest';
import { loadRoutes, parseRoutes, RoutesError } from '../../../src/drive/routes.js';
import { io, fixture } from './helpers.js';

describe('routes', () => {
  it('loads the synthetic fixtures', async () => {
    const r = await loadRoutes(io);
    expect(r.routes.map((x) => x.id)).toEqual(['test', 'south']);
    const test = r.route('test');
    expect(test.road).toBe('test.main');
    expect(test.futureField).toEqual({ kept: true }); // unknown fields survive
    expect(r.roadOf(test).id).toBe('test.main');
    expect(r.roadOf('south').length).toBe(1200);
    expect(r.route('nope')).toBeNull();
    expect(r.roadnet.roads.length).toBe(2);
    expect(r.source.osm).toBe('synthetic');
  });

  const { roadnet } = fixture();
  const base = () => ({ version: 1, routes: [{ id: 'a', road: 'test.main', s0: 0, s1: 1000, lane: 1, markers: [] }] });
  const bad = (edit, pattern) => {
    const doc = base();
    edit(doc);
    expect(() => parseRoutes(doc, roadnet)).toThrow(RoutesError);
    expect(() => parseRoutes(doc, roadnet)).toThrow(pattern);
  };

  it('fills in defaults', () => {
    const doc = base();
    delete doc.routes[0].lane;
    const [r] = parseRoutes(doc, roadnet).routes;
    expect(r.lane).toBe(1);
    expect(r.length).toBe(1000);
    expect(r.label).toBe('a');
  });

  it('rejects a route on a missing road', () => bad((d) => { d.routes[0].road = 'i15n.main'; }, /names road "i15n.main"/));
  it('rejects an s range outside the road', () => bad((d) => { d.routes[0].s1 = 3500; }, /outside road "test.main"/));
  it('rejects a negative start', () => bad((d) => { d.routes[0].s0 = -10; }, /outside road/));
  it('rejects s0 >= s1', () => bad((d) => { d.routes[0].s1 = 0; }, /s0 < s1/));
  it('rejects a marker outside the route', () => bad((d) => { d.routes[0].markers = [{ s: 1500, label: 'x' }]; }, /marker 0/));
  it('rejects a reveal outside the route', () => bad((d) => { d.routes[0].reveal = { s: 2000 }; }, /reveal/));
  it('rejects a bad lane', () => bad((d) => { d.routes[0].lane = 0; }, /lane/));
  it('rejects a repeated id', () => bad((d) => { d.routes.push({ ...d.routes[0] }); }, /repeated/));
  it('rejects another version', () => bad((d) => { d.version = 2; }, /version/));

  it('passes roadnet errors through', async () => {
    await expect(loadRoutes({ ...io, fetchBinary: async () => new ArrayBuffer(27) })).rejects.toThrow(/roadnet/);
  });
});

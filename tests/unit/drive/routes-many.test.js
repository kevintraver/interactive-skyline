// The loader with routes on more than one RoadNet: each route names its files, a RoadNet is fetched
// only when a route on it is chosen, once, and the routes on it are checked against it then.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { loadRoutes, parseRoutes, filesOf, RoutesError } from '../../../src/drive/routes.js';
import { io as fixtureIo, fixture } from './helpers.js';

/** Two RoadNets made of the synthetic one: "test" on roadnet.json, "south" on roadnet-b.json. */
function twoNets({ southRoad = 'test.south', failB = false } = {}) {
  const state = { failB };
  const doc = JSON.parse(readFileSync(new URL('../../fixtures/drive/routes.json', import.meta.url), 'utf8'));
  doc.routes[1].files = { roadnet: 'roadnet-b.json', signs: 'signs-b.json', traffic: 'traffic/south.json' };
  doc.routes[1].road = southRoad;
  const calls = [];
  const alias = (n) => n.replace('roadnet-b.', 'roadnet.');
  const io = {
    fetchJson: async (n) => { calls.push(n); return n === 'routes.json' ? structuredClone(doc) : fixtureIo.fetchJson(alias(n)); },
    fetchBinary: async (n) => {
      calls.push(n);
      if (state.failB && n === 'roadnet-b.bin') throw new Error('HTTP 404');
      return fixtureIo.fetchBinary(alias(n));
    },
  };
  return { doc, io, calls, state };
}

describe('routes on several RoadNets', () => {
  it('names the files of a route, with the first route\'s defaults', () => {
    expect(filesOf({ id: 'i15n' })).toEqual({ roadnet: 'roadnet.json', bin: 'roadnet.bin', signs: 'signs.json', barriers: 'barriers.json', traffic: 'traffic/i15n.json' });
    expect(filesOf({ id: 'x', files: { roadnet: 'roadnet-x.json', signs: 'signs-x.json' } }))
      .toEqual({ roadnet: 'roadnet-x.json', bin: 'roadnet-x.bin', signs: 'signs-x.json', barriers: 'barriers-x.json', traffic: 'traffic/x.json' });
    expect(filesOf({ id: 'x', files: { roadnet: 'roadnet-x.json', barriers: 'b.json' } }).barriers).toBe('b.json');
    expect(() => filesOf({ id: 'x', files: { roadnet: 'roadnet-x.bin' } })).toThrow(RoutesError);
  });

  it('loads routes.json and only the first route\'s RoadNet', async () => {
    const { io, calls } = twoNets();
    const net = await loadRoutes(io);
    expect(calls).toEqual(['routes.json', 'roadnet.json', 'roadnet.bin']);
    expect(net.routes.map((r) => r.id)).toEqual(['test', 'south']);
    expect(net.isLoaded('test')).toBe(true);
    expect(net.isLoaded('south')).toBe(false);
    expect(net.roadnetOf('south')).toBeNull();
    expect(net.roadOf('test').id).toBe('test.main');
    expect(() => net.roadOf('south')).toThrow(/loadRoute\("south"\)/);
    expect(net.filesOf('south').signs).toBe('signs-b.json');
  });

  it('loads another route\'s RoadNet on demand, once, and makes it current', async () => {
    const { io, calls } = twoNets();
    const net = await loadRoutes(io);
    const first = net.roadnet;
    const [a, b] = await Promise.all([net.loadRoute('south'), net.loadRoute('south')]);
    expect(calls.filter((n) => n.startsWith('roadnet-b'))).toEqual(['roadnet-b.json', 'roadnet-b.bin']);
    expect(a.roadnet).toBe(b.roadnet);
    expect(a.road.id).toBe('test.south');
    expect(net.roadnet).toBe(a.roadnet);
    expect(net.roadnet).not.toBe(first);
    expect(net.roadOf(net.route('south')).length).toBe(1200);
    // back to the first: nothing is fetched again
    const n = calls.length;
    const back = await net.loadRoute('test');
    expect(calls.length).toBe(n);
    expect(back.roadnet).toBe(first);
    expect(net.roadnet).toBe(first);
  });

  it('can start on any route', async () => {
    const { io, calls } = twoNets();
    const net = await loadRoutes(io, { route: 'south' });
    expect(calls).toEqual(['routes.json', 'roadnet-b.json', 'roadnet-b.bin']);
    expect(net.isLoaded('test')).toBe(false);
    expect(net.roadOf('south').id).toBe('test.south');
  });

  it('checks a route against its own RoadNet only, when that is loaded', async () => {
    const { io, doc } = twoNets({ southRoad: 'nope.main' });
    const { roadnet } = fixture();
    expect(() => parseRoutes(doc, roadnet)).not.toThrow(); // "south" is not on roadnet.json
    const net = await loadRoutes(io);
    await expect(net.loadRoute('south')).rejects.toThrow(/names road "nope.main", which is not in roadnet-b.json/);
  });

  it('rejects an unknown route and lets a failed download be retried', async () => {
    const { io, state } = twoNets({ failB: true });
    const net = await loadRoutes(io);
    await expect(net.loadRoute('nope')).rejects.toThrow(/no route "nope"/);
    await expect(net.loadRoute('south')).rejects.toThrow(/404/);
    state.failB = false;
    expect((await net.loadRoute('south')).road.id).toBe('test.south');
  });
});

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const diskIo = {
  fetchJson: async (n) => JSON.parse(readFileSync(new URL(n, DATA), 'utf8')),
  fetchBinary: async (n) => { const b = readFileSync(new URL(n, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
};
const doc = existsSync(new URL('routes.json', DATA)) ? JSON.parse(readFileSync(new URL('routes.json', DATA), 'utf8')) : null;

describe.skipIf(!doc || doc.routes.length < 3)('public/data/lv: the three routes', () => {
  it('lists i15n, i15s and us93, each naming files that exist', () => {
    expect(doc.routes.map((r) => r.id)).toEqual(['i15n', 'i15s', 'us93']);
    for (const r of doc.routes) {
      const f = filesOf(r);
      expect(existsSync(new URL(f.roadnet, DATA))).toBe(true);
      expect(existsSync(new URL(f.bin, DATA))).toBe(true);
      expect(f.traffic).toBe(`traffic/${r.id}.json`);
      expect(existsSync(new URL(f.signs, DATA))).toBe(true);
      expect(existsSync(new URL(f.barriers, DATA))).toBe(true);
    }
    expect(filesOf(doc.routes[0])).toMatchObject({ roadnet: 'roadnet.json', signs: 'signs.json' });
    expect(filesOf(doc.routes[1])).toMatchObject({ roadnet: 'roadnet-i15s.json', signs: 'signs-i15s.json' });
    expect(filesOf(doc.routes[2])).toMatchObject({ roadnet: 'roadnet-us93.json', signs: 'signs-us93.json' });
  });

  it('loads each route\'s RoadNet with its own carriageways', async () => {
    const net = await loadRoutes(diskIo);
    expect(net.roadOf('i15n').id).toBe('i15n.main');
    for (const [id, opp] of [['i15s', 'i15n.opp'], ['us93', 'us93s.opp']]) {
      const { roadnet, road, route } = await net.loadRoute(id);
      expect(road.id).toBe(`${id}.main`);
      expect(route.opposite).toBe(opp);
      expect(roadnet.roads.some((r) => r.id === opp)).toBe(true);
      expect(roadnet.roads.some((r) => r.id === 'i15n.main')).toBe(false);
      expect(Math.abs(road.length - route.s1)).toBeLessThan(1e-3);
    }
  });
});

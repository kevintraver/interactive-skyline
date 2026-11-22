// The terrain patches load with the route that passes them (session.js addPatches): only US-93 crosses the Hoover Dam
// patch, so I-15's routes never fetch it; the provider fetches only the patches asked for; a patch cut out of the wide
// mesh later gives the same triangles as one cut out when it was built; and ground that arrives later reaches the
// parts that add terms to ground materials (parts.js eachGround).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTerrain } from '../../../src/world/terrain/index.js';
import { buildWideMesh, cutWideMesh, wideIndex } from '../../../src/world/terrain/widemesh.js';
import { buildPatches, patchesCrossing, PATCH_REACH } from '../../../src/world/terrain/patches.js';
import { eachGround } from '../../../src/drive/parts.js';
import { coarseGridIndex } from '../../../src/drive/vehicle/mirrors.js';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const bytes = (file) => { const b = readFileSync(new URL(file, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
const routes = JSON.parse(readFileSync(new URL('routes.json', DATA), 'utf8')).routes;
const BASE = 620;
const buffers = { near: bytes(meta.grids.near.file), far: bytes(meta.grids.far.file) };
const makeTerrain = () => {
  const fetchBinary = vi.fn(async (file) => bytes(file));
  return { terrain: createTerrain({ meta, buffers, base: BASE, fetchBinary }), fetchBinary };
};

describe('patchesCrossing', () => {
  it('gives the dam patch to US-93 only, of the three routes', () => {
    const of = (id) => patchesCrossing(routes.find((r) => r.id === id).outline, meta.patches);
    expect(of('us93')).toEqual(['dam']);
    expect(of('i15n')).toEqual([]);
    expect(of('i15s')).toEqual([]);
  });

  it('counts a route that passes within the reach of a patch, and not one beyond it', () => {
    const p = { x0: 0, y0: 0, nx: 11, ny: 11, step: 100 }; // 0..1000 each way
    const near = [[1000 + PATCH_REACH - 1, 500], [1000 + PATCH_REACH + 500, 500]];
    const far = [[1000 + PATCH_REACH + 1, 500], [1000 + PATCH_REACH + 500, 500]];
    expect(patchesCrossing(near, { p })).toEqual(['p']);
    expect(patchesCrossing(far, { p })).toEqual([]);
    expect(patchesCrossing([], { p })).toEqual([]);
    expect(patchesCrossing(undefined, { p })).toEqual([]);
  });
});

describe('the provider, patch by patch', () => {
  it('fetches only the patches named, once each', async () => {
    const { terrain, fetchBinary } = makeTerrain();
    expect(await terrain.loadPatches([])).toEqual([]);
    expect(fetchBinary).not.toHaveBeenCalled();
    expect(terrain.grid('dam')).toBeNull();
    const [a, b] = await Promise.all([terrain.loadPatches(['dam']), terrain.loadPatches(['dam'])]);
    expect(a).toBe(b);
    expect(a.map((p) => p.id)).toEqual(['dam']);
    await terrain.loadPatches(); // all: the dam is in already
    expect(fetchBinary.mock.calls.filter(([f]) => f === 'terrain-dam.bin')).toHaveLength(1);
    expect(terrain.grid('dam')).toBe(a[0].grid);
    expect(await terrain.loadPatches(['nowhere'])).toEqual([]);
  });

  it('builds only the patches named', async () => {
    const { terrain } = makeTerrain();
    const opts = { terrain, base: BASE, renderer: { capabilities: { getMaxAnisotropy: () => 1 } }, image: async () => null, json: async () => null };
    const none = await buildPatches({ ...opts, ids: [] });
    expect(none.ground).toEqual([]);
    expect(terrain.grid('dam')).toBeNull();
    const dam = await buildPatches({ ...opts, ids: ['dam'] });
    expect(dam.ground.map(([, id]) => id)).toEqual(['dam']);
  });
});

describe('cutting a patch out of the wide mesh later', () => {
  it('gives the triangles the wide mesh would have had with the patch from the start', async () => {
    const { terrain } = makeTerrain();
    const wide = await terrain.loadWide();
    const hole = terrain.grid('far');
    const [{ grid: dam }] = await terrain.loadPatches(['dam']);
    const late = buildWideMesh({ wide, hole, cuts: [], base: BASE, map: null });
    const before = late.geometry.index.count;
    cutWideMesh(late, { wide, hole, cuts: [dam] });
    const early = buildWideMesh({ wide, hole, cuts: [dam], base: BASE, map: null });
    expect(late.geometry.index.count).toBeLessThan(before);
    expect(Array.from(late.geometry.index.array)).toEqual(Array.from(early.geometry.index.array));
    expect(Array.from(wideIndex({ wide, hole, cuts: [dam] }))).toEqual(Array.from(early.geometry.index.array));
  });

  it('a mirror\'s coarse ground can be rebuilt from the cut index (mirrors.js swapGround)', async () => {
    const { terrain } = makeTerrain();
    const wide = await terrain.loadWide();
    const [{ grid: dam }] = await terrain.loadPatches(['dam']);
    const full = wideIndex({ wide, hole: terrain.grid('far'), cuts: [] });
    const cut = wideIndex({ wide, hole: terrain.grid('far'), cuts: [dam] });
    const a = coarseGridIndex(full, wide.nx, wide.ny, 2), b = coarseGridIndex(cut, wide.nx, wide.ny, 2);
    expect(b.length).toBeLessThan(a.length); // the coarse ground has the patch's hole too
  });
});

describe('eachGround', () => {
  it('runs for the ground there is now and for ground that arrives later, until unsubscribed', () => {
    const list = [[{ id: 'near' }, 'near']];
    const fns = new Set();
    const ctx = {
      ground: list,
      eachGround(fn) { for (const [m, g] of list) fn(m, g); fns.add(fn); return () => fns.delete(fn); },
    };
    const seen = [];
    const off = eachGround(ctx, (m, g) => seen.push(g));
    expect(seen).toEqual(['near']);
    const arrive = (entry) => { list.push(entry); for (const fn of fns) fn(...entry); };
    arrive([{ id: 'dam' }, 'dam']);
    expect(seen).toEqual(['near', 'dam']);
    off();
    arrive([{ id: 'other' }, 'other']);
    expect(seen).toEqual(['near', 'dam']);
  });

  it('falls back to the ground list once for a context without the subscription', () => {
    const seen = [];
    const off = eachGround({ ground: [[{}, 'near'], [{}, 'far']] }, (m, g) => seen.push(g));
    expect(seen).toEqual(['near', 'far']);
    expect(typeof off).toBe('function');
    expect(() => eachGround({}, () => {})).not.toThrow();
  });
});

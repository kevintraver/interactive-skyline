// The drive's terrain patches: the manifest, the provider's choice of grid, continuity at a patch's edge,
// the wide mesh's holes, the patch mesh, its skirt and its water.
import { readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { curveDrop } from '../../../src/world/frame.js';
import { createTerrain, heightField } from '../../../src/world/terrain/index.js';
import { buildPatchMesh, buildWideMesh, cellsInside } from '../../../src/world/terrain/widemesh.js';
import { buildSkirt } from '../../../src/world/terrain/skirt.js';
import { buildWaterMesh, levelAt, LIFT, waterTriangles } from '../../../src/world/terrain/water.js';
import { buildPatches, NO_PATCHES, PATCH_SKIRT } from '../../../src/world/terrain/patches.js';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const bytes = (file) => { const b = readFileSync(new URL(file, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
const cities = JSON.parse(readFileSync(new URL('../../../data/cities.json', import.meta.url), 'utf8'));
const BASE = 620;
const buffers = { near: bytes(meta.grids.near.file), far: bytes(meta.grids.far.file) };
const makeTerrain = (fetchBinary = vi.fn(async (file) => bytes(file))) =>
  ({ terrain: createTerrain({ meta, buffers, base: BASE, fetchBinary }), fetchBinary });
const dam = meta.patches.dam;
const damX1 = dam.x0 + (dam.nx - 1) * dam.step, damY1 = dam.y0 + (dam.ny - 1) * dam.step;

describe('the patch manifest', () => {
  it('lists the dam patch as cities.json describes it, on the wide grid\'s posts', () => {
    const cfg = cities.lv.terrain.patches.find((p) => p.id === 'dam');
    expect(Object.keys(meta.patches)).toEqual(cities.lv.terrain.patches.map((p) => p.id));
    expect([dam.x0, dam.y0, damX1, damY1, dam.step]).toEqual([cfg.x0, cfg.y0, cfg.x1, cfg.y1, cfg.step]);
    const w = meta.grids.wide;
    for (const v of [dam.x0, damX1]) expect((v - w.x0) % w.step).toBe(0);
    for (const v of [dam.y0, damY1]) expect((v - w.y0) % w.step).toBe(0);
    expect(w.step % dam.step).toBe(0);
    // patches are not grids: the map's loader (src/city/data.js) reads only meta.grids.near and .far
    expect(meta.grids.dam).toBeUndefined();
  });

  it('has its files, about 1 MB in all, and the heights file matches its posts', () => {
    expect(statSync(new URL(dam.file, DATA)).size).toBe(dam.nx * dam.ny * 2);
    const total = [dam.file, dam.image, dam.water].reduce((s, f) => s + statSync(new URL(f, DATA)).size, 0);
    expect(total).toBeLessThan(1.1e6);
  });
});

describe('the provider with a patch', () => {
  it('fetches the patch only when asked, once, and answers from it once it is in', async () => {
    const { terrain, fetchBinary } = makeTerrain();
    expect(terrain.patchIds).toEqual(['dam']);
    expect(terrain.patchInfo('dam').image).toBe('ground-dam.jpg');
    await terrain.loadWide();
    expect(fetchBinary).not.toHaveBeenCalledWith('terrain-dam.bin');
    const p = [36000, -12000];
    const wide = terrain.grid('wide');
    expect(terrain.heightAt(...p)).toBe(wide.sample(...p));
    expect(terrain.grid('dam')).toBeNull();
    const [a, b] = await Promise.all([terrain.loadPatches(), terrain.loadPatches()]);
    expect(a).toBe(b);
    expect(fetchBinary.mock.calls.filter(([f]) => f === 'terrain-dam.bin')).toHaveLength(1);
    const patch = terrain.grid('dam');
    expect(a[0].grid).toBe(patch);
    expect(terrain.heightAt(...p)).toBe(patch.sample(...p));
    expect(terrain.groundY(...p)).toBe(patch.sample(...p) - BASE - curveDrop(...p));
    expect(terrain.stats().grids).toEqual(['near', 'far', 'wide', 'dam']);
    // outside the patch nothing changes
    for (const q of [[30500, -12000], [36000, -17500], [100, 200], [-20000, 10000]]) {
      const { terrain: t0 } = makeTerrain();
      await t0.loadWide();
      expect(terrain.heightAt(...q)).toBe(t0.heightAt(...q));
    }
  });

  it('picks the finest grid that covers a point, whatever order the patches load in', async () => {
    const { terrain } = makeTerrain();
    await terrain.loadPatches(); // before the wide grid: the patch still wins inside it
    const p = [37000, -11000];
    expect(terrain.heightAt(...p)).toBe(terrain.grid('dam').sample(...p));
    await terrain.loadWide();
    expect(terrain.heightAt(...p)).toBe(terrain.grid('dam').sample(...p));
  });

  it('is continuous across the patch edge to well within the skirt', async () => {
    const { terrain } = makeTerrain();
    await Promise.all([terrain.loadWide(), terrain.loadPatches()]);
    let worst = 0;
    for (let f = 0.005; f < 1; f += 0.0137) {
      const x = dam.x0 + f * (damX1 - dam.x0), y = dam.y0 + f * (damY1 - dam.y0);
      for (const [[ax, ay], [bx, by]] of [
        [[dam.x0 - 0.01, y], [dam.x0 + 0.01, y]], [[damX1 + 0.01, y], [damX1 - 0.01, y]],
        [[x, dam.y0 - 0.01], [x, dam.y0 + 0.01]], [[x, damY1 + 0.01], [x, damY1 - 0.01]],
      ]) worst = Math.max(worst, Math.abs(terrain.heightAt(ax, ay) - terrain.heightAt(bx, by)));
    }
    // decimetre rounding of the eased edge posts, nothing more
    expect(worst).toBeLessThan(0.1);
    expect(worst).toBeLessThan(PATCH_SKIRT);
  });

  it('a retry follows a failed patch fetch', async () => {
    const fetchBinary = vi.fn(async (f) => { if (f === 'terrain-dam.bin' && !fetchBinary.failed) { fetchBinary.failed = true; throw new Error('offline'); } return bytes(f); });
    const { terrain } = makeTerrain(fetchBinary);
    await expect(terrain.loadPatches()).rejects.toThrow('offline');
    expect((await terrain.loadPatches())[0].id).toBe('dam');
  });

  it('a city without patches loads none', async () => {
    const fetchBinary = vi.fn();
    const terrain = createTerrain({ meta: { ...meta, patches: undefined }, buffers, base: BASE, fetchBinary });
    expect(terrain.patchIds).toEqual([]);
    expect(await terrain.loadPatches()).toEqual([]);
    expect(fetchBinary).not.toHaveBeenCalled();
  });
});

describe('the meshes', () => {
  const wide = heightField(bytes(meta.grids.wide.file), meta.grids.wide);
  const far = heightField(buffers.far, meta.grids.far);
  const patch = heightField(bytes(dam.file), dam);

  it('cuts exactly the wide cells inside the patch out of the wide mesh', { timeout: 30000 }, () => {
    const plain = buildWideMesh({ wide, hole: far, base: BASE, map: null });
    const cut = buildWideMesh({ wide, hole: far, cuts: [patch], base: BASE, map: null });
    const cells = ((damX1 - dam.x0) / wide.step) * ((damY1 - dam.y0) / wide.step);
    expect((plain.geometry.index.count - cut.geometry.index.count) / 6).toBe(cells);
    // no triangle of the cut mesh has its centre inside the patch
    const p = cut.geometry.attributes.position.array, idx = cut.geometry.index.array, o = cut.position;
    let inside = 0;
    for (let k = 0; k < idx.length; k += 3) {
      const cx = (p[idx[k] * 3] + p[idx[k + 1] * 3] + p[idx[k + 2] * 3]) / 3 + o.x;
      const cy = -((p[idx[k] * 3 + 2] + p[idx[k + 1] * 3 + 2] + p[idx[k + 2] * 3 + 2]) / 3 + o.z);
      if (cx > dam.x0 && cx < damX1 && cy > dam.y0 && cy < damY1) inside++;
    }
    expect(inside).toBe(0);
    // and the cells the far grid's hole cuts are still cut
    expect(cut.geometry.index.count).toBeLessThan(plain.geometry.index.count);
  });

  it('cellsInside counts a cell only when all four posts are in', () => {
    const g = { nx: 11, ny: 11, x0: 0, y0: 0, step: 10 };
    const inside = cellsInside(g, [{ nx: 3, ny: 2, x0: 20, y0: 30, step: 10 }]); // 20..40 x 30..40
    const cells = [];
    for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) if (inside(i, j)) cells.push([i, j]);
    expect(cells).toEqual([[2, 3], [3, 3]]);
  });

  it('builds the patch whole, sharing its edge with the wide mesh', () => {
    const mesh = buildPatchMesh({ patch, id: 'dam', base: BASE, map: null });
    expect(mesh.name).toBe('terrain-patch-dam');
    expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mesh.geometry.index.count).toBe((dam.nx - 1) * (dam.ny - 1) * 6);
    const pos = mesh.geometry.attributes.position.array, o = mesh.position;
    // posts on the patch's edge that are also wide posts have the wide grid's height, to the decimetre
    for (let i = 0; i < dam.nx; i += wide.step / dam.step) {
      for (const j of [0, dam.ny - 1]) {
        const k = (j * dam.nx + i) * 3, x = pos[k] + o.x, y = -(pos[k + 2] + o.z);
        expect(Math.abs(pos[k + 1] + o.y - (wide.sample(x, y) - BASE - curveDrop(x, y)))).toBeLessThan(0.06);
      }
    }
    const skirt = buildSkirt(mesh, patch, PATCH_SKIRT);
    expect(skirt.material).toBe(mesh.material);
    expect(skirt.geometry.attributes.position.count).toBe(2 * (2 * (dam.nx - 1) + 2 * (dam.ny - 1)));
  });
});

describe('water', () => {
  const doc = JSON.parse(readFileSync(new URL(dam.water, DATA), 'utf8'));

  it('has the lake above the dam and the river below it, at their levels', () => {
    const names = doc.bodies.map((b) => b.name);
    expect(names).toContain('Lake Mead');
    expect(names).toContain('Lake Mohave');
    const level = (n) => doc.bodies.find((b) => b.name === n).level;
    expect(level('Lake Mead')).toBeGreaterThan(330);
    expect(level('Lake Mead')).toBeLessThan(380);
    expect(level('Lake Mohave')).toBeGreaterThan(185);
    expect(level('Lake Mohave')).toBeLessThan(210);
  });

  it('splits triangles until no edge is long, and covers the outline\'s area', () => {
    const square = [[[0, 0], [3000, 0], [3000, 3000], [0, 3000]]];
    const t = waterTriangles(square, 800);
    let area = 0;
    for (let k = 0; k < t.length; k += 6) {
      const [ax, ay, bx, by, cx, cy] = t.slice(k, k + 6);
      for (const [px, py, qx, qy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) expect(Math.hypot(qx - px, qy - py)).toBeLessThanOrEqual(800);
      area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }
    expect(area).toBeCloseTo(9e6, 0);
  });

  it('blends a body\'s levels where it has more than one', () => {
    expect(levelAt({ level: 5 }, 0, 0)).toBe(5);
    const b = { level: 0, levels: [[0, 0, 10], [100, 0, 20]] };
    expect(levelAt(b, 0, 0)).toBe(10);
    expect(levelAt(b, 50, 0)).toBeCloseTo(15, 9);
    expect(levelAt(b, 10, 0)).toBeLessThan(12);
  });

  it('builds one sheet per patch at its bodies\' levels, curvature baked', () => {
    const mesh = buildWaterMesh(doc, { base: BASE, name: 'water-dam' });
    expect(mesh.name).toBe('water-dam');
    const p = mesh.geometry.attributes.position.array, o = mesh.position;
    const lake = doc.bodies.find((b) => b.name === 'Lake Mead');
    expect(lake.levels).toBeUndefined(); // one level: flat
    let onLake = 0;
    for (let k = 0; k < p.length; k += 3 * 7) {
      const x = p[k] + o.x, y = -(p[k + 2] + o.z);
      const h = p[k + 1] + BASE + curveDrop(x, y);
      expect(doc.bodies.some((b) => Math.abs(levelAt(b, x, y) + LIFT - h) < 0.01)).toBe(true);
      if (Math.abs(h - lake.level - LIFT) < 0.01) onLake++;
    }
    expect(onLake).toBeGreaterThan(10);
    expect(buildWaterMesh({ bodies: [] }, { base: BASE })).toBeNull();
  });
});

describe('buildPatches', () => {
  const renderer = { capabilities: { getMaxAnisotropy: () => 4 } };
  const json = async (f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'));

  it('loads the dam patch and builds its ground, skirt and water for the session', async () => {
    const { terrain } = makeTerrain();
    const image = vi.fn(async () => null); // no image decoding under Node: the mesh is built without its map
    const built = await buildPatches({ terrain, base: BASE, renderer, image, json });
    expect(image).toHaveBeenCalledWith('ground-dam.jpg');
    expect(built.grids).toEqual([terrain.grid('dam')]);
    expect(built.ground.map(([m, id]) => [m.name, id])).toEqual([['terrain-patch-dam', 'dam']]);
    expect(built.objects.map((o) => o.name)).toEqual(['terrain-patch-dam', 'terrain-patch-dam-skirt', 'water-dam']);
    built.setImagery(false);
    expect(built.ground[0][0].material.map).toBeNull();
  });

  it('gives nothing to draw for a city without patches', async () => {
    const terrain = createTerrain({ meta: { ...meta, patches: undefined }, buffers, base: BASE, fetchBinary: vi.fn() });
    const built = await buildPatches({ terrain, base: BASE, renderer, image: vi.fn(), json });
    expect(built.objects).toEqual([]);
    expect(NO_PATCHES.grids).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { curveDrop } from '../../src/world/frame.js';
import { createTerrain, heightField } from '../../src/world/terrain/index.js';
import { buildWideMesh } from '../../src/world/terrain/widemesh.js';

const DATA = new URL('../../public/data/lv/', import.meta.url);
const bytes = (file) => { const b = readFileSync(new URL(file, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
const BASE = 620;
const buffers = { near: bytes(meta.grids.near.file), far: bytes(meta.grids.far.file) };
const fixture = JSON.parse(readFileSync(new URL('../fixtures/heights-lv.json', import.meta.url), 'utf8'));

// ---- inline copy of the formulas in main.js, the reference the provider must match bit for bit
const lerp = THREE.MathUtils.lerp;
function mainHeightField(buf, g) {
  const raw = new Uint16Array(buf);
  const at = (i, j) => raw[j * g.nx + i] * g.scale;
  return {
    ...g, raw, at,
    sample(x, y) {
      const fx = THREE.MathUtils.clamp((x - g.x0) / g.step, 0, g.nx - 1.001);
      const fy = THREE.MathUtils.clamp((y - g.y0) / g.step, 0, g.ny - 1.001);
      const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j;
      return lerp(lerp(at(i, j), at(i + 1, j), ax), lerp(at(i, j + 1), at(i + 1, j + 1), ax), ay);
    },
    contains(x, y, inset = 0) {
      return x > g.x0 + inset && x < g.x0 + (g.nx - 1) * g.step - inset
        && y > g.y0 + inset && y < g.y0 + (g.ny - 1) * g.step - inset;
    },
  };
}
const mainNear = mainHeightField(buffers.near, meta.grids.near);
const mainFar = mainHeightField(buffers.far, meta.grids.far);
const mainGroundY = (x, y) => (mainNear.contains(x, y) ? mainNear.sample(x, y) : mainFar.sample(x, y)) - BASE - curveDrop(x, y);

const makeTerrain = (fetchBinary = vi.fn(async (file) => bytes(file))) =>
  ({ terrain: createTerrain({ meta, buffers, base: BASE, fetchBinary }), fetchBinary });

// deterministic points over far, near and beyond
function points(n, x0, x1, y0, y1, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => [x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0)]);
}

describe('heightField', () => {
  it('matches main.js bit for bit on the real grids', () => {
    for (const name of ['near', 'far']) {
      const a = heightField(buffers[name], meta.grids[name]);
      const b = name === 'near' ? mainNear : mainFar;
      const g = meta.grids[name];
      const span = [g.x0 - 500, g.x0 + (g.nx - 1) * g.step + 500, g.y0 - 500, g.y0 + (g.ny - 1) * g.step + 500];
      for (const [x, y] of points(5000, ...span, name.length)) {
        expect(Object.is(a.sample(x, y), b.sample(x, y))).toBe(true);
        expect(a.contains(x, y)).toBe(b.contains(x, y));
        expect(a.contains(x, y, 40)).toBe(b.contains(x, y, 40));
      }
      expect(a.at(3, 5)).toBe(b.at(3, 5));
    }
  });
});

describe('createTerrain', () => {
  it('gives main.js groundY bit for bit inside near and far', () => {
    const { terrain } = makeTerrain();
    for (const [x, y] of [...points(5000, -48000, 30000, -34000, 38000, 7), ...points(3000, -3600, 4600, -4400, 8200, 9)]) {
      expect(Object.is(terrain.groundY(x, y), mainGroundY(x, y))).toBe(true);
    }
  });

  it('falls through near, far, then wide', async () => {
    const { terrain } = makeTerrain();
    const near = terrain.grid('near'), far = terrain.grid('far');
    expect(terrain.grid('wide')).toBeNull();
    const pNear = [100, 200], pFar = [-20000, 10000], pWide = [-19534, -55912]; // the last is Primm
    expect(terrain.heightAt(...pNear)).toBe(near.sample(...pNear));
    expect(terrain.heightAt(...pFar)).toBe(far.sample(...pFar));
    // before the wide grid arrives, the far grid's clamped edge stands in
    expect(terrain.heightAt(...pWide)).toBe(far.sample(...pWide));
    const wide = await terrain.loadWide();
    expect(terrain.grid('wide')).toBe(wide);
    expect(terrain.heightAt(...pNear)).toBe(near.sample(...pNear));
    expect(terrain.heightAt(...pFar)).toBe(far.sample(...pFar));
    expect(terrain.heightAt(...pWide)).toBe(wide.sample(...pWide));
    expect(terrain.heightAt(...pWide)).toBeGreaterThan(700); // Primm is about 790 m up
    expect(terrain.groundY(...pWide)).toBe(wide.sample(...pWide) - BASE - curveDrop(...pWide));
    expect(terrain.inBuildArea(...pNear)).toBe(true);
    expect(terrain.inBuildArea(...pFar)).toBe(false);
    expect(terrain.inBuildArea(meta.grids.near.x0 + 20, 0, 40)).toBe(false);
  });

  it('fetches the wide grid once and settles', async () => {
    const { terrain, fetchBinary } = makeTerrain();
    expect(terrain.hasWide).toBe(true);
    expect(terrain.stats()).toEqual({ grids: ['near', 'far'], bytes: buffers.near.byteLength + buffers.far.byteLength });
    const a = terrain.loadWide(), b = terrain.loadWide();
    let settled = false;
    const s = terrain.whenSettled().then(() => { settled = true; });
    await Promise.all([a, b, s]);
    expect(settled).toBe(true);
    expect(await a).toBe(await b);
    await terrain.loadWide();
    expect(fetchBinary).toHaveBeenCalledTimes(1);
    expect(fetchBinary).toHaveBeenCalledWith('terrain-wide.bin');
    expect(terrain.stats().grids).toEqual(['near', 'far', 'wide']);
    await terrain.whenSettled();
    // the pyramid's hooks are accepted and ignored
    terrain.setViews([]); terrain.update({}); terrain.prefetchAlong(null, {});
  });

  it('retries a failed wide fetch', async () => {
    const fetchBinary = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async (f) => bytes(f));
    const { terrain } = makeTerrain(fetchBinary);
    await expect(terrain.loadWide()).rejects.toThrow('offline');
    await terrain.whenSettled();
    expect(await terrain.loadWide()).not.toBeNull();
    expect(fetchBinary).toHaveBeenCalledTimes(2);
  });

  it('resolves null for a city without a wide grid', async () => {
    const fetchBinary = vi.fn();
    const terrain = createTerrain({ meta: { ...meta, grids: { near: meta.grids.near, far: meta.grids.far } }, buffers, base: BASE, fetchBinary });
    expect(terrain.hasWide).toBe(false);
    expect(await terrain.loadWide()).toBeNull();
    expect(fetchBinary).not.toHaveBeenCalled();
  });

  it('matches the Python sampler to the millimetre', async () => {
    const { terrain } = makeTerrain();
    await terrain.loadWide();
    expect(fixture.points.length).toBeGreaterThanOrEqual(50);
    for (const grid of ['near', 'far', 'wide']) expect(fixture.points.some((p) => p.grid === grid)).toBe(true);
    for (const p of fixture.points) {
      expect(Math.abs(terrain.heightAt(p.x, p.y) - p.height), p.label).toBeLessThan(0.001);
      expect(Math.abs(terrain.groundY(p.x, p.y) - p.groundY), p.label).toBeLessThan(0.001);
    }
  });
});

// ---- inline copy of terrainMesh() in main.js, with BASE as a parameter
function mainTerrainMesh(hf, hole, base) {
  const { nx, ny, step, x0, y0, scale, raw } = hf;
  const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  const inside = (v, lo, hi, inset) => v > lo + inset && v < hi - inset;
  const hx = hole && [hole.x0, hole.x0 + (hole.nx - 1) * hole.step], hy = hole && [hole.y0, hole.y0 + (hole.ny - 1) * hole.step];
  const inX = new Uint8Array(nx), inY = new Uint8Array(ny), cutX = new Uint8Array(nx), cutY = new Uint8Array(ny);
  if (hole) {
    for (let i = 0; i < nx; i++) { const x = x0 + i * step; inX[i] = inside(x, ...hx, 0); cutX[i] = inside(x, ...hx, step) && inside(x + step, ...hx, step); }
    for (let j = 0; j < ny; j++) { const y = y0 + j * step; inY[j] = inside(y, ...hy, 0); cutY[j] = inside(y, ...hy, step) && inside(y + step, ...hy, step); }
  }
  const half = 1 / (2 * step);
  for (let j = 0; j < ny; j++) {
    const row = j * nx, up = Math.min(j + 1, ny - 1) * nx, dn = Math.max(j - 1, 0) * nx, y = y0 + j * step, v = j / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const k = (row + i) * 3, x = x0 + i * step;
      const sink = inX[i] && inY[j] ? 8 : 0;
      pos[k] = x; pos[k + 1] = raw[row + i] * scale - base - curveDrop(x, y) - sink; pos[k + 2] = -y;
      const dx = (raw[row + Math.min(i + 1, nx - 1)] * scale - raw[row + Math.max(i - 1, 0)] * scale) * half;
      const dy = (raw[up + i] * scale - raw[dn + i] * scale) * half;
      const l = Math.hypot(dx, 1, dy);
      nor[k] = -dx / l; nor[k + 1] = 1 / l; nor[k + 2] = dy / l;
      uv[(row + i) * 2] = i / (nx - 1); uv[(row + i) * 2 + 1] = v;
    }
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (cutX[i] && cutY[j]) continue;
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  return { pos, nor, uv, idx };
}

describe('buildWideMesh', () => {
  // a 31 x 25 grid of 100 m posts on a gentle slope with bumps, and a hole over its middle
  const nx = 31, ny = 25, step = 100;
  const raw = new Uint16Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) raw[j * nx + i] = 7000 + i * 13 + j * 7 + ((i * j) % 5) * 9;
  const wide = heightField(raw.buffer, { nx, ny, x0: -40000, y0: -60000, step, scale: 0.1 });
  const hole = heightField(new Uint16Array(11 * 9).buffer, { nx: 11, ny: 9, x0: -39000, y0: -59200, step: 100, scale: 0.1 });
  const mesh = buildWideMesh({ wide, hole, base: BASE, map: null });
  const geo = mesh.geometry;
  const pos = geo.attributes.position.array, nor = geo.attributes.normal.array;

  it('is a plain unshadowed Lambert mesh', () => {
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mesh.material.map).toBeNull();
    expect(mesh.receiveShadow).toBe(false);
  });

  it('has no NaN and normals that point up', () => {
    for (const v of pos) expect(Number.isFinite(v)).toBe(true);
    for (let k = 0; k < nor.length; k += 3) {
      expect(nor[k + 1]).toBeGreaterThan(0.9);
      expect(Math.hypot(nor[k], nor[k + 1], nor[k + 2])).toBeCloseTo(1, 6);
    }
  });

  it('cuts out the cells well inside the hole and sinks the posts under it 8 m', () => {
    const tris = geo.index.count / 3;
    expect(tris).toBeLessThan((nx - 1) * (ny - 1) * 2);
    // a post in the middle of the hole is sunk; one outside is not
    const at = (i, j) => (j * nx + i) * 3;
    const top = (i, j) => raw[j * nx + i] * 0.1 - BASE - curveDrop(-40000 + i * step, -60000 + j * step);
    expect(pos[at(15, 12) + 1]).toBeCloseTo(top(15, 12) - 8, 3);
    expect(pos[at(2, 2) + 1]).toBeCloseTo(top(2, 2), 3);
    // and no triangle touches a post in the hole's interior
    const idx = geo.index.array;
    const interior = new Set([at(15, 12) / 3, at(14, 11) / 3]);
    for (let k = 0; k < idx.length; k++) expect(interior.has(idx[k])).toBe(false);
  });

  it('builds the real wide grid around the far grid', () => {
    const real = heightField(bytes(meta.grids.wide.file), meta.grids.wide);
    const far = heightField(buffers.far, meta.grids.far);
    const m = buildWideMesh({ wide: real, hole: far, base: BASE, map: null });
    const p = m.geometry.attributes.position.array;
    for (let k = 0; k < p.length; k += 997) expect(Number.isFinite(p[k])).toBe(true);
    // the far grid's footprint is mostly cut away
    const cells = (real.nx - 1) * (real.ny - 1);
    const farCells = ((far.nx - 1) * far.step * (far.ny - 1) * far.step) / (real.step * real.step);
    expect(m.geometry.index.count / 6).toBeLessThan(cells - farCells * 0.95);
    expect(Math.abs(m.position.x) + Math.abs(m.position.z)).toBeGreaterThan(0);
  });

  it('builds what terrainMesh() in main.js builds, offset to the grid centre', () => {
    const ref = mainTerrainMesh(wide, hole, BASE);
    const o = mesh.position;
    for (let k = 0; k < pos.length; k += 3) {
      expect(pos[k] + o.x).toBeCloseTo(ref.pos[k], 2);
      expect(pos[k + 1] + o.y).toBe(ref.pos[k + 1]);
      expect(pos[k + 2] + o.z).toBeCloseTo(ref.pos[k + 2], 2);
    }
    expect([...nor]).toEqual([...ref.nor]);
    expect([...geo.attributes.uv.array]).toEqual([...ref.uv]);
    expect([...geo.index.array]).toEqual(ref.idx);
  });
});

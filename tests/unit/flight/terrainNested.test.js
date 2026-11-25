// One height function over the nested grids (plan 03, sections 7.1, 7.9 and 7.14; F4.7): the map's near and far where
// they reach, then valley, approaches and region, bilinear, continuous across every border to within the grids' own
// agreement, the curve applied in scene units, and which grids a camera needs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeGrid } from '../../../src/flight/terrain/decode.js';
import { createNested, gridField, NESTED_ORDER } from '../../../src/flight/terrain/nested.js';
import { createTerrain } from '../../../src/world/terrain/index.js';
import { createFrame, curveDrop } from '../../../src/world/frame.js';
import cities from '../../../data/cities.json';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
const file = (name) => readFileSync(new URL(name, DATA));
const raw = (name) => { const b = file(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const BASE = cities.lv.base;
const frame = createFrame(cities.lv);

const provider = () => createTerrain({
  meta, buffers: { near: raw(meta.grids.near.file), far: raw(meta.grids.far.file) }, base: BASE,
  fetchBinary: async (f) => raw(f),
});
const decoded = {};
for (const name of NESTED_ORDER) decoded[name] = await decodeGrid(file(meta.grids[name].file), meta.grids[name]);
const nestedAll = () => {
  const n = createNested({ terrain: provider(), base: BASE });
  for (const name of NESTED_ORDER) n.add(name, decoded[name]);
  return n;
};

/** Pairs of points just inside and just outside a grid's edge (d metres each side), every `every` metres along it. */
function edgePairs(g, d, every) {
  const x1 = g.x0 + (g.nx - 1) * g.step, y1 = g.y0 + (g.ny - 1) * g.step, pairs = [];
  for (let x = g.x0 + every / 2; x < x1; x += every) pairs.push([[x, g.y0 + d], [x, g.y0 - d]], [[x, y1 - d], [x, y1 + d]]);
  for (let y = g.y0 + every / 2; y < y1; y += every) pairs.push([[g.x0 + d, y], [g.x0 - d, y]], [[x1 - d, y], [x1 + d, y]]);
  return pairs;
}
const percentile = (a, p) => { const s = [...a].sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

describe('a decoded grid as a surface', () => {
  it('samples bilinearly in metres, with the offset, and clamps outside', () => {
    const q = new Uint16Array([0, 10, 20, 30]); // 2 x 2 posts, 100 m apart
    const g = gridField({ nx: 2, ny: 2, x0: 0, y0: 0, step: 100, scale: 0.5, offset: -10, q });
    expect(g.sample(0, 0)).toBeCloseTo(-10, 9);
    expect(g.sample(100, 100)).toBeCloseTo(5, 1); // heightfield.js clamps to nx - 1.001: 4.985 at the far corner
    expect(g.sample(50, 50)).toBeCloseTo((-10 - 5 + 0 + 5) / 4, 6);
    expect(g.sample(-500, 50)).toBeCloseTo(g.sample(0, 50), 9);
    expect(g.contains(50, 50)).toBe(true);
    expect(g.contains(100, 50)).toBe(false);
  });

  it('samples the drawn triangles split along the (i+1, j)-(i, j+1) diagonal', () => {
    const q = new Uint16Array([0, 0, 0, 100]); // only the north-east post is raised
    const g = gridField({ nx: 2, ny: 2, x0: 0, y0: 0, step: 10, scale: 1, offset: 0, q });
    expect(g.triangles(2, 2)).toBeCloseTo(0, 9); // the south-west triangle is flat
    expect(g.triangles(10, 10)).toBeCloseTo(100, 9);
    expect(g.triangles(7.5, 7.5)).toBeCloseTo(50, 9);
    expect(g.sample(7.5, 7.5)).toBeCloseTo(56.25, 9); // bilinear differs
  });
});

describe('the nested height function on the committed grids', () => {
  const n = nestedAll();

  it('answers from the finest grid that covers the point', () => {
    expect(n.sourceAt(1373, -1885)).toBe('near'); // the 19R threshold
    expect(n.sourceAt(20000, 30000)).toBe('far');
    expect(n.sourceAt(40000, -10000)).toBe('valley'); // Lake Mead
    expect(n.sourceAt(150000, 150000)).toBe('approaches');
    expect(n.sourceAt(400000, -400000)).toBe('region');
    expect(n.sourceAt(900000, 0)).toBe('region'); // beyond everything: region's clamped edge
  });

  it('puts the 19R threshold at its surveyed 636.6 m through the near grid', () => {
    const { threshold } = JSON.parse(readFileSync(new URL('airport.json', DATA), 'utf8')).ends['19R'];
    expect(n.heightAt(threshold[0], threshold[1])).toBeCloseTo(636.57, 0);
  });

  it('stands Charleston Peak within 30 m of its surveyed 3,632 m, in every grid that holds it', () => {
    const p = frame.toLocal(36.2716, -115.6956);
    const top = (h) => { let m = -Infinity; for (let dx = -600; dx <= 600; dx += 20) for (let dy = -600; dy <= 600; dy += 20) m = Math.max(m, h(p.x + dx, p.y + dy)); return m; };
    expect(Math.abs(top(n.heightAt) - 3632)).toBeLessThan(30);
    for (const name of ['valley', 'approaches']) expect(Math.abs(top((x, y) => n.grid(name).sample(x, y)) - 3632)).toBeLessThan(30);
  });

  it('keeps Lake Mead flat at a lake level of the survey years', () => {
    // Boulder Basin, Virgin Basin and the Overton Arm: valley's 128 m posts, beyond far
    const lake = [[36.06, -114.76], [36.13, -114.42], [36.35, -114.40]].map(([la, lo]) => frame.toLocal(la, lo));
    for (const p of lake) expect(n.sourceAt(p.x, p.y)).toBe('valley');
    const hs = lake.map((p) => n.heightAt(p.x, p.y));
    // the surface the elevation source holds is the lake of about 2000, when SRTM flew (1,203 ft, 366.7 m); it fell to
    // 324 m by 2016. The three basins agree within half a metre
    for (const h of hs) expect(h).toBeCloseTo(366.7, 0);
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(0.5);
  });

  it('is continuous across the borders of region, approaches and valley within the encoding steps', () => {
    // either side of each child's edge: the child is stitched to its parent along it (scripts/lib/grids.py)
    for (const [child, parent, limit] of [['approaches', 'region', 1.0], ['valley', 'approaches', 0.5]]) {
      const steps = edgePairs(n.grid(child), 0.01, 997).map(([[xi, yi], [xo, yo]]) => {
        expect(n.sourceAt(xo, yo)).toBe(parent);
        return Math.abs(n.heightAt(xi, yi) - n.heightAt(xo, yo));
      });
      expect(Math.max(...steps), child).toBeLessThan(limit);
    }
  });

  it('steps at far\'s edge no more than valley and far disagree there (median 0.18 m, at most 26 m)', () => {
    const steps = edgePairs(n.grid('far'), 0.01, 211).map(([[xi, yi], [xo, yo]]) => {
      expect(n.sourceAt(xi, yi)).toBe('far');
      expect(n.sourceAt(xo, yo)).toBe('valley');
      return Math.abs(n.heightAt(xi, yi) - n.heightAt(xo, yo));
    });
    expect(percentile(steps, 0.5)).toBeLessThan(0.5);
    expect(percentile(steps, 0.95)).toBeLessThan(7);
    expect(Math.max(...steps)).toBeLessThan(30);
  });

  it('applies the curve of the app\'s datum: 370 km out the ground falls 9.2 km (10.7 km on the true radius)', () => {
    const y = 370000, h = n.heightAt(0, y);
    expect(n.groundY(0, y)).toBeCloseTo(h - BASE - curveDrop(0, y), 6);
    expect(curveDrop(0, y)).toBeCloseTo(9209, -1);
    // the plan's 10,721 m at 370 km north is the true radius's drop; the app's 7/6 radius scales it by 6/7
    expect(curveDrop(0, y) / ((10721 * 6) / 7)).toBeCloseTo(1, 2);
    expect(frame.sceneY(h, 0, y)).toBeCloseTo(n.groundY(0, y), 6);
  });

  it('gives the drawn surface (triangles) in scene units, the map\'s own surface inside far', () => {
    const t = provider();
    expect(n.surfaceY(1373, -1885)).toBeCloseTo(t.surfaceY(1373, -1885), 9);
    const p = frame.toLocal(36.06, -114.76);
    expect(n.surfaceY(p.x, p.y)).toBeCloseTo(n.grid('valley').triangles(p.x, p.y) - BASE - curveDrop(p.x, p.y), 6);
  });
});

describe('which grids a camera needs (section 7.14)', () => {
  const n = createNested({ terrain: provider(), base: BASE });
  for (const name of NESTED_ORDER) n.add(name, decoded[name]);
  const at = (km, altFt, far) => n.needed({ x: km[0] * 1000, y: km[1] * 1000, altitude: altFt * 0.3048, far });

  it('needs every grid at cruise 250 km north-east of the city', () => {
    expect(at([177, 177], 30000, 448000)).toEqual(['region', 'approaches', 'valley']);
  });

  it('needs approaches and valley, not region, on final to 19R at 300 ft', () => {
    expect(at([2.5, 1.0], 2400, 117000)).toEqual(['approaches', 'valley']);
  });

  it('needs region once the visible disc leaves approaches, whatever the height', () => {
    expect(at([200, 0], 10000, 300000)).toEqual(['region', 'approaches', 'valley']);
    expect(at([0, 0], 10000, 200000)).toEqual(['approaches', 'valley']);
  });

  it('needs no valley far out at low height when valley is beyond the far plane', () => {
    expect(at([240, 240], 5000, 120000)).toEqual(['region', 'approaches']);
  });
});

describe('loading', () => {
  it('settles once every load it was given has finished, failed ones included', async () => {
    const n = createNested({ terrain: provider(), base: BASE });
    let done = false;
    const slow = new Promise((r) => setTimeout(() => r(decoded.valley), 20));
    n.track('valley', slow.then((g) => n.add('valley', g)));
    n.track('region', Promise.reject(new Error('offline')));
    const settled = n.whenSettled().then(() => { done = true; });
    expect(done).toBe(false);
    await settled;
    expect(n.has('valley')).toBe(true);
    expect(n.has('region')).toBe(false);
  });

  it('answers from the next coarser loaded grid until the finer one arrives', () => {
    const n = createNested({ terrain: provider(), base: BASE });
    n.add('approaches', decoded.approaches);
    const p = frame.toLocal(36.06, -114.76);
    expect(n.sourceAt(p.x, p.y)).toBe('approaches');
    n.add('valley', decoded.valley);
    expect(n.sourceAt(p.x, p.y)).toBe('valley');
  });
});

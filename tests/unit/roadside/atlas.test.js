import { describe, it, expect } from 'vitest';
import { packAtlas, drawAtlas, PAGE, GUTTER } from '../../../src/drive/roadside/atlas.js';
import { facesOf } from '../../../src/drive/roadside/faces.js';
import { fakeContext, signsJson } from './helpers.js';

function realFaces() {
  const road = signsJson().roads[0];
  const m = new Map();
  for (const rec of road.signs) for (const f of facesOf(rec, road.exits)) m.set(f.key, f.face);
  return m;
}

const overlap = (a, b) => a.page === b.page
  && a.x - GUTTER < b.x + b.w + GUTTER && b.x - GUTTER < a.x + a.w + GUTTER
  && a.y - GUTTER < b.y + b.h + GUTTER && b.y - GUTTER < a.y + a.h + GUTTER;

describe('sign atlas', () => {
  it('packs every distinct face of signs.json onto one page, without overlaps, inside the page', () => {
    const faces = realFaces();
    const atlas = packAtlas([...faces].map(([key, face]) => ({ key, face })));
    expect(atlas.pages).toHaveLength(1);
    expect(atlas.rects.size).toBe(faces.size);
    const rs = [...atlas.rects.values()];
    for (const r of rs) {
      const pg = atlas.pages[r.page];
      expect(r.x - GUTTER).toBeGreaterThanOrEqual(0);
      expect(r.y - GUTTER).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w + GUTTER).toBeLessThanOrEqual(pg.w);
      expect(r.y + r.h + GUTTER).toBeLessThanOrEqual(pg.h);
    }
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) expect(overlap(rs[i], rs[j])).toBe(false);
  });

  it('gives each face its physical size at the chosen density, small signs twice as dense', () => {
    const faces = realFaces();
    const atlas = packAtlas([...faces].map(([key, face]) => ({ key, face })));
    expect(atlas.ppm).toBeGreaterThanOrEqual(40);
    expect(atlas.ppm).toBeLessThanOrEqual(72);
    for (const [key, r] of atlas.rects) {
      const f = faces.get(key);
      const ppm = ['speed', 'mile', 'route', 'tab', 'gore'].includes(f.kind) ? 2 * atlas.ppm : atlas.ppm;
      expect(r.ppm).toBe(ppm);
      expect(r.w).toBe(Math.ceil(f.w * ppm));
      expect(r.h).toBe(Math.ceil(f.h * ppm));
    }
  });

  it('opens more pages when one is not enough, and refuses a face larger than a page', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, face: { kind: 'advance', w: 9, h: 4 } }));
    const atlas = packAtlas(many, { ppm: 72 });
    expect(atlas.pages.length).toBeGreaterThan(1);
    expect(new Set([...atlas.rects.values()].map((r) => r.page)).size).toBe(atlas.pages.length);
    expect(() => packAtlas([{ key: 'x', face: { kind: 'advance', w: 40, h: 4 } }], { ppm: 72 })).toThrow(/does not fit/);
  });

  it('draws each face into its own rectangle, with a gutter of its edge colour', () => {
    const faces = realFaces();
    const atlas = packAtlas([...faces].map(([key, face]) => ({ key, face })));
    const ctxs = [];
    drawAtlas(atlas, faces, () => ({ getContext: () => { const c = fakeContext(); ctxs.push(c); return c; } }));
    const ctx = ctxs[0];
    for (const t of ctx.texts) {
      const inside = [...atlas.rects.values()].some((r) => t.left >= r.x - 1e-6 && t.right <= r.x + r.w + 1e-6 && t.y >= r.y && t.y <= r.y + r.h);
      expect(inside).toBe(true);
    }
    expect(PAGE).toBe(2048);
    expect(drawAtlas(atlas, faces, () => null)).toEqual([null]);
  });
});

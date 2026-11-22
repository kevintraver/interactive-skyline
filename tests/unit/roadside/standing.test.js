// Everything the roadside stands beside the road reaches what is under it (geometry.js standY): every sign post's and
// overhead column's foot is below both the embankment the mesher draws there and the ground the drive draws there,
// and every delineator stands on one of them, on all three routes, with the real terrain (terrain.surfaceAt).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRefline } from '../../../src/drive/roadnet/refline.js';
import { edgesAt } from '../../../src/drive/roadnet/crosssection.js';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';
import { buildSign, standY } from '../../../src/drive/roadside/geometry.js';
import { buildStructure } from '../../../src/drive/roadside/structures.js';
import { placeDelineators } from '../../../src/drive/roadside/delineators.js';
import { createTerrain } from '../../../src/world/terrain/index.js';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const bytes = (file) => { const b = readFileSync(new URL(file, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const json = (file) => JSON.parse(readFileSync(new URL(file, DATA), 'utf8'));
const meta = json('terrain.json');
const BASE = 620, EARTH_R = 6371000 * (7 / 6);
const height = ([x, y, z]) => y + BASE + (x * x + z * z) / (2 * EARTH_R);
const uv = () => ({ page: 0, u0: 0, v0: 0, u1: 1, v1: 1 });
const TOL = 0.02;
const onDeck = (raw, s) => (raw.bridges || []).some((b) => b.deck && s >= b.s0 && s <= b.s1);
/** What is under a foot at map (x, y): the drawn ground, or the embankment the mesher draws there where that is higher. */
function under(ctx, rec, s, side, lateral, x, y) {
  const p = ctx.at(s), e = ctx.edges(s), edgeH = p.h + p.crossfall * (side === 'left' ? e.left : e.right);
  return Math.max(ctx.ground(x, y), edgeH + standY({ raw: ctx.raw }, s, p, e, side, lateral, x, y, edgeH));
}

const terrain = createTerrain({ meta, buffers: { near: bytes(meta.grids.near.file), far: bytes(meta.grids.far.file) }, base: BASE, fetchBinary: async (f) => bytes(f) });
const ready = Promise.all([terrain.loadWide(), terrain.loadPatches()]);

describe.each(json('routes.json').routes.map((r) => [r.id, r]))('on %s', (id, route) => {
  const rn = route.files.roadnet;
  const net = decodeRoadNet(json(rn), bytes(rn.replace('.json', '.bin')));
  const signs = json(route.files.signs);
  const barriers = json(rn === 'roadnet.json' ? 'barriers.json' : `barriers-${id}.json`);

  it('sign posts and overhead columns reach below the embankment and the drawn ground', async () => {
    await ready;
    const ground = terrain.surfaceAt;
    let n = 0;
    for (const sr of signs.roads) {
      const raw = net.roads.find((r) => r.id === sr.id);
      if (!raw) continue;
      const ref = createRefline(raw);
      const ctx = { at: (s) => ref.at(s), edges: (s) => edgesAt(raw, s), base: BASE, earthR: EARTH_R, raw, ground };
      for (const rec of sr.signs) {
        if (onDeck(raw, rec.s)) continue; // on a deck a post stands on the deck's edge
        for (const p of buildSign(rec, null, ctx, uv).posts) {
          const [x, , z] = p.foot;
          expect(height(p.foot), `${sr.id} ${rec.kind} at ${rec.s}`).toBeLessThan(under(ctx, rec, rec.s, rec.side, p.lateral, x, -z) + TOL);
          n++;
        }
      }
      for (const st of sr.structures || []) {
        if (onDeck(raw, st.s)) continue;
        const e = edgesAt(raw, st.s);
        for (const c of buildStructure(st, sr.signs, ctx).columns) {
          const [x, , z] = c.foot;
          const sup = c.out > 0 ? under(ctx, null, st.s, c.d > e.left ? 'left' : 'right', c.out, x, -z) : ground(x, -z);
          expect(height(c.foot), `${sr.id} column at ${st.s}`).toBeLessThan(sup + TOL);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it('delineators stand on the embankment or the drawn ground, never in the air', async () => {
    await ready;
    const all = placeDelineators(barriers, net, BASE, EARTH_R, terrain.surfaceAt);
    expect(all.length).toBeGreaterThan(500);
    for (const d of all) expect(height(d.pos), `${d.x},${d.y}`).toBeGreaterThanOrEqual(terrain.surfaceAt(d.x, d.y) - TOL);
  });
});

describe('standY', () => {
  const raw = { spacing: 4, embankment: [{ s0: 0, s1: 100, side: 'right', w: 2 }], bridges: [] };
  const p = { curvature: 0 }, e = { left: 5, right: -5 };
  it('is the full embankment without a road record or ground (the old rule)', () => {
    expect(standY({}, 10, p, e, 'right', 24, 0, 0, 100)).toBeCloseTo(-6, 9);
  });
  it('follows the squeezed embankment, and the ground beyond its reach', () => {
    // squeezed to 2 m of its 44: 1 m out is where 22 m out would be, 5.5 m down
    expect(standY({ raw }, 10, p, e, 'right', 1, 0, 0, 100)).toBeCloseTo(-5.5, 9);
    expect(standY({ raw, ground: () => 80 }, 10, p, e, 'right', 3, 0, 0, 100)).toBe(-20);
    expect(standY({ raw, ground: () => 98 }, 10, p, e, 'left', 4, 0, 0, 100)).toBe(-1); // the ground over the embankment
  });
});

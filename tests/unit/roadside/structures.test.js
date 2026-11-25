// Overhead sign structures and the signs on them (signs.json `structures`, structures.js), the
// delineators (delineators.js) and the sheeting codes every face carries, on the real data.
import { describe, it, expect } from 'vitest';
import { createRefline } from '../../../src/drive/roadnet/refline.js';
import { edgesAt } from '../../../src/drive/roadnet/crosssection.js';
import { buildStructure, TRUSS } from '../../../src/drive/roadside/structures.js';
import { buildSign, signFrame } from '../../../src/drive/roadside/geometry.js';
import { facesOf, arrowX, LAYOUT } from '../../../src/drive/roadside/faces.js';
import { packSigns } from '../../../src/drive/roadside/batch.js';
import { placeDelineators } from '../../../src/drive/roadside/delineators.js';
import { SHEETING } from '../../../src/drive/roadside/sheeting.js';
import { readFileSync } from 'node:fs';
import { signsJson, realRoadnet, BASE, EARTH_R } from './helpers.js';

const FT = 0.3048;
const net = realRoadnet();
const doc = signsJson();
const sr = doc.roads[0];
const road = net.roads.find((r) => r.id === sr.id);
const ref = createRefline(road);
const ctx = { at: (s) => ref.at(s), edges: (s) => edgesAt(road, s), base: BASE, earthR: EARTH_R };
const height = ([x, y, z]) => y + BASE + (x * x + z * z) / (2 * EARTH_R);
const lateral = (p, s) => { const q = ref.at(s); return -(p[0] - q.x) * Math.sin(q.heading) + (-p[2] - q.y) * Math.cos(q.heading); };
const uv = () => ({ page: 0, u0: 0, v0: 0, u1: 1, v1: 1 });

describe('overhead structures', () => {
  it('there is one for every overhead sign, cantilevers and spans both', () => {
    const over = sr.signs.filter((r) => r.over);
    expect(over.length).toBeGreaterThanOrEqual(36);
    expect(sr.structures.length).toBe(over.length);
    expect(new Set(sr.structures.map((s) => s.kind))).toEqual(new Set(['cantilever', 'span']));
    for (const r of over) expect(sr.structures[r.structure].signs).toContain(sr.signs.indexOf(r));
  });

  it('columns stand outside the shoulders (or in the median), never on the carriageway', () => {
    for (const st of sr.structures) {
      const e = edgesAt(road, st.s);
      for (const d of st.cols) expect(d < e.right - 0.5 || d > e.left + 0.3).toBe(true);
      const b = buildStructure(st, sr.signs, ctx);
      for (const c of b.columns) {
        const lat = lateral(c.foot, st.s);
        expect(lat < e.right - 0.5 || lat > e.left + 0.3).toBe(true);
      }
    }
  });

  it('the truss clears 17 ft over the pavement, the panels hang in front of it, and it stays lean', () => {
    for (const st of sr.structures) {
      const b = buildStructure(st, sr.signs, ctx);
      const q = ref.at(st.s), e = edgesAt(road, st.s);
      const highest = q.h + Math.max(q.crossfall * e.left, q.crossfall * e.right);
      const pts = [];
      for (let i = 0; i < b.support.pos.length; i += 3) pts.push(b.support.pos.slice(i, i + 3));
      const overRoad = pts.filter((p) => { const d = lateral(p, st.s); return d < e.left && d > e.right; });
      expect(Math.min(...overRoad.map(height)) - highest).toBeGreaterThan(17 * FT);
      expect(b.triangles).toBeLessThan(2000);
      for (const i of st.signs) {
        const rec = sr.signs[i];
        const s = buildSign(rec, null, ctx, uv);
        expect(s.posts).toHaveLength(0); // hung, not on posts
        const f = signFrame(rec, ctx);
        // the panel's face is in front of every truss vertex, as the driver sees it
        const front = Math.min(...pts.map((p) => (p[0] - f.base[0]) * f.face[0] + (p[1] - f.base[1]) * f.face[1] + (p[2] - f.base[2]) * f.face[2]));
        expect(front).toBeLessThan(-TRUSS.gap);
        const faceZ = (s.faces[0].pos[0] - f.base[0]) * f.face[0] + (s.faces[0].pos[1] - f.base[1]) * f.face[1] + (s.faces[0].pos[2] - f.base[2]) * f.face[2];
        expect(faceZ).toBeCloseTo(0, 6);
      }
    }
  });

  it('a right exit hangs its sign over the right lanes, a left exit over the left lanes', () => {
    for (const r of sr.signs.filter((x) => x.over)) {
      const e = edgesAt(road, r.s);
      if (r.side === 'right') expect(r.d).toBeLessThan((e.left + e.right) / 2 + 2);
      else expect(r.d).toBeGreaterThan((e.left + e.right) / 2 - 2);
      expect(r.mount).toBeGreaterThanOrEqual(17 * FT);
    }
  });
});

describe('sign faces', () => {
  it('a gore sign centres its arrow; a guide sign keeps it at the exit side', () => {
    const cap = 40, W = 400;
    expect(arrowX({ kind: 'gore', arrow: 'right' }, W, cap) + (LAYOUT.arrow * cap) / 2).toBe(W / 2);
    expect(arrowX({ kind: 'exit', arrow: 'right' }, W, cap)).toBe(W - LAYOUT.side * cap - LAYOUT.arrow * cap);
    expect(arrowX({ kind: 'exit', arrow: 'left' }, W, cap)).toBe(LAYOUT.side * cap);
  });

  it('every face carries its sheeting: green with a white legend, white with a black (unlit) legend', () => {
    const items = sr.signs.slice(0, 60).map((rec, index) => {
      const fs = facesOf(rec, sr.exits);
      const tab = fs.find((f) => f.plate === 'tab')?.face || null;
      return { index, band: 2, built: buildSign(rec, tab, ctx, uv), rec };
    });
    const packed = packSigns(items, [0, 0, 0], 1).faces[0];
    expect(packed.retro.length).toBe(packed.position.length / 3);
    const pairs = new Set();
    for (let v = 0; v < packed.retro.length; v++) pairs.add(`${packed.retro[v]}/${packed.retroLegend[v]}`);
    expect(pairs).toContain(`${SHEETING.green}/${SHEETING.white}`);
    expect(pairs).toContain(`${SHEETING.white}/${SHEETING.none}`);
    for (const p of pairs) expect(p).not.toContain(`${SHEETING.none}/`); // every panel is sheeted
  });
});

describe('delineators', () => {
  const barriers = JSON.parse(readFileSync(new URL('../../../public/data/lv/barriers.json', import.meta.url), 'utf8'));
  const all = placeDelineators(barriers, net, BASE, EARTH_R);

  it('stand outside the shoulder edge, white on the right and yellow on the left', () => {
    expect(all.length).toBeGreaterThan(500);
    const mainDels = barriers.roads.find((r) => r.id === road.id).delineators;
    for (const [side, colour] of mainDels.map((d) => [d[0], d[1]])) expect(colour).toBe(side === 1 ? 0 : 1);
    for (const d of all.slice(0, 400)) {
      expect(d.up[1]).toBeGreaterThan(0.999); // true vertical
      expect(Math.abs(d.face[1])).toBeLessThan(0.01); // facing traffic, level
    }
  });

  it('are closer on curves and ramps than on tangents (MUTCD 3F)', () => {
    const main = barriers.roads.find((r) => r.id === road.id).delineators.find((d) => d[0] === 1)[3];
    const gaps = main.slice(1).map((s, i) => Math.round((s - main[i]) * 10) / 10);
    const count = new Map();
    for (const g of gaps) count.set(g, (count.get(g) || 0) + 1);
    const modal = [...count].sort((a, b) => b[1] - a[1])[0][0];
    expect(modal).toBeCloseTo(121.9, 0); // 400 ft on tangents
    expect(gaps.some((g) => g < 110)).toBe(true); // closer on curves
    const ramp = barriers.roads.find((r) => r.id.includes('.off') && r.delineators.length);
    const rg = ramp.delineators[0][3];
    expect(Math.min(...rg.slice(1).map((s, i) => s - rg[i]))).toBeLessThanOrEqual(30.5);
  });
});

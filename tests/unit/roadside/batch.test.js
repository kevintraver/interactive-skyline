import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { selectVisible, bandOf, packSigns, SHOW, KEEP, BANDS } from '../../../src/drive/roadside/batch.js';
import { createRoadside } from '../../../src/drive/roadside/index.js';
import { createRefline } from '../../../src/drive/roadnet/refline.js';
import { BASE, EARTH_R, realRoadnet, signsJson } from './helpers.js';

const fakeBuilt = (pages, n = 1) => ({
  faces: pages.map((page) => ({ page, normal: [0, 0, 1], pos: [1000, 1, 2, 1001, 1, 2, 1001, 2, 2, 1000, 2, 2], uv: [0, 1, 1, 1, 1, 0, 0, 0] })),
  support: { pos: Array(12 * n).fill(1000), nor: Array(12 * n).fill(0), col: Array(12 * n).fill(0.5), idx: Array.from({ length: n }, (_, k) => [0, 1, 2, 0, 2, 3].map((i) => i + 4 * k)).flat() },
});

describe('batching bookkeeping', () => {
  it('selects signs within SHOW, nearest first, and keeps shown ones until KEEP', () => {
    const signs = [0, 500, 1900, 2100, 3000].map((x) => ({ map: [x, 0] }));
    expect(selectVisible(signs, { x: 600, y: 0 }).map((v) => v.index)).toEqual([1, 0, 2, 3]);
    expect(selectVisible(signs, { x: 0, y: 0 }, new Set([3])).map((v) => v.index)).toEqual([0, 1, 2, 3]);
    expect(selectVisible(signs, { x: -200, y: 0 }, new Set([2, 3])).map((v) => v.index)).toEqual([0, 1, 2]); // 2 kept, 3 past KEEP
    expect(KEEP).toBeGreaterThan(SHOW);
  });

  it('bands distances for the night glow', () => {
    expect([0, BANDS[0] - 1, BANDS[0], BANDS[1] - 1, BANDS[1], 5000].map(bandOf)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('packs faces per page, nearest band last, each band one contiguous group', () => {
    const items = [
      { index: 4, band: 0, built: fakeBuilt([0, 1]) },
      { index: 7, band: 2, built: fakeBuilt([0]) },
      { index: 2, band: 1, built: fakeBuilt([0], 2) },
      { index: 9, band: 2, built: fakeBuilt([1]) },
    ];
    const out = packSigns(items, [1000, 0, 0], 2);
    expect(out.faces).toHaveLength(2);
    expect(out.faces[0].groups).toEqual([{ start: 0, count: 6, band: 2 }, { start: 6, count: 6, band: 1 }, { start: 12, count: 6, band: 0 }]);
    expect(out.faces[1].groups.map((g) => g.band)).toEqual([2, 0]);
    expect(out.faces[0].index.length).toBe(18);
    expect([...out.faces[0].position.slice(0, 3)]).toEqual([0, 1, 2]); // origin subtracted
    expect(out.faces[0].ranges.get(4)).toEqual({ start: 12, count: 6 });
    for (const f of out.faces) expect(Math.max(...f.index)).toBeLessThan(f.position.length / 3);
    // supports: every sign's range, indices offset to its own vertices
    const s = out.support;
    expect(s.index.length).toBe(6 * 5);
    expect([...s.ranges.values()].reduce((a, r) => a + r.count, 0)).toBe(s.index.length);
    expect(Math.max(...s.index)).toBe(s.position.length / 3 - 1);
  });
});

describe('createRoadside on the real data', () => {
  it('shows only signs within 2 km, in a handful of draw calls, and follows the car', async () => {
    const roadnet = realRoadnet();
    const signs = signsJson();
    const parent = new THREE.Group();
    const rs = createRoadside({ signs, roadnet, base: BASE, earthR: EARTH_R, parent });
    const ref = createRefline(roadnet.roads.find((r) => r.id === 'i15n.main'));
    const at = (s) => { const p = ref.at(s); return { x: p.x, y: p.y }; };
    rs.update(at(61000));
    await rs.whenSettled();
    const a = rs.stats();
    expect(a.signs).toBe(signs.roads[0].signs.length);
    expect(a.shown).toBeGreaterThan(5);
    expect(a.shown).toBeLessThan(40);
    expect(a.drawCalls).toBeLessThanOrEqual(2 * a.pages); // by day: one call per page and one for the supports
    rs.setNight(true);
    await rs.whenSettled();
    expect(rs.stats().drawCalls).toBeLessThanOrEqual(3 * a.pages + 1);
    // through dusk the glow scales with the look's beams, and the bands stay split while anything glows
    const faceMat = parent.getObjectByName('roadside').children[0].material[0];
    const full = faceMat.emissiveIntensity;
    rs.setLook({ night: true, beams: 0.25 });
    expect(faceMat.emissiveIntensity).toBeCloseTo(full * 0.25, 12);
    await rs.whenSettled();
    expect(rs.stats().drawCalls).toBeGreaterThan(a.drawCalls);
    rs.setNight(true);
    rs.update(at(20000));
    await rs.whenSettled();
    const b = rs.stats();
    expect(b.shown).toBeGreaterThan(0);
    const mesh = parent.getObjectByName('roadside').children[0];
    expect(Math.hypot(mesh.position.x - at(20000).x, mesh.position.z + at(20000).y)).toBeLessThan(2500); // rebased near the car
    rs.dispose();
    expect(parent.children).toHaveLength(0);
  });
});

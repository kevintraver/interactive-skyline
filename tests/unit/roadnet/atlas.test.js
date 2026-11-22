// D3.5, the baked road surface: line dimensions measured in the atlas and through the mesh's texture
// coordinates (MUTCD, plan section 7.3, to 1 cm), the tiles the mesher addresses, and the rules that
// pick concrete, the right-hand lane and bridge joints.
import { describe, it, expect } from 'vitest';
import { drawRoadAtlas, REGIONS, ATLAS_W, ATLAS_H, CYCLE, DASH, LINE_W, MARK_W, V_CYCLES, JOINT, PAINT,
  regionU, tileFor, surfaceAt, surfaceCuts, wearAt, KIND } from '../../../src/drive/roadnet/atlas.js';
import { meshChunk, reflineOf } from '../../../src/drive/roadnet/mesher.js';
import { interchange } from './interchange-fixture.js';
import { fixture, BASE, EARTH_R } from './helpers.js';

const CM = 0.01;
const CH = ATLAS_H / V_CYCLES; // canvas pixels per marking cycle
const M_PER_PX_V = CYCLE / CH; // metres along the road per canvas pixel

function recorder() {
  const fills = [];
  return { fills, fillStyle: '', fillRect(x, y, w, h) { fills.push({ color: this.fillStyle, x, y, w, h }); } };
}
const regionOf = (px) => Object.entries(REGIONS).find(([, [a, b]]) => px >= a && px < b)?.[0];
/** The painted line rectangles of a region: full fills in a paint colour, wider than a speck. */
const lines = (fills, name, color) => fills.filter((f) => f.color === color && f.w > 3 && f.x >= REGIONS[name][0] && f.x < REGIONS[name][1]);

describe('road atlas: layout', () => {
  it('lays the regions edge to edge across the whole atlas, the original eleven where they were', () => {
    const spans = Object.values(REGIONS).sort((a, b) => a[0] - b[0]);
    expect(spans[0][0]).toBe(0);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBe(spans[i - 1][1]);
    expect(spans[spans.length - 1][1]).toBe(ATLAS_W);
    expect(REGIONS.lane).toEqual([0, 96]);
    expect(REGIONS.reflector).toEqual([704, 768]);
    expect(regionU('lane', 0)).toBeGreaterThan(0); // plain regions are inset
    expect(regionU('broken', 0.5)).toBe((REGIONS.broken[0] + REGIONS.broken[1]) / 2 / ATLAS_W);
    expect(ATLAS_H % (4 * V_CYCLES)).toBe(0); // a dash is a quarter cycle: whole pixels
  });

  it('picks variants by rule and always names a region that exists', () => {
    const regions = ['lane', 'broken', 'solid', 'yellow', 'white', 'shoulder', 'dirt', 'concrete', 'gore', 'steel', 'reflector'];
    for (const r of regions) for (const concrete of [false, true]) for (const joint of [false, true]) for (const right of [false, true]) {
      expect(REGIONS[tileFor(r, { concrete, joint, right })]).toBeDefined();
    }
    expect(tileFor('lane')).toBe('lane');
    expect(tileFor('lane', { right: true })).toBe('laneR');
    expect(tileFor('lane', { right: true, concrete: true })).toBe('laneC');
    expect(tileFor('white', { concrete: true })).toBe('whiteC');
    expect(tileFor('shoulder', { joint: true, concrete: true })).toBe('joint');
    expect(tileFor('dirt', { joint: true, concrete: true })).toBe('dirt'); // only pavement changes
    expect(tileFor('concrete', { joint: true })).toBe('concrete');
  });

  it('surfaces bridges and concrete runs in concrete, with a joint at each bridge end', () => {
    const road = { bridges: [{ s0: 100, s1: 200 }, { s0: 300, s1: 300.8 }], surface: [{ s0: 0, kind: 'asphalt' }, { s0: 500, kind: 'concrete' }, { s0: 600, kind: 'asphalt' }] };
    expect(surfaceAt(road, 50)).toEqual({ concrete: false, joint: false });
    expect(surfaceAt(road, 100.1)).toEqual({ concrete: true, joint: true });
    expect(surfaceAt(road, 150)).toEqual({ concrete: true, joint: false });
    expect(surfaceAt(road, 199.9)).toEqual({ concrete: true, joint: true });
    expect(surfaceAt(road, 300.4)).toEqual({ concrete: true, joint: false }); // too short for joints
    expect(surfaceAt(road, 550)).toEqual({ concrete: true, joint: false });
    expect(surfaceAt(road, 650)).toEqual({ concrete: false, joint: false });
    expect(surfaceCuts(road)).toEqual([0, 500, 600, 100 + JOINT, 200 - JOINT]);
    expect(surfaceAt({}, 10)).toEqual({ concrete: false, joint: false });
  });

  it('wears the wheel paths, keeps the crown between them and runs oil down the middle', () => {
    expect(wearAt(0.162).path).toBeCloseTo(1, 6);
    expect(wearAt(0.5).path).toBeLessThan(0.01);
    expect(wearAt(0.5).oil).toBeCloseTo(1, 6);
    expect(wearAt(0.4).crown).toBeGreaterThan(0.3);
    expect(wearAt(0.02).crown).toBe(0);
  });
});

describe('road atlas: lines to MUTCD dimensions (section 7.3), within 1 cm', () => {
  for (const night of [false, true]) {
    const ctx = recorder();
    drawRoadAtlas(ctx, { night });
    const paint = night ? PAINT.night : PAINT.day;

    it(`broken lines are ${DASH} m on and ${CYCLE - DASH} m off, 0.15 m wide, in every cycle (${night ? 'night' : 'day'})`, () => {
      for (const sfx of ['', 'C']) {
        const dashes = lines(ctx.fills, 'broken' + sfx, paint.white).sort((a, b) => a.y - b.y);
        expect(dashes).toHaveLength(V_CYCLES);
        const pxPerM = (REGIONS['broken' + sfx][1] - REGIONS['broken' + sfx][0]) / MARK_W;
        dashes.forEach((d, c) => {
          expect(Math.abs(d.h * M_PER_PX_V - 3.048)).toBeLessThan(CM);
          expect(Math.abs(d.y - c * CH)).toBeLessThan(1e-9); // a dash starts each cycle, at chainage 0 mod 12.192 m
          expect(Math.abs(d.w / pxPerM - 0.1524)).toBeLessThan(CM);
          const centre = d.x + d.w / 2 - REGIONS['broken' + sfx][0];
          expect(Math.abs(centre / pxPerM - MARK_W / 2)).toBeLessThan(1e-9); // on the boundary
        });
        for (let c = 0; c < V_CYCLES; c++) {
          const gap = (c + 1) * CH - (dashes[c].y + dashes[c].h);
          expect(Math.abs(gap * M_PER_PX_V - 9.144)).toBeLessThan(CM);
        }
      }
    });

    it(`solid lane lines and edge lines are continuous and 0.15 m wide; yellow on the left (${night ? 'night' : 'day'})`, () => {
      for (const [name, color] of [['solid', paint.white], ['white', paint.white], ['yellow', paint.yellow],
        ['solidC', paint.white], ['whiteC', paint.white], ['yellowC', paint.yellow]]) {
        const [ln] = lines(ctx.fills, name, color);
        const pxPerM = (REGIONS[name][1] - REGIONS[name][0]) / MARK_W;
        expect(ln.h).toBe(ATLAS_H);
        expect(Math.abs(ln.w / pxPerM - LINE_W)).toBeLessThan(CM);
      }
    });
  }

  it('wears the paint: off-white and a sun-bleached yellow, with asphalt showing through', () => {
    expect(PAINT.day.white).not.toBe('#ffffff');
    const ctx = recorder();
    drawRoadAtlas(ctx);
    const [ln] = lines(ctx.fills, 'solid', PAINT.day.white);
    const through = ctx.fills.filter((f) => f.w === 1 && f.h === 1 && f.color !== PAINT.day.white && f.x >= ln.x && f.x < ln.x + ln.w);
    expect(through.length).toBeGreaterThan(50);
  });

  it('mills rumble strips beyond the edge lines, 40 grooves to a cycle (12 in centres), not in the lanes', () => {
    const ctx = recorder();
    drawRoadAtlas(ctx);
    const pxPerM = (REGIONS.white[1] - REGIONS.white[0]) / MARK_W;
    const mid = (REGIONS.white[0] + REGIONS.white[1]) / 2;
    const grooves = ctx.fills.filter((f) => f.color.startsWith('rgba(20,18,16,0.26') && regionOf(f.x) === 'white');
    expect(grooves).toHaveLength(40 * V_CYCLES);
    for (const g of grooves) expect(g.x).toBeGreaterThanOrEqual(mid + LINE_W * pxPerM); // outside the line
    const pitch = (grooves[1].y - grooves[0].y) * M_PER_PX_V;
    expect(Math.abs(pitch - 0.3048)).toBeLessThan(CM);
    expect(ctx.fills.some((f) => f.color.startsWith('rgba(20,18,16,0.26') && ['lane', 'laneR', 'broken'].includes(regionOf(f.x)))).toBe(false);
  });

  it('keeps every patch inside its own cycle, so cycles may follow each other in any order', () => {
    const ctx = recorder();
    drawRoadAtlas(ctx);
    for (const f of ctx.fills) {
      if (f.h >= ATLAS_H || f.h > CH) continue; // full-height columns and lines are the same in every cycle
      if (!f.color.startsWith('rgba') || f.h < 10) continue; // small marks: seams in noise do not show
      expect(Math.floor(f.y / CH)).toBe(Math.floor((f.y + f.h - 1e-6) / CH));
    }
  });
});

describe('road mesh: texture coordinates against the atlas', () => {
  const [main] = fixture().roads;
  const m = meshChunk({ road: main, s0: 256, s1: 512, lod: 0, base: BASE, earthR: EARTH_R });
  const lateral = (i, s) => {
    const p = reflineOf(main).at(s);
    const x = m.origin[0] + m.positions[3 * i], z = m.origin[2] + m.positions[3 * i + 2];
    return (x - p.x) * -Math.sin(p.heading) + (-z - p.y) * Math.cos(p.heading);
  };

  it('addresses only regions that exist, inside their insets', () => {
    for (let i = 0; i < m.uvs.length / 2; i++) {
      const px = m.uvs[2 * i] * ATLAS_W;
      const name = regionOf(Math.min(px, ATLAS_W - 1e-6));
      expect(name).toBeDefined();
    }
  });

  it('maps a marking strip so the drawn line is 0.15 m across and the dash 3.048 m along, within 1 cm', () => {
    const ctx = recorder();
    drawRoadAtlas(ctx);
    const [dash] = lines(ctx.fills, 'broken', PAINT.day.white);
    // vertex pairs of marking pieces in the broken region: u across against metres across
    const n = m.uvs.length / 2;
    let checked = 0;
    for (let i = 0; i + 1 < n; i += 2) {
      if (m.kind[i] !== KIND.marking || regionOf(m.uvs[2 * i] * ATLAS_W) !== 'broken') continue;
      const s = 256 + (m.uvs[2 * i + 1] - m.uvs[1]) * CYCLE; // v is chainage in cycles, from the chunk's base
      const du = Math.abs(m.uvs[2 * i + 2] - m.uvs[2 * i]) * ATLAS_W;
      const dm = Math.abs(lateral(i + 1, s) - lateral(i, s));
      if (dm < 0.99) continue; // the full 1 m strip
      expect(Math.abs((dash.w * dm) / du - 0.1524)).toBeLessThan(CM);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    // along: v advances one cycle per 12.192 m; the material samples 1 / V_CYCLES of the canvas per unit v
    const rowsV = [];
    for (let i = 0; i < n; i++) if (m.kind[i] === KIND.marking) rowsV.push(m.uvs[2 * i + 1]);
    const v0 = Math.min(...rowsV), v1 = Math.max(...rowsV);
    expect(Math.abs((v1 - v0) * CYCLE - 256)).toBeLessThan(1e-3);
    const dashMetres = (dash.h / ATLAS_H) * V_CYCLES * CYCLE; // canvas fraction / (1 / V_CYCLES per cycle) * metres per cycle
    expect(Math.abs(dashMetres - 3.048)).toBeLessThan(CM);
    // a dash starts at chainage 0 mod 12.192 m: v there is a whole number
    expect(m.uvs[1]).toBeCloseTo(256 / CYCLE - Math.floor(256 / CYCLE), 6);
  });

  it('draws the right-hand lane from the worn tile and the others from the plain one', () => {
    const tiles = new Set();
    for (let i = 0; i < m.uvs.length / 2; i++) if (m.kind[i] === KIND.lane) tiles.add(regionOf(m.uvs[2 * i] * ATLAS_W));
    expect(tiles).toEqual(new Set(['lane', 'laneR']));
  });

  it('surfaces a deck in concrete, with an expansion joint at each end, and the road off it in asphalt', () => {
    const { net } = interchange();
    const cross = net.roads[2];
    const mc = meshChunk({ road: cross, s0: 0, s1: 300, lod: 0, base: BASE, earthR: EARTH_R, roads: net.roads });
    const strip = mc.uvs.length / 2; // the road's own strips come first; extras after
    const pave = new Set([KIND.lane, KIND.marking, KIND.shoulder]);
    const at = { on: new Set(), off: new Set() };
    const sOf = (i) => (mc.uvs[2 * i + 1] - mc.uvs[1]) * CYCLE;
    for (let i = 0; i < strip; i++) {
      if (!pave.has(mc.kind[i])) continue;
      const s = sOf(i), name = regionOf(mc.uvs[2 * i] * ATLAS_W);
      if (s > 125 && s < 175) at.on.add(name);
      if (s < 115 || s > 185) at.off.add(name);
    }
    for (const n of at.on) expect(['laneC', 'shoulderC', 'brokenC', 'solidC', 'yellowC', 'whiteC']).toContain(n);
    expect(at.on.has('laneC')).toBe(true);
    expect([...at.off].some((n) => n.endsWith('C') || n === 'joint')).toBe(false);
    let joints = 0;
    for (let i = 0; i < strip; i++) if (regionOf(mc.uvs[2 * i] * ATLAS_W) === 'joint') joints++;
    expect(joints).toBeGreaterThan(0);
  });
});

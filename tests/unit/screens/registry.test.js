// D7.3 / D7.4: the screens registry against the content programs, and the billboards' face geometry against the
// pipeline's (scripts/lib/billboards.py panels(), tested on the same fixture in tests/data/test_billboards.py).
import { describe, it, expect } from 'vitest';
import { createScreenRegistry } from '../../../src/drive/screens/registry.js';
import { ledMean, ledLevel, ledColor, ledSamples } from '../../../src/drive/screens/led.js';
import { contentSeconds } from '../../../src/drive/screens/clock.js';
import { buildAtlas, CELL_W, CELL_H, ATLAS_COLS } from '../../../src/drive/screens/art.js';
import { digitalMean, digitalFrame, phaseOf } from '../../../src/drive/screens/digital.js';
import { panelsOf, boardOf, faceSeed } from '../../../src/drive/roadside/billboards.js';

const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

describe('the screens registry', () => {
  it('gives an LED screen\'s mean colour as the program sampled over its surface, times its level', () => {
    // a small LED patch: a fan of triangles on a 30 m square
    const pos = [], led = [];
    for (let i = 0; i < 30; i += 3) for (let j = 0; j < 30; j += 3) {
      pos.push(i, j, 0, i + 3, j, 0, i, j + 3, 0, i + 3, j, 0, i + 3, j + 3, 0, i, j + 3, 0);
      led.push(1, 1, 1, 1, 1, 1);
    }
    const { samples } = ledSamples(pos, led, 1000);
    const nightValue = 0.7;
    const reg = createScreenRegistry();
    reg.add({ id: 'patch', kind: 'led', centre: () => [15, 15, 0], visible: () => true,
      meanColor: (simMs, out) => { ledMean(samples, contentSeconds(simMs), out); for (let c = 0; c < 3; c++) out[c] *= ledLevel(nightValue); return out; } });
    const simMs = Date.parse('2026-11-22T03:00:42Z');
    // the program, evaluated densely over the patch (a sampled "render" at 0.5 m)
    let r = 0, g = 0, n = 0;
    for (let x = 0.25; x < 30; x += 0.5) for (let y = 0.25; y < 30; y += 0.5) {
      const c = ledColor(x, y, 0, contentSeconds(simMs)); r += c[0]; g += c[1]; n++;
    }
    const m = reg.meanColor('patch', simMs);
    expect(m[0]).toBeCloseTo((r / n) * ledLevel(nightValue), 2);
    expect(m[1]).toBeCloseTo((g / n) * ledLevel(nightValue), 2);
    expect(reg.meanColor('patch', simMs)).toEqual(m); // deterministic
  });

  it('a hidden screen has no mean colour; an unknown one neither', () => {
    let shown = true;
    const reg = createScreenRegistry();
    reg.add({ id: 'a', kind: 'led', centre: () => [0, 0, 0], visible: () => shown, meanColor: (t, o) => { o[0] = 1; return o; } });
    expect(reg.meanColor('a', 0)[0]).toBe(1);
    shown = false;
    expect(reg.meanColor('a', 0)).toBeNull();
    expect(reg.meanColor('b', 0)).toBeNull();
    expect(() => reg.add({ id: 'c' })).toThrow();
  });

  it('a digital face\'s mean colour is the atlas mean of what the shader shows', () => {
    const atlas = buildAtlas(), seed = faceSeed(0x9abcdef1, 1), phase = phaseOf(seed);
    for (const t of [10.1, 13.95, 14.2, 100]) {
      const { cur, prev, fade } = digitalFrame(seed, phase, t);
      // average the atlas cells' pixels directly, mixed as the shader mixes them (linear)
      const cell = (d) => {
        const ox = (d % ATLAS_COLS) * CELL_W, oy = Math.floor(d / ATLAS_COLS) * CELL_H;
        let s = 0;
        for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) s += lin(atlas.data[((oy + y) * atlas.width + ox + x) * 4 + 1]);
        return s / (CELL_W * CELL_H);
      };
      const want = cell(prev) + (cell(cur) - cell(prev)) * fade;
      expect(digitalMean(atlas.means, seed, phase, t)[1]).toBeCloseTo(want, 5);
    }
  });
});

describe('billboard faces', () => {
  const fields = ['x', 'y', 'facing', 'facing2', 'w', 'h', 'bottom', 'digital', 'sides', 'seed', 'sources'];
  it('a single face is centred on its pole and lies across its normal', () => {
    const b = boardOf([40, -500, 255, null, 14.63, 4.27, 7.62, 0, 1, 7, 1], fields);
    const [p] = panelsOf(b);
    expect([p.x, p.y]).toEqual([40, -500]);
    expect(p.normal[0] * p.along[0] + p.normal[1] * p.along[1]).toBeCloseTo(0, 12);
  });
  it('two faces stand in a V with the apex toward the road, the pole at their middle (as panels() in Python)', () => {
    // the fixture of tests/data/test_billboards.py: east of a north-south road, faces at -110 and 110 degrees
    const b = boardOf([50, 0, -110, 110, 14.63, 4.27, 7.62, 1, 2, 7, 4], fields);
    const [a, c] = panelsOf(b);
    expect((a.x + c.x) / 2).toBeCloseTo(50, 9);
    expect((a.y + c.y) / 2).toBeCloseTo(0, 9);
    expect(a.y).toBeLessThan(0);
    expect(c.y).toBeGreaterThan(0);
    const xs = [a, c].flatMap((p) => [p.x - p.along[0] * 7.315, p.x + p.along[0] * 7.315]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(14.63 * Math.cos((20 * Math.PI) / 180), 6);
    expect(Math.min(...xs)).toBeLessThan(50);
  });
  it('face seeds are 24-bit and differ between the faces of a board', () => {
    for (let s = 0; s < 100; s++) {
      expect(faceSeed(s * 7919, 0)).toBeLessThan(1 << 24);
      expect(faceSeed(s * 7919, 0)).not.toBe(faceSeed(s * 7919, 1));
    }
  });
});

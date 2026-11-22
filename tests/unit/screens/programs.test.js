// D7.4: the digital billboard program (screens/digital.js) and the artwork generator (screens/art.js): deterministic
// in time and seed, under the flash-rate limit of plan 02, section 4.11, and never anything that could be text.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { designOf, rasterise, buildAtlas, hash32, SHAPE_TYPES, MAX_SHAPES, MIN_SHAPE, CELL_W, CELL_H, DESIGNS, designSeed } from '../../../src/drive/screens/art.js';
import { digitalFrame, digitalMean, digitalLevel, staticLevel, daylight, frameDesign, phaseOf, HOLD_S, FADE_S, NIGHT_LUX, DAY_LUX, NIGHT_SCALE } from '../../../src/drive/screens/digital.js';
import { measureFlash, luminance, FLASH_LIMIT_HZ } from '../../../src/drive/screens/flash.js';

const ROOT = path.resolve(__dirname, '../../..');
const atlas = buildAtlas();

/** The smallest extent of a shape (panel heights), or Infinity for the full-panel gradient. */
function extent(s) {
  if (s.type === 'gradient') return Infinity;
  if (s.type === 'rect') return Math.min(s.x1 - s.x0, s.y1 - s.y0);
  if (s.type === 'disc') return 2 * s.r;
  if (s.type === 'stripes') return Math.min(s.width, s.x1 - s.x0);
  if (s.type === 'triangle') {
    const [a, b, c] = s.p, area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]), Math.hypot(a[0] - c[0], a[1] - c[1]));
    return (2 * area) / longest; // the triangle's smallest height
  }
  return 0;
}

describe('the artwork generator', () => {
  it('never emits anything that could be text: few, large shapes of a fixed set of types', { timeout: 60000 }, () => {
    for (let seed = 0; seed < 5000; seed++) {
      const d = designOf(hash32(seed));
      expect(d.shapes.length).toBeLessThanOrEqual(MAX_SHAPES);
      for (const s of d.shapes) {
        expect(SHAPE_TYPES).toContain(s.type);
        expect(Object.keys(s).some((k) => /text|glyph|font|char|letter|string/i.test(k))).toBe(false);
        expect(extent(s), `seed ${seed} ${s.type}`).toBeGreaterThanOrEqual(MIN_SHAPE - 1e-9);
      }
    }
    // and its source has no way to draw text
    const src = fs.readFileSync(path.join(ROOT, 'src/drive/screens/art.js'), 'utf8');
    expect(src).not.toMatch(/fillText|strokeText|font\s*=|String\.fromCharCode/);
  });

  it('is deterministic: the same seed, the same design and pixels', () => {
    expect(designOf(42)).toEqual(designOf(42));
    const a = new Uint8Array(CELL_W * CELL_H * 4), b = new Uint8Array(CELL_W * CELL_H * 4);
    const ma = rasterise(designOf(7), a), mb = rasterise(designOf(7), b);
    expect(a).toEqual(b);
    expect(ma).toEqual(mb);
    expect(designOf(43)).not.toEqual(designOf(42));
  });

  it('keeps each design\'s mean colour (linear) for the registry', () => {
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const i = 13, ox = (i % 8) * CELL_W, oy = Math.floor(i / 8) * CELL_H;
    let r = 0;
    for (let y = 0; y < CELL_H; y++) for (let x = 0; x < CELL_W; x++) r += lin(atlas.data[((oy + y) * atlas.width + ox + x) * 4]);
    expect(atlas.means[i * 3]).toBeCloseTo(r / (CELL_W * CELL_H), 6);
    expect(new Set(Array.from({ length: DESIGNS }, (_, k) => designSeed(k))).size).toBe(DESIGNS);
  });
});

describe('the digital billboard program', () => {
  it('holds each frame for HOLD_S and fades quickly', () => {
    const seed = 123456, phase = phaseOf(seed);
    const t0 = 3 * HOLD_S - phase; // the start of frame 3
    expect(digitalFrame(seed, phase, t0 + 1).k).toBe(3);
    expect(digitalFrame(seed, phase, t0 + HOLD_S - 0.01).k).toBe(3);
    expect(digitalFrame(seed, phase, t0 + HOLD_S + 0.01).k).toBe(4);
    expect(digitalFrame(seed, phase, t0 + FADE_S).fade).toBe(1);
    expect(digitalFrame(seed, phase, t0).fade).toBe(0);
    expect(digitalFrame(seed, phase, t0 + 2)).toEqual(digitalFrame(seed, phase, t0 + 2));
    expect(frameDesign(seed, 3)).toBe(digitalFrame(seed, phase, t0 + 1).cur);
    expect(frameDesign(seed, 2)).toBe(digitalFrame(seed, phase, t0 + 1).prev);
  });

  it('uses the same hash and timing as the face shader', () => {
    const glsl = fs.readFileSync(path.join(ROOT, 'src/drive/roadside/billboardsFace.js'), 'utf8');
    expect(glsl).toContain('x *= 0x7feb352du');
    expect(glsl).toContain('x *= 0x846ca68bu');
    expect(glsl).toContain('uint( k ) * 0x9e3779b9u');
    expect(glsl).toMatch(/HOLD_S|\$\{f1\(HOLD_S\)\}/);
    // the GPU's uint arithmetic (wrapping at 2^32), done with BigInt, gives the same values
    const M = (1n << 32n) - 1n;
    const ref = (v) => {
      let x = BigInt(v >>> 0);
      x ^= x >> 16n; x = (x * 0x7feb352dn) & M;
      x ^= x >> 15n; x = (x * 0x846ca68bn) & M;
      x ^= x >> 16n;
      return Number(x);
    };
    for (const v of [0, 1, 0xdeadbeef, 0xffffffff, 123456789]) expect(hash32(v)).toBe(ref(v));
    for (let k = -3; k < 3; k++) {
      const seed = 0xabcdef, mixed = Number((BigInt(seed) ^ ((BigInt.asUintN(32, BigInt(k)) * 0x9e3779b9n) & M)) & M);
      expect(frameDesign(seed, k)).toBe(ref(mixed) % DESIGNS);
    }
  });

  it('frame changes come at most once a hold, and differ from the last frame most of the time', () => {
    let same = 0;
    for (let k = 0; k < 2000; k++) if (frameDesign(99, k) === frameDesign(99, k - 1)) same++;
    expect(same / 2000).toBeLessThan(0.05);
  });

  for (const rate of [1, 4, 16]) {
    it(`stays under ${FLASH_LIMIT_HZ} Hz at ${rate}x for many faces`, () => {
      const peak = Math.max(...Array.from({ length: DESIGNS }, (_, i) => luminance(atlas.means[i * 3], atlas.means[i * 3 + 1], atlas.means[i * 3 + 2])));
      for (let seed = 1; seed < 40; seed++) {
        const s = hash32(seed) & 0xffffff;
        const m = measureFlash((t) => digitalMean(atlas.means, s, phaseOf(s), t).map((v) => v / peak), { rate, seconds: 20 });
        expect(m.flashesPerSecond).toBeLessThanOrEqual(FLASH_LIMIT_HZ);
      }
    }, 60000);
  }

  it('brightness follows the ambient illuminance: readable by day, brighter at night', () => {
    expect(daylight(NIGHT_LUX)).toBe(0);
    expect(daylight(DAY_LUX)).toBe(1);
    expect(daylight(30)).toBeGreaterThan(0);
    expect(daylight(30)).toBeLessThan(1);
    const night = digitalLevel(0.01), day = digitalLevel(50000);
    expect(night).toBeCloseTo(300 * NIGHT_SCALE * 0.1, 6); // 300 cd/m^2 x NIGHT_SCALE x units
    expect(day).toBeCloseTo(0.55, 6);
    let prev = Infinity;
    for (let lg = -2; lg <= 5; lg += 0.25) { const l = digitalLevel(10 ** lg); expect(l).toBeLessThanOrEqual(prev + 1e-12); prev = l; }
    expect(staticLevel(0)).toBe(0);
    expect(staticLevel(1)).toBeGreaterThan(0.5);
  });
});

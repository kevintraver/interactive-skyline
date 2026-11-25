// Plan 03, F5.1 and section 9.2: the pane's generated textures are in the repository at the size the shader expects,
// within the 2 MB the plan allows for them (scripts/build_pane_textures.py makes them from fixed seeds; its --check
// rebuilds them in memory and compares byte for byte).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { TEXTURE_SIZE, textureBytes } from '../../../src/flight/window/paneTextures.js';
import { LOOK } from '../../../src/flight/window/paneMaterial.js';

const DIR = new URL('../../../public/textures/pane/', import.meta.url);
const NAMES = ['pane-surface.png', 'pane-frost.png', 'pane-facets.png'];
/** Width and height from a PNG's IHDR chunk, and its colour type (6: RGBA). */
const ihdr = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], type: b[25] });

describe('pane textures', () => {
  it('are 512 x 704 RGBA, 8 bits a channel', () => {
    for (const n of NAMES) {
      const h = ihdr(fs.readFileSync(new URL(n, DIR)));
      expect([h.w, h.h]).toEqual(TEXTURE_SIZE);
      expect(h.depth).toBe(8);
      expect(h.type).toBe(6);
    }
  });
  it('take at most 2 MB in the repository and 16 MB on the GPU (section 9.2)', () => {
    const bytes = NAMES.reduce((s, n) => s + fs.statSync(new URL(n, DIR)).size, 0);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(NAMES.length * textureBytes(...TEXTURE_SIZE)).toBeLessThan(16 * 1024 * 1024);
  });
});

/** An 8-bit RGBA PNG decoded (zlib and the five row filters): { w, h, px }. */
function decodePng(buf) {
  const { w, h } = ihdr(buf);
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * 4), stride = w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y > 0 ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * stride + x] = (row[x] + pred) & 255;
    }
  }
  return { w, h, px };
}

// The frost growth maps (F5.1, reworked 24 Nov 2026): real frost on an airliner window is sparse, fine and fern-like,
// mostly a small patch round the breather hole and in the lower corners, and often absent. The first maps grew filled
// six-armed stars and dendrites over the lower third: snowflakes. ice = smoothstep(a - w, a, cover) at run time.
describe('frost growth maps', () => {
  const { w, h, px } = decodePng(fs.readFileSync(new URL('pane-frost.png', DIR)));
  const frozen = (ch, cover) => { const m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = px[i * 4 + ch] / 255 < cover ? 1 : 0; return m; };
  const share = (m) => m.reduce((s, v) => s + v, 0) / m.length;
  it('the default view at cruise is mostly clear glass: under 4 % frozen (frost 0.8, the frostiest window)', () => {
    // paneMaterial.js: cover = frost x LOOK.frostCover x up to 1.35 for the frostiest window
    const cover = 0.8 * LOOK.frostCover * 1.35;
    for (let ch = 0; ch < 4; ch++) expect(share(frozen(ch, cover))).toBeLessThan(0.04);
  });
  it('fully grown it is still sparse (under 15 %) and lives low on the pane', () => {
    for (let ch = 0; ch < 4; ch++) {
      const m = frozen(ch, 0.999);
      expect(share(m)).toBeLessThan(0.15);
      expect(share(m)).toBeGreaterThan(0.005);
      let low = 0, all = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { all++; if (y > (h * 2) / 3) low++; }
      expect(low / all).toBeGreaterThan(0.6);
    }
  });
  it('is fine lines, not filled crystals: few frozen texels have a 5 x 5 neighbourhood wholly frozen', () => {
    for (let ch = 0; ch < 4; ch++) {
      const m = frozen(ch, 0.999);
      let inner = 0, all = 0;
      for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
        if (!m[y * w + x]) continue;
        all++;
        let full = true;
        for (let dy = -2; dy <= 2 && full; dy++) for (let dx = -2; dx <= 2; dx++) if (!m[(y + dy) * w + x + dx]) { full = false; break; }
        if (full) inner++;
      }
      expect(inner / all).toBeLessThan(0.25);
    }
  });
});

// The scratch map (reworked 24 Nov 2026): a band of long straight fore-and-aft wipes flared over the winglet in low
// sun and read as a glitch. Scratches on a cabin window's inner pane are mostly fine arcs from cleaning, and sparse.
describe('scratch map', () => {
  const { w, h, px } = decodePng(fs.readFileSync(new URL('pane-surface.png', DIR)));
  it('is sparse: mean density under 0.015', () => {
    let sum = 0;
    for (let i = 0; i < w * h; i++) sum += px[i * 4 + 2] / 255;
    expect(sum / (w * h)).toBeLessThan(0.015);
  });
  it('has no band of straight horizontal scratches: no row averages over 0.03 of fore-and-aft density', () => {
    let worst = 0;
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) row += Math.max(0, (px[(y * w + x) * 4] / 255 - 0.5) * 2); // cos(2a) d: horizontal
      worst = Math.max(worst, row / w);
    }
    expect(worst).toBeLessThan(0.03);
  });
});

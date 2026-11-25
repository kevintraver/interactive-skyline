// Plan 03, F5.1 and section 9.2: the pane's generated textures are in the repository at the size the shader expects,
// within the 2 MB the plan allows for them (scripts/build_pane_textures.py makes them from fixed seeds; its --check
// rebuilds them in memory and compares byte for byte).
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { TEXTURE_SIZE, textureBytes } from '../../../src/flight/window/paneTextures.js';

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

import { describe, it, expect } from 'vitest';
import { drawRoadAtlas, REGIONS, V_CYCLES } from '../../../src/drive/roadnet/atlas.js';
import { createRoadMaterials } from '../../../src/drive/roadnet/material.js';

/** A 2D context stand-in that records fills. */
function recorder() {
  const fills = [];
  return { fills, fillStyle: '', fillRect(x, y, w, h) { fills.push({ color: this.fillStyle, x, y, w, h }); } };
}

describe('road atlas and materials', () => {
  // the layout and the line dimensions are in atlas.test.js
  it('draws the night paint (the headlights\' marking mask) with dark dirt', () => {
    const ctx = recorder();
    drawRoadAtlas(ctx, { night: true });
    const dirt = ctx.fills.filter((f) => f.x >= REGIONS.dirt[0] && f.x < REGIONS.dirt[1]);
    expect(dirt.every((f) => f.color === '#000000')).toBe(true);
  });

  it('builds two Lambert node materials without a canvas, offered to the light as road', () => {
    const m = createRoadMaterials({ anisotropy: 8 });
    expect(m.map).toBe(null); // no canvas under Node: skipped cleanly
    expect(m.nightMap).toBe(null);
    for (const r of [m.road, m.roadNear]) {
      expect(r.isNodeMaterial).toBe(true);
      expect(r.type).toBe('MeshLambertNodeMaterial');
      expect(r.polygonOffset).toBe(false);
      expect(r.userData.surfaceLight).toBe('road');
    }
    m.dispose();
  });

  it('samples the stacked cycles of the atlas with a repeat of 1 / V_CYCLES along v', async () => {
    // the atlas textures (textures.js)
    const src = (await import('node:fs')).readFileSync(new URL('../../../src/drive/roadnet/textures.js', import.meta.url), 'utf8');
    expect(src).toContain('t.repeat.set(1, 1 / V_CYCLES)');
    expect(V_CYCLES).toBeGreaterThan(1);
  });
});

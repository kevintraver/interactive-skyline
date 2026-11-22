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
  it('draws the night emissive map with dark dirt', () => {
    const ctx = recorder();
    drawRoadAtlas(ctx, { night: true });
    const dirt = ctx.fills.filter((f) => f.x >= REGIONS.dirt[0] && f.x < REGIONS.dirt[1]);
    expect(dirt.every((f) => f.color === '#000000')).toBe(true);
  });

  it('builds stock Lambert materials without a canvas, pulling pavement (not embankment) forward in depth, and switches night', () => {
    const m = createRoadMaterials({ anisotropy: 8 });
    expect(m.map).toBe(null); // no canvas under Node: skipped cleanly
    expect(m.road.type).toBe('MeshLambertMaterial');
    // a slope-scaled polygon offset pulled buried embankment through the ground far away; the bias
    // is now per vertex, by kind, in the vertex shader
    expect(m.road.polygonOffset).toBe(false);
    const shader = { vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}', fragmentShader: '' };
    m.road.onBeforeCompile(shader);
    expect(shader.vertexShader).toContain('attribute float kind;');
    expect(shader.vertexShader).toMatch(/if \( kind < 2\.5 \) \{ mvPosition\.xyz \*= 0\.9996/);
    expect(m.road.customProgramCacheKey()).toBe(m.roadNear.customProgramCacheKey());
    m.setNight(true);
    expect(m.roadNear.emissiveIntensity).toBeGreaterThan(m.road.emissiveIntensity);
    expect(m.road.emissiveIntensity).toBeGreaterThan(0);
    m.setNight(false);
    expect(m.road.emissiveIntensity + m.roadNear.emissiveIntensity).toBe(0);
    m.dispose();
  });

  it('samples the stacked cycles of the atlas with a repeat of 1 / V_CYCLES along v', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../../src/drive/roadnet/material.js', import.meta.url), 'utf8');
    expect(src).toContain('t.repeat.set(1, 1 / V_CYCLES)');
    expect(V_CYCLES).toBeGreaterThan(1);
  });
});

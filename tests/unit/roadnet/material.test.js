import { describe, it, expect } from 'vitest';
import { drawRoadAtlas, REGIONS, ATLAS_W, ATLAS_H, CYCLE, DASH, LINE_W, MARK_W, regionU } from '../../../src/drive/roadnet/atlas.js';
import { createRoadMaterials } from '../../../src/drive/roadnet/material.js';

/** A 2D context stand-in that records fills. */
function recorder() {
  const fills = [];
  return { fills, fillStyle: '', fillRect(x, y, w, h) { fills.push({ color: this.fillStyle, x, y, w, h }); } };
}

describe('road atlas and materials', () => {
  it('lays the regions edge to edge across the whole atlas', () => {
    const spans = Object.values(REGIONS).sort((a, b) => a[0] - b[0]);
    expect(spans[0][0]).toBe(0);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBe(spans[i - 1][1]);
    expect(spans[spans.length - 1][1]).toBe(ATLAS_W);
    expect(regionU('lane', 0)).toBeGreaterThan(0); // plain regions are inset
    expect(regionU('broken', 0.5)).toBe((REGIONS.broken[0] + REGIONS.broken[1]) / 2 / ATLAS_W);
  });

  it('draws a 10 ft dash in a 40 ft cycle, 6 in wide, with any 2D context', () => {
    const ctx = recorder();
    drawRoadAtlas(ctx);
    const white = ctx.fills.filter((f) => f.color === '#e9e8e2');
    const dash = white.find((f) => f.x > REGIONS.broken[0] && f.x < REGIONS.broken[1]);
    expect(dash.h / ATLAS_H).toBeCloseTo(DASH / CYCLE, 6);
    const pxPerM = (REGIONS.broken[1] - REGIONS.broken[0]) / MARK_W;
    expect(dash.w / pxPerM).toBeCloseTo(LINE_W, 6);
    const solid = white.filter((f) => f.h === ATLAS_H);
    expect(solid).toHaveLength(2); // solid lane line and white edge line
    expect(ctx.fills.some((f) => f.color === '#e3b42c' && f.h === ATLAS_H)).toBe(true);
  });

  it('draws the night emissive map with dark dirt', () => {
    const ctx = recorder();
    drawRoadAtlas(ctx, { night: true });
    const dirt = ctx.fills.filter((f) => f.x >= REGIONS.dirt[0]);
    expect(dirt.every((f) => f.color === '#000000')).toBe(true);
  });

  it('builds stock Lambert materials without a canvas, with polygon offset, and switches night', () => {
    const m = createRoadMaterials({ anisotropy: 8 });
    expect(m.map).toBe(null); // no canvas under Node: skipped cleanly
    expect(m.road.type).toBe('MeshLambertMaterial');
    expect(m.road.polygonOffset).toBe(true);
    expect(m.road.polygonOffsetFactor).toBeLessThan(0);
    m.setNight(true);
    expect(m.roadNear.emissiveIntensity).toBeGreaterThan(m.road.emissiveIntensity);
    expect(m.road.emissiveIntensity).toBeGreaterThan(0);
    m.setNight(false);
    expect(m.road.emissiveIntensity + m.roadNear.emissiveIntensity).toBe(0);
    m.dispose();
  });
});

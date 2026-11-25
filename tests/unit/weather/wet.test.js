// The wet road's rules in JavaScript (src/drive/weather/wetMirror.js); the term on materials is in wetRoad.test.js.
import { describe, it, expect } from 'vitest';
import { wetFragment, waterCover, meanCover, pathWear, facetSlope, WET_DIFFUSE, WET_RETRO } from '../../../src/drive/weather/wetMirror.js';

describe('wet road rules', () => {
  it('adds exactly nothing when dry', () => {
    const f = { wetness: 0, cosView: 0.05, sky: [0.3, 0.3, 0.3], diffuse: [0.1, 0.2, 0.3], slE: [1, 2, 3], slL: [0.5, 0.5, 0.5] };
    const r = wetFragment(f);
    expect(r).toEqual({ cover: 0, k: 1, diffuse: f.diffuse, slE: f.slE, slL: f.slL });
  });
  it('fills the wheel paths first', () => {
    expect(pathWear(0.162)).toBeCloseTo(1, 3);
    expect(pathWear(0.5)).toBeLessThan(0.01);
    expect(waterCover(0.5, 1)).toBe(1);
    expect(waterCover(0.5, 0)).toBe(0.5);
    expect(meanCover(1)).toBe(1);
    expect(meanCover(0)).toBe(0);
  });
  it('darkens, glosses at grazing angles, and drowns the markings when wet', () => {
    const base = { wetness: 1, sky: [0.4, 0.4, 0.4], diffuse: [1, 1, 1], slE: [1, 1, 1], slL: [1, 1, 1] };
    const graze = wetFragment({ ...base, cosView: 0.03 }), steep = wetFragment({ ...base, cosView: 0.9 });
    expect(graze.diffuse[0]).toBeCloseTo(WET_DIFFUSE, 9);
    // the visitor's beam at grazing incidence mostly glances off
    expect(graze.slE[0]).toBeLessThan(0.25 * WET_DIFFUSE);
    expect(steep.slE[0]).toBeGreaterThan(0.9 * WET_DIFFUSE);
    expect(graze.slL[0] - WET_RETRO).toBeGreaterThan(steep.slL[0] - WET_RETRO); // the sky's sheen
    // walls hold no water
    expect(wetFragment({ ...base, cosView: 0.1, normalY: 0.1 }).k).toBe(1);
  });
  it('makes long soft streaks on a damp road and sharper ones on a flooded one', () => {
    expect(facetSlope(0.3)).toBeGreaterThan(facetSlope(1));
  });
});

// The lights on plan 01's renderer (plan 02, third stretch, decisions 6 and 8): the display's fade, the quality
// level's detail, and when the lamps part has anything to draw.
import { describe, it, expect } from 'vitest';
import { displayFade, displayOfSearch } from '../../../src/drive/lights/display.js';
import { lampDetail, LIT_BELOW_LUX, SPRITE_BUDGET } from '../../../src/drive/lights/index.js';
import { switchThresholdLux } from '../../../src/drive/lights/switching.js';
import { POOL_TILE_PX } from '../../../src/drive/lights/poolTile.js';

describe('displayFade', () => {
  it('keeps the look\'s fade on the classic renderer and at the classic display, and is 1 in the shipped look', () => {
    expect(displayFade({ legacy: true, display: 'physical', fade: 0.3 })).toBe(0.3);
    expect(displayFade({ legacy: false, display: 'classic', fade: 0.3 })).toBe(0.3);
    expect(displayFade({ legacy: false, display: 'physical', fade: 0.3 })).toBe(1);
    expect(displayFade({ legacy: false, display: 'physical', fade: 0 })).toBe(1);
  });
  it('reads the display from the address', () => {
    expect(displayOfSearch('?display=classic&x=1')).toBe('classic');
    expect(displayOfSearch('?display=other')).toBe('physical');
    expect(displayOfSearch('')).toBe('physical');
  });
});

describe('lampDetail', () => {
  it('gives the sprite budget and pool texels of each quality level', () => {
    expect(lampDetail('low')).toEqual({ sprites: 20000, poolPx: 128 });
    expect(lampDetail('high')).toEqual({ sprites: SPRITE_BUDGET, poolPx: POOL_TILE_PX });
    expect(lampDetail('ultra')).toEqual({ sprites: 250000, poolPx: POOL_TILE_PX });
    expect(lampDetail(undefined)).toEqual(lampDetail('high')); // the classic renderer
  });
});

describe('LIT_BELOW_LUX', () => {
  it('is above every lamp\'s photocell threshold, and reached by one', () => {
    let max = 0;
    for (let i = 0; i < 200000; i++) max = Math.max(max, switchThresholdLux(i));
    expect(max).toBeLessThanOrEqual(LIT_BELOW_LUX);
    expect(max).toBeGreaterThan(LIT_BELOW_LUX * 0.5);
  });
});

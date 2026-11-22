// Other vehicles' headlamp pools (traffic/pools.js, pools.glsl.js) on a wet road: the same rule as the visitor's own
// pool (weather/wet.glsl.js, wetMirror.js wetFragment).
import { describe, it, expect } from 'vitest';
import { poolIlluminance, poolLuminance, ASPHALT_RHO } from '../../../src/drive/traffic/pools.js';
import { poolFragment } from '../../../src/drive/traffic/pools.glsl.js';
import { wetFragment, meanCover, fresnelWater, WET_DIFFUSE, GLOSS } from '../../../src/drive/weather/wetMirror.js';

describe('headlamp pools on a wet road', () => {
  it('dry: as before', () => {
    expect(poolIlluminance(0, 20)).toBe(poolIlluminance(0, 20, 0.5, 0.65, 0));
    expect(poolLuminance(0, 20)).toBeCloseTo((ASPHALT_RHO * poolIlluminance(0, 20)) / Math.PI, 12);
  });

  it('wet: weakened as the visitor\'s pool is, by 1 - cover F(incidence) and the wet diffuse ratio', () => {
    for (const w of [0.39, 0.86, 1]) {
      const cover = meanCover(w);
      for (const [x, y] of [[0, 8], [1, 20], [-2, 40]]) {
        const dry = poolLuminance(x, y);
        const wet = poolLuminance(x, y, { cover });
        expect(wet).toBeLessThan(dry);
        // one lamp at a time, through wetFragment with the lamp's incidence as the view (as for the visitor's own)
        const h = 0.65;
        let want = 0;
        for (const x0 of [-0.5, 0.5]) {
          const one = (c) => poolIlluminance(x - x0, y, 0, h, c) / 2; // a single lamp on the axis of the point
          const cosi = h / Math.hypot(x - x0, y, h);
          const out = wetFragment({ wetness: cover, cosView: cosi, kind: 'road', sky: [0, 0, 0], slE: [one(0), 0, 0] });
          want += (ASPHALT_RHO * out.slE[0]) / Math.PI;
          expect(1 - cover * fresnelWater(cosi)).toBeLessThan(1);
        }
        expect(wet / want).toBeCloseTo(1, 6);
      }
    }
    // a soaked road keeps under the wet diffuse ratio of the dry pool (most of the grazing light glances off)
    expect(poolLuminance(0, 30, { cover: 1 }) / poolLuminance(0, 30)).toBeLessThan(WET_DIFFUSE);
  });

  it('the shader reads the twins\' cover (uTwinWet / gloss) and applies both factors', () => {
    expect(poolFragment).toContain('uTwinWet / uWetPool.x');
    expect(poolFragment).toContain('1.0 - cover * poolFresnel(cosi)');
    expect(poolFragment).toContain('1.0 - cover * (1.0 - uWetPool.y)');
    expect(GLOSS.twin).toBeGreaterThan(0);
  });
});

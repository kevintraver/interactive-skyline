// A light sprite off the screen's centre must still carry the lamp's illuminance at the eye (plan 02, 8.4: sprite flux
// within 5 %). A pixel at angle t from the camera's axis subtends pa^2 cos^3(t) on a flat image plane, not pa^2; the
// node sprite layer (sprites.js) sizes and fills a sprite with pixelAngleOffAxis. Found by tests/manual/lights-probe.mjs
// (2026-11-24): a lamp 18 degrees off axis returned 0.859 of I / d^2, cos^3 of its angle to four digits.
import { describe, it, expect } from 'vitest';
import { spriteRule, profileAt } from '../../../src/drive/lights/spriteMirror.js';
import { pixelAngleOffAxis } from '../../../src/drive/lights/spriteData.js';

/** The illuminance a sprite drawn by the rule delivers: its radiance summed over the image plane's pixels, each pixel's true solid angle. */
function deliveredLux({ intensityCd, distanceM, pa, offDeg, ruleAngle }) {
  const s = spriteRule({ intensityCd, distanceM, pixelAngle: ruleAngle, halo: 0.006 });
  const c = Math.cos((offDeg * Math.PI) / 180);
  const R = Math.ceil(3 * Math.max(s.a, s.haloA)) + 2;
  let e = 0;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) e += s.radiance * profileAt(s, Math.hypot(x, y)) * pa * pa * c ** 3;
  return { e, expected: intensityCd / distanceM ** 2 };
}

describe('sprites off the screen centre', () => {
  const pa = 0.0008;
  for (const [d, off] of [[37, 18], [300, 25], [2000, 30], [40, 0]]) {
    it(`a lamp ${d} m away, ${off} degrees off axis, delivers I / d^2 within 1 %`, () => {
      const c = Math.cos((off * Math.PI) / 180);
      const { e, expected } = deliveredLux({ intensityCd: 5000, distanceM: d, pa, offDeg: off, ruleAngle: pixelAngleOffAxis(pa, c) });
      expect(e / expected).toBeGreaterThan(0.99);
      expect(e / expected).toBeLessThan(1.01);
    });
  }
  it('the on-axis pixel angle alone loses cos^3 of the light off axis (the defect the probe found)', () => {
    const { e, expected } = deliveredLux({ intensityCd: 5000, distanceM: 37, pa, offDeg: 18, ruleAngle: pa });
    expect(e / expected).toBeCloseTo(Math.cos((18 * Math.PI) / 180) ** 3, 2);
  });
  it('is the on-axis angle at the centre and shrinks as cos^1.5', () => {
    expect(pixelAngleOffAxis(0.001, 1)).toBe(0.001);
    expect(pixelAngleOffAxis(0.001, 0.5)).toBeCloseTo(0.001 * 0.5 ** 1.5, 12);
  });
});

// The limit on how bright a billboard's face is drawn (src/drive/roadside/faceDisplay.js).
import { describe, it, expect } from 'vitest';
import { FACE_DISPLAY, faceDisplay } from '../../../src/drive/roadside/faceDisplay.js';

describe('a billboard face\'s drawn white level', () => {
  it('is unchanged by day and up to the knee', () => {
    for (const x of [0, 0.05, 0.22, FACE_DISPLAY.knee]) expect(faceDisplay(x)).toBe(x);
    expect(faceDisplay(-1)).toBe(0);
  });
  it('eases to the maximum without a step or a kink, and never passes it', () => {
    const { knee, max } = FACE_DISPLAY;
    expect(faceDisplay(knee + 1e-6)).toBeCloseTo(knee, 5);
    // slope 1 at the knee
    expect((faceDisplay(knee + 1e-4) - faceDisplay(knee)) / 1e-4).toBeCloseTo(1, 3);
    let last = faceDisplay(knee);
    for (let x = knee; x < 40; x += 0.05) {
      const y = faceDisplay(x);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(max);
      last = y;
    }
    // a digital face at night (300 cd/m2 at an exposure near 0.03) is drawn at the maximum
    expect(faceDisplay(9)).toBeGreaterThan(max - 0.001);
  });
  it('stays inside what AgX shows: under 4 stops above mid-grey', () => {
    expect(Math.log2(FACE_DISPLAY.max / 0.18)).toBeLessThan(4.03);
    expect(Math.log2(FACE_DISPLAY.max / 0.18)).toBeGreaterThan(2);
  });
});

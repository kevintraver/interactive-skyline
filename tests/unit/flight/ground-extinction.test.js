// The air between the eye and the lit ground (src/flight/ground/extinction.js).
import { describe, it, expect } from 'vitest';
import { extinctionLength, KOSCHMIEDER, visibilityForLength } from '../../../src/flight/ground/extinction.js';

const G = 650; // the valley floor, m above sea level

describe('extinctionLength', () => {
  it('is Koschmieder along the ground', () => {
    expect(extinctionLength({ eyeAltM: G, groundAltM: G, visibilityM: 20000 })).toBeCloseTo(20000 / KOSCHMIEDER, 3);
  });

  it('grows with height: from the air the light climbs out of the haze', () => {
    const at = (h) => extinctionLength({ eyeAltM: h, groundAltM: G, visibilityM: 80000 });
    let prev = at(G);
    for (const h of [700, 1000, 2000, 4000, 6000, 9300]) {
      const L = at(h);
      expect(L).toBeGreaterThan(prev);
      prev = L;
    }
  });

  it('lets a clear night carry the valley to cruise: at 60 km from 30,000 ft, about half the light is left', () => {
    const L = extinctionLength({ eyeAltM: 9300, groundAltM: G, visibilityM: 80000 });
    const T = Math.exp(-60000 / L);
    expect(T).toBeGreaterThan(0.3);
    expect(T).toBeLessThan(0.7);
  });

  it('takes more in haze', () => {
    const clear = extinctionLength({ eyeAltM: 3000, groundAltM: G, visibilityM: 80000 });
    const hazy = extinctionLength({ eyeAltM: 3000, groundAltM: G, visibilityM: 10000 });
    expect(hazy).toBeLessThan(clear / 3);
  });

  it('survives nonsense', () => {
    expect(Number.isFinite(extinctionLength({ eyeAltM: 100, groundAltM: G, visibilityM: NaN }))).toBe(true);
    expect(extinctionLength({ eyeAltM: G, groundAltM: G, visibilityM: 0 })).toBeGreaterThan(0);
  });

  it('converts back to a visibility for code that takes one', () => {
    expect(visibilityForLength(1000)).toBeCloseTo(3912, 6);
  });
});

// Plan 03, F5.2 and section 7.7: three acrylic sheets (n = 1.49) pass roughly four fifths of the light and return the
// rest as faint reflections that rise steeply toward grazing; scratches throw light across themselves, so the ones
// tangent to circles round a bright source light up (the arcs round the sun).
import { describe, it, expect } from 'vitest';
import { fresnel, stackOptics, ACRYLIC_N, scratchGlint, glarePhase } from '../../../src/flight/window/paneOptics.js';

const cos = (deg) => Math.cos((deg * Math.PI) / 180);

describe('Fresnel for acrylic', () => {
  it('reflects about 3.9 % at normal incidence: ((n - 1) / (n + 1))^2 for n = 1.49', () => {
    expect(ACRYLIC_N).toBe(1.49);
    expect(fresnel(1)).toBeCloseTo(0.0387, 4);
  });
  it('rises monotonically toward grazing and passes 30 % by 80 degrees', () => {
    let prev = 0;
    for (let a = 0; a <= 88; a += 4) { const r = fresnel(cos(a)); expect(r).toBeGreaterThanOrEqual(prev - 1e-12); prev = r; }
    expect(fresnel(cos(80))).toBeGreaterThan(0.3);
    expect(fresnel(0)).toBeCloseTo(1, 6);
  });
});

describe('the three-pane stack', () => {
  it('passes roughly four fifths of the light head on', () => {
    const s = stackOptics(1);
    expect(s.T).toBeGreaterThan(0.77);
    expect(s.T).toBeLessThan(0.81);
  });
  it('the inner pane returns about 7.5 % head on, the two beyond it about 12 % more (four surfaces seen through it), all of it growing toward grazing', () => {
    const s = stackOptics(1);
    expect(s.Rinner).toBeCloseTo(0.0745, 3);
    expect(s.Router).toBeGreaterThan(0.10);
    expect(s.Router).toBeLessThan(0.13);
    const g = stackOptics(cos(70));
    expect(g.Rinner).toBeGreaterThan(s.Rinner * 2);
    expect(g.T).toBeLessThan(s.T);
  });
  it('conserves light: transmitted plus reflected never exceeds one', () => {
    for (let a = 0; a < 90; a += 5) { const s = stackOptics(cos(a)); expect(s.T + s.Rinner + s.Router).toBeLessThanOrEqual(1 + 1e-9); }
  });
});

describe('scratch glints', () => {
  it('a scratch at right angles to the line toward the source lights fully; one along it not at all', () => {
    // directions as doubled angles (cos 2a, sin 2a): a scratch along x, the source straight up the pane (radial +y)
    const along = [1, 0];
    expect(scratchGlint(along, [0, 1], 1)).toBeCloseTo(1, 9);
    expect(scratchGlint(along, [1, 0], 1)).toBeCloseTo(0, 9);
  });
  it('a patch of scratches in every direction (coherence 0) glows evenly, at a fraction of a coherent one', () => {
    expect(scratchGlint([0, 0], [0, 1], 0)).toBeCloseTo(scratchGlint([0, 0], [1, 0], 0), 9);
    expect(scratchGlint([0, 0], [0, 1], 0)).toBeGreaterThan(0.1);
    expect(scratchGlint([0, 0], [0, 1], 0)).toBeLessThan(0.6);
  });
});

describe('the glare phase function', () => {
  it('falls as the inverse square of the angle away from the source and stays finite at it', () => {
    const r = glarePhase(cos(4)) / glarePhase(cos(8));
    expect(r).toBeGreaterThan(3.5);
    expect(r).toBeLessThan(4.1);
    expect(Number.isFinite(glarePhase(1))).toBe(true);
    expect(glarePhase(cos(100))).toBe(0);
  });
});

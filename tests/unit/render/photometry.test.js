// T2.5: photometric units: pointSource conserves flux across sprite sizes, emissive() scales by exposure and the
// lights-out factor, and the physical values of section 7.12 (plan 01).
import { describe, it, expect } from 'vitest';
import { pointSourceCpu, emissiveCpu } from '../../../src/env/nodes.js';
import { windowCdM2, ledCdM2, streetCdM2, PHOTOMETRY } from '../../../src/render/photometry.js';

describe('pointSource', () => {
  it('delivers the same flux whatever the sprite size', () => {
    const pixelSr = (2 * Math.tan((27 * Math.PI) / 360) / 800) ** 2;
    const flux = (s) => { const p = pointSourceCpu(5000, 800, pixelSr, { minPixels: s }); return p.luminanceCdM2 * p.sizePx ** 2 * pixelSr; };
    const one = flux(1);
    expect(one).toBeCloseTo(5000 / 800 ** 2, 12); // E = I / d^2
    for (const s of [1, 2, 3, 5, 8]) expect(flux(s)).toBeCloseTo(one, 12);
  });
  it('honours cityFactor for artificial lights only, and never draws less than one pixel', () => {
    const a = pointSourceCpu(1000, 100, 1e-7, { artificial: true, cityFactor: 0.25 });
    const b = pointSourceCpu(1000, 100, 1e-7, { artificial: false, cityFactor: 0.25 });
    expect(a.lux).toBeCloseTo(b.lux * 0.25, 12);
    expect(pointSourceCpu(1000, 100, 1e-7, { minPixels: 0 }).sizePx).toBe(1);
  });
});

describe('emissive and the physical values', () => {
  it('cd/m2 times exposure, times cityFactor when artificial', () => {
    expect(emissiveCpu(60, { exposure: 0.01 })).toBeCloseTo(0.6, 12);
    expect(emissiveCpu(60, { exposure: 0.01, artificial: true, cityFactor: 0.5 })).toBeCloseTo(0.3, 12);
  });
  // the stability pass (plan 01) dimmed the LED skins at night to 36 cd/m2 and raised the street glow to 2.2 cd/m2
  it('windows average 60 cd/m2, +-50 %; LED skins 1,200 dimmed to 3 % at night; street glow', () => {
    expect(windowCdM2(0.5)).toBe(60);
    expect(windowCdM2(0)).toBe(30);
    expect(windowCdM2(1)).toBe(90);
    expect(ledCdM2(0)).toBe(1200);
    expect(ledCdM2(1)).toBeCloseTo(36, 9);
    expect(streetCdM2(PHOTOMETRY.streetLegacyNear)).toBeCloseTo(2.2, 12);
  });
});

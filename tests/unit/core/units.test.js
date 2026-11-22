import { describe, it, expect } from 'vitest';
import * as u from '../../../src/core/units.js';

describe('units', () => {
  it('22.0 mag/arcsec2 is 1.71e-4 cd/m2, and back', () => {
    expect(u.cdM2FromMagArcsec2(22)).toBeCloseTo(1.71e-4, 6);
    expect(u.magArcsec2FromCdM2(1.71e-4)).toBeCloseTo(22, 2);
  });
  it('magnitude and lux are inverse', () => {
    for (const m of [-26.7, -12.7, -4, 0, 6.5]) expect(u.magnitudeFromLux(u.luxFromMagnitude(m))).toBeCloseTo(m, 9);
    expect(u.luxFromMagnitude(-26.74)).toBeGreaterThan(9e4); // the Sun: about 1e5 lux
  });
  it('EV100 of sunny-16 daylight is about 15', () => {
    expect(u.ev100FromLuminance(u.luminanceFromEv100(15))).toBeCloseTo(15, 9);
    expect(u.ev100FromIlluminance(100000)).toBeCloseTo(15.3, 1);
  });
  it('black bodies run from red to blue', () => {
    const warm = u.colorTemperatureToLinearSrgb(2000), cool = u.colorTemperatureToLinearSrgb(12000);
    expect(warm[0]).toBeGreaterThan(warm[1]);
    expect(warm[1]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    const d65ish = u.colorTemperatureToLinearSrgb(6504);
    for (const c of d65ish) expect(Math.abs(c - 1)).toBeLessThan(0.12);
  });
  it('a spectrum and its colour temperature agree, at luminance 1', () => {
    const a = u.colorTemperatureToLinearSrgb(3000), b = u.spectrumToLinearSrgb((nm) => u.planck(nm, 3000));
    expect(a).toEqual(b);
    expect(u.spectrumToXyz((nm) => u.planck(nm, 3000))[1]).toBe(1);
  });
});

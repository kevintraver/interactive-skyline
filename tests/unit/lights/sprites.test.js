// D5.4 and D5.5, the sprite shader (src/drive/lights/sprites.glsl.js) through its JavaScript mirror
// (spriteMirror.js): the intensity curves against lamps.js, the sprite rule against spriteFlux, the profile's
// conservation of light, the warm-up and switch-on time against lamps.js and switching.js, and the tone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLampTypes, spriteFlux } from '../../../src/drive/lights/lamps.js';
import { patternShape, kindOfOptic, spriteRule, profileAt, gammaTerm, warmSodium, toneSprite, onSeconds, instanceIntensity, PATTERN } from '../../../src/drive/lights/spriteMirror.js';
import { spriteVertex, spriteFragment } from '../../../src/drive/lights/sprites.glsl.js';
import { createOnTable, lampState, switchThresholdLux } from '../../../src/drive/lights/switching.js';
import { createEphemeris } from '../../../src/drive/env.js';

const typesJson = JSON.parse(readFileSync(new URL('../../../data/lamp_types.json', import.meta.url), 'utf8'));
const types = createLampTypes(typesJson);
const kOf = (t) => [t.kDown, t.kUp, 1 - t.uplight];

describe('the shader mirror against lamps.js', () => {
  it('gives each type\'s intensity toward sampled angles, with and without an aim', () => {
    for (const t of types.list) {
      const kind = kindOfOptic(t.optic);
      for (let th = 0; th <= 180; th += 3.5) {
        for (let ph = -180; ph < 180; ph += 22.5) {
          const want = t.intensity(th, ph, 10000);
          expect(10000 * patternShape(kind, kOf(t), th, ph)).toBeCloseTo(want, 6);
        }
        // the phi-average is analytic in the shader and a 2-degree sum in lamps.js
        const avg = t.intensityAvg(th, 10000), got = 10000 * patternShape(kind, kOf(t), th, null);
        expect(Math.abs(got - avg)).toBeLessThanOrEqual(0.005 * Math.max(avg, 1e-3 * 10000 * t.kDown) + 1e-6);
      }
    }
  });

  it('reads theta from the axis and phi from the aim as illuminanceAt does', () => {
    const t = types.byKey.get('led_street');
    // a lamp head 9 m up at the origin aimed along map +y (90 deg); an eye on the street side and one on the house side
    const lamp = [0, 9, 0], axis = [0, -1, 0];
    const street = instanceIntensity({ pos: lamp, eye: [0, 0, -20], intensity: 10000, kind: PATTERN.cutoff, k: kOf(t), axis, aimRad: Math.PI / 2 });
    const house = instanceIntensity({ pos: lamp, eye: [0, 0, 20], intensity: 10000, kind: PATTERN.cutoff, k: kOf(t), axis, aimRad: Math.PI / 2 });
    expect(street.phi).toBeCloseTo(90, 6);
    expect(house.phi).toBeCloseTo(-90, 6);
    expect(street.intensity).toBeCloseTo(t.intensity(street.theta, 90, 10000), 6);
    expect(street.intensity).toBeGreaterThan(house.intensity);
  });

  it('keeps the GLSL in step with the mirror (constants that must agree)', () => {
    for (const s of ['wing(t, 65.0, 14.0)', 'wing(t, 70.0, 16.0)', 'wing(t, 98.0, 10.0)', 'wing(t, 60.0, 18.0)', 'smoothstep01(78.0, 90.0, t)',
      'smoothstep01(84.0, 90.0, t)', 'smoothstep01(80.0, 90.0, t)', '0.65', '0.675', '0.902745', '0.886227', '0.887264', '0.892980',
      'max(2.0 * dPx, 4.0)', 'mix(2.0, 6.0, smoothstep01(2.0, 8.0, dPx))', 'smoothstep01(2.0, 6.0, dPx)', 's / 140.0', 's / 100.0', '0.05 + 0.95 * pf']) {
      expect(spriteVertex, s).toContain(s);
    }
    expect(spriteFragment).toContain('0.0245786');
    expect(spriteFragment).not.toMatch(/\bdiscard\s*;/); // it would turn off the early depth test
  });
});

describe('the sprite rule', () => {
  const pixelAngle = (2 * Math.tan((27 * Math.PI) / 360)) / 1080;
  it('is spriteFlux', () => {
    for (const d of [3, 30, 300, 3000, 30000]) {
      for (const I of [10, 1000, 30000]) {
        const a = spriteFlux({ intensityCd: I, distanceM: d, pixelSolidAngleSr: pixelAngle ** 2, minDiameterPx: 1.5, transmittance: Math.exp(-d / 80000) });
        const b = spriteRule({ intensityCd: I, distanceM: d, pixelAngle, minPx: 1.5, visibilityM: 80000 });
        expect(b.illuminanceLux).toBeCloseTo(a.illuminanceLux, 12);
        expect(b.diameterPx).toBeCloseTo(a.diameterPx, 9);
        expect(b.radiance / a.radiance).toBeCloseTo(1, 9);
      }
    }
  });

  it('conserves the summed light of a sprite on the pixel grid, small or large, halo or not', () => {
    for (const d of [8, 30, 120, 2000, 20000]) {
      for (const halo of d < 10 ? [0, 0.006] : [0, 0.006, 0.2]) {
        const s = spriteRule({ intensityCd: 1000, distanceM: d, pixelAngle, halo });
        for (const off of [[0, 0], [0.5, 0.5], [0.23, 0.71]]) {
          let sum = 0;
          const R = Math.ceil(Math.max(6 * s.a, s.halo > 0 ? 6 * s.haloA : 0)) + 2;
          for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) sum += profileAt(s, Math.hypot(x + off[0], y + off[1]));
          // radiance x profile summed over pixels x the pixel's solid angle is the illuminance at the eye
          expect(sum * s.radiance * pixelAngle ** 2 / s.illuminanceLux).toBeCloseTo(1, 2);
        }
      }
    }
  }, 60000);

  it('draws a quad that holds nearly all of a bright sprite\'s light', () => {
    for (const d of [8, 30, 120, 2000]) {
      const s = spriteRule({ intensityCd: 3000, distanceM: d, pixelAngle, halo: 0.006 });
      const cmax = s.radiance * 0.1; // lighting.units.nit, gain 1
      const e = s.extentFor(cmax);
      let inside = 0, all = 0;
      const R = Math.ceil(Math.max(6 * s.a, 6 * s.haloA)) + 2;
      for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
        const v = profileAt(s, Math.hypot(x, y));
        all += v; if (Math.abs(x) <= e && Math.abs(y) <= e) inside += v;
      }
      expect(inside / all).toBeGreaterThan(0.98);
    }
  });

  it('keeps summed radiance toward a viewer between 2 km and 20 km once transmittance and inverse square are divided out', () => {
    const at = (d) => { const s = spriteRule({ intensityCd: 800, distanceM: d, pixelAngle, visibilityM: 30000 }); return (s.radiance * s.solidAngleSr * d * d) / Math.exp(-d / 30000); };
    expect(at(20000) / at(2000)).toBeCloseTo(1, 6);
  });

  it('Gamma(1 + 2/n) by table', () => {
    const gamma = (z) => { let s = 0; const N = 200000, T = 40; for (let i = 0; i < N; i++) { const t = ((i + 0.5) / N) * T; s += t ** (z - 1) * Math.exp(-t); } return (s * T) / N; };
    for (const n of [2, 3, 4, 5, 6]) expect(gammaTerm(n)).toBeCloseTo(gamma(1 + 2 / n), 4);
  });
});

describe('warm-up and switch-on time', () => {
  const hps = types.byKey.get('hps');
  it('the shader\'s sodium warm-up is lamps.js warmup', () => {
    const start = hps.warmup(0).uv, steady = hps.steadyUv;
    for (const t of [0, 20, 60, 120, 200, 400, 1000]) {
      const want = hps.warmup(t), got = warmSodium(t, start, steady);
      expect(got.flux).toBeCloseTo(want.flux, 9);
      for (let c = 0; c < 3; c++) expect(got.color[c]).toBeCloseTo(want.color[c], 6);
    }
  });

  it('a lamp\'s seconds since switch-on from the table agree with lampState', () => {
    const eph = createEphemeris({ origin: { lat: 36.1147, lon: -115.1728 }, tz: 'America/Los_Angeles' });
    const table = createOnTable(eph);
    const evening = eph.timeOfSunElevation(-4, Date.parse('2026-11-21T20:00:00Z'), true);
    for (const simMs of [evening, evening + 15 * 60000, evening + 3 * 3600000, evening + 9 * 3600000]) {
      const tab = table(simMs);
      for (let i = 0; i < 300; i += 7) {
        const st = lampState(i, simMs, eph);
        if (!st.lit) continue;
        expect(Math.abs(onSeconds(tab, switchThresholdLux(i)) - st.secondsOn)).toBeLessThan(5);
      }
    }
  });
});

describe('the sprite tone', () => {
  it('never clips a channel, keeps the hue of what does not clip and rises with luminance', () => {
    const amber = [1.6, 0.9, 0.25];
    let last = -1;
    for (const k of [0.01, 0.1, 0.5, 1, 3, 10, 100, 1000]) {
      const o = toneSprite(amber.map((c) => c * k));
      expect(Math.max(...o)).toBeLessThanOrEqual(1 + 1e-9);
      const y = 0.2126 * o[0] + 0.7152 * o[1] + 0.0722 * o[2];
      if (k < 3) expect(y).toBeGreaterThan(last); else expect(y).toBeGreaterThanOrEqual(last);
      last = y;
      if (k <= 0.5) expect(o[0] / o[1]).toBeCloseTo(amber[0] / amber[1], 6);
    }
    expect(toneSprite([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

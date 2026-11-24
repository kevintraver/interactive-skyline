// D7.3: the LED skins' program (night.js ledGlow) mirrored in screens/led.js: held to the shader's text,
// deterministic in time, and under the flash-rate limit of plan 02, section 4.11 at every playback rate.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ledColor, ledMean, ledSamples, ledLevel, nightHash, createLedMeanCache } from '../../../src/drive/screens/led.js';
import { measureFlash, luminance, FLASH_LIMIT_HZ } from '../../../src/drive/screens/flash.js';
import { contentSeconds, CONTENT_PERIOD_S } from '../../../src/drive/screens/clock.js';

const ROOT = path.resolve(__dirname, '../../..');
// the GLSL the drive mirrors is the classic renderer's (plan 01 moved it out of night.js in its phase 2)
const night = fs.readFileSync(path.join(ROOT, 'src/render/legacy/materials.js'), 'utf8');

// the Sphere (buildings.json w976405284: centre 966.2 E, 726.2 N, 112 m tall), as LED points on a sphere of 78 m
function sphereSamples(n = 400) {
  const c = [966.2, 56, -726.2], R = 78, out = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963;
    if (y < -0.6) continue; // the skin stops above the ground
    out.push(c[0] + R * r * Math.cos(a), c[1] + R * y, c[2] + R * r * Math.sin(a), 1);
  }
  const s = new Float32Array(out), k = s.length / 4;
  for (let i = 3; i < s.length; i += 4) s[i] = 1 / k;
  return s;
}
const PEAK = luminance(1, 1, 1); // colour and pulse are each at most 1 at level 1

describe('the LED program mirror', () => {
  it('copies the shader formula of night.js (change both together)', () => {
    for (const line of [
      'p = fract(p * vec2(123.34, 456.21));', 'p += dot(p, p + 45.32);', 'return fract(p.x * p.y);',
      'return nightHash(p.xy + vec2(p.z * 7.13, p.z * 3.71));',
      'float n = ledNoise(p * 0.022 + vec3(0.0, -0.11 * t, 0.05 * t));',
      'float band = p.y * 0.018 + dot(p.xz, vec2(0.009, 0.006)) - 0.05 * t + 0.7 * n;',
      'vec3 color = 0.55 + 0.45 * cos(6.2832 * (band + vec3(0.0, 0.33, 0.67)));',
      'float pulse = 0.65 + 0.35 * sin(6.2832 * (2.0 * band - 0.07 * t));',
      'return color * pulse * vLed * mix(0.05, 1.2, uNight);',
    ]) expect(night, line).toContain(line);
  });

  it('is deterministic in time and place', () => {
    const a = ledColor(1000, 40, -700, 123.456), b = ledColor(1000, 40, -700, 123.456);
    expect(a).toEqual(b);
    expect(ledColor(1000, 40, -700, 124)).not.toEqual(a);
    expect(nightHash(3, 7)).toBe(nightHash(3, 7));
    for (const v of a) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });

  it('level follows the night uniform: faint by day, bright at night', () => {
    expect(ledLevel(0)).toBeCloseTo(0.05, 6);
    expect(ledLevel(1)).toBeCloseTo(1.2, 6);
  });

  it('the mean over samples is the weighted mean of the points', () => {
    const s = sphereSamples(50), m = ledMean(s, 300);
    let r = 0;
    for (let i = 0; i < s.length; i += 4) r += ledColor(s[i], s[i + 1], s[i + 2], 300)[0] * s[i + 3];
    expect(m[0]).toBeCloseTo(r, 6);
  });

  it('samples faces by area', () => {
    // two triangles, the second four times the area of the first, and a third not on the LED skin
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 9, 0, 0, 0, 9, 0];
    const led = [1, 1, 1, 1, 1, 1, 0, 0, 0];
    const { samples, area } = ledSamples(pos, led);
    expect(area).toBeCloseTo(2.5, 6);
    expect(samples.length).toBe(8);
    expect(samples[3]).toBeCloseTo(0.2, 6);
    expect(samples[7]).toBeCloseTo(0.8, 6);
    const many = ledSamples(pos, led, 1);
    expect(many.samples.length).toBe(4);
  });

  // a UV sphere of 78 m (the Sphere's size and place), 64 x 32 quads, its skin above the lowest fifth
  const uvSphere = () => {
    const pos = [], led = [], c = [966.2, 56, -726.2], R = 78, NU = 64, NV = 32;
    const at = (u, v) => { const th = (u / NU) * 2 * Math.PI, ph = (v / NV) * Math.PI; return [c[0] + R * Math.sin(ph) * Math.cos(th), c[1] + R * Math.cos(ph), c[2] + R * Math.sin(ph) * Math.sin(th)]; };
    for (let v = 0; v < NV * 0.8; v++) for (let u = 0; u < NU; u++) {
      const a = at(u, v), b = at(u + 1, v), d = at(u, v + 1), e = at(u + 1, v + 1);
      pos.push(...a, ...d, ...b, ...b, ...d, ...e);
      led.push(1, 1, 1, 1, 1, 1);
    }
    return { pos, led };
  };

  it('512 stratified samples of a sphere\'s faces give its mean within 2.5% of all of them', () => {
    const { pos, led } = uvSphere();
    const all = ledSamples(pos, led, 1e9).samples, few = ledSamples(pos, led, 512).samples;
    expect(few.length / 4).toBe(512);
    for (const t of [0, 300, 1234.5, 3000]) {
      const a = ledMean(all, t), b = ledMean(few, t);
      for (let k = 0; k < 3; k++) expect(Math.abs(a[k] - b[k]) / a[k], `t ${t} channel ${k}`).toBeLessThan(0.025);
    }
  });

  it('the per-frame cache is a pure function of time: exact on its grid, interpolated between, however it was filled', () => {
    const { pos, led } = uvSphere();
    const s = ledSamples(pos, led, 512).samples;
    const a = createLedMeanCache(s), b = createLedMeanCache(s);
    // b is filled ahead in slices, as while playing; a all at once, as after a seek
    for (let i = 0; i < 40; i++) b.advance(100.2, 1, 16);
    for (const t of [101, 102, 101.5, 100.25]) expect(b.at(t)).toEqual(a.at(t));
    expect(a.at(102)).toEqual(ledMean(s, 102));
    const m0 = ledMean(s, 101), m1 = ledMean(s, 102), x = a.at(101.25);
    for (let k = 0; k < 3; k++) expect(x[k]).toBeCloseTo(m0[k] + 0.25 * (m1[k] - m0[k]), 12);
    // and close to the program between grid points (the mean moves slowly)
    const d = ledMean(s, 101.5);
    for (let k = 0; k < 3; k++) expect(Math.abs(a.at(101.5)[k] - d[k])).toBeLessThan(0.01);
  });

  // the limit: at most 3 flashes (6 transitions of 10% of peak) in any second of real time, of the screen's mean
  // luminance; and, so that no large part of the Sphere flashes on its own, of each quarter of it (WCAG's 25%)
  for (const rate of [0.25, 1, 4, 16]) {
    it(`stays under ${FLASH_LIMIT_HZ} Hz at ${rate}x, over the whole Sphere and over each quarter`, () => {
      const s = sphereSamples();
      const whole = measureFlash((t) => ledMean(s, t).map((v) => v / PEAK), { rate, seconds: 20, t0: 1000 });
      expect(whole.flashesPerSecond).toBeLessThanOrEqual(FLASH_LIMIT_HZ);
      for (let q = 0; q < 4; q++) {
        const idx = [];
        for (let i = 0; i < s.length / 4; i++) {
          const a = Math.atan2(s[i * 4 + 2] + 726.2, s[i * 4] - 966.2);
          if (Math.floor(((a + Math.PI) / (2 * Math.PI)) * 4) % 4 === q) idx.push(i);
        }
        const part = new Float32Array(idx.length * 4);
        idx.forEach((i, k) => { part.set(s.subarray(i * 4, i * 4 + 3), k * 4); part[k * 4 + 3] = 1 / idx.length; });
        const m = measureFlash((t) => ledMean(part, t).map((v) => v / PEAK), { rate, seconds: 12, t0: 1000 });
        expect(m.flashesPerSecond, `quarter ${q}`).toBeLessThanOrEqual(FLASH_LIMIT_HZ);
      }
    }, 60000);
  }
});

describe('the content clock', () => {
  it('is the time within the UTC hour, the same for the same moment', () => {
    const t = Date.parse('2026-11-22T02:30:15.250Z');
    expect(contentSeconds(t)).toBeCloseTo(1815.25, 6);
    expect(contentSeconds(t + CONTENT_PERIOD_S * 1000)).toBeCloseTo(1815.25, 6);
    expect(contentSeconds(t + 16000) - contentSeconds(t)).toBeCloseTo(16, 6);
    expect(contentSeconds(NaN)).toBe(0);
  });
  it('is a whole number of the fountain loop and the wheel turn', () => {
    expect(CONTENT_PERIOD_S % 80).toBe(0);
    expect(CONTENT_PERIOD_S % 180).toBe(0);
  });
});

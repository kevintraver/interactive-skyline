// T4.1, data half: the committed star catalogue decodes to the sky it came from.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeStars, raDecToVector } from '../../../src/sky/starCatalog.js';

const DIR = path.resolve(import.meta.dirname, '../../../public/data/sky');
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'stars.json'), 'utf8'));
const stars = decodeStars(fs.readFileSync(path.join(DIR, 'stars.bin')));

const dir = (i) => [stars.direction[i * 3], stars.direction[i * 3 + 1], stars.direction[i * 3 + 2]];
const angleDeg = (a, b) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;
const hms = (h, m, s) => (h + m / 60 + s / 3600) * 15;
const dms = (d, m, s) => Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);
const star = (name) => meta.names[name];

describe('stars.bin', () => {
  it('holds every star of the Bright Star Catalogue', () => {
    expect(stars.count).toBe(9096);
    expect(meta.count).toBe(9096);
    expect(meta.source.records).toBe(9110);
    expect(meta.dropped.count).toBe(14);
  });

  it('is sorted brightest first and starts with Sirius', () => {
    expect(star('Sirius')).toBe(0);
    for (let i = 1; i < stars.count; i++) expect(stars.vmag[i]).toBeGreaterThanOrEqual(stars.vmag[i - 1]);
  });

  it('puts Polaris within 0.8° of the north celestial pole, where its J2000 position says', () => {
    const p = dir(star('Polaris'));
    expect(angleDeg(p, [0, 0, 1])).toBeLessThan(0.8);
    // catalogue: 02h 31m 48.7s +89° 15′ 51″
    expect(angleDeg(p, raDecToVector(hms(2, 31, 48.7), dms(89, 15, 51)))).toBeLessThan(0.02);
  });

  // J2000 positions from SIMBAD (ICRS, epoch 2000), independent of the catalogue's own fields
  it.each([
    ['Sirius', hms(6, 45, 8.917), dms(-16, 42, 58.02)],
    ['Vega', hms(18, 36, 56.336), dms(38, 47, 1.28)],
    ['Betelgeuse', hms(5, 55, 10.305), dms(7, 24, 25.43)],
  ])('%s decodes to its J2000 direction within 0.02°', (name, ra, dec) => {
    expect(angleDeg(dir(star(name)), raDecToVector(ra, dec))).toBeLessThan(0.02);
  });

  it('round-trips V magnitudes to the millimagnitude', () => {
    for (const [name, v] of [['Sirius', -1.46], ['Canopus', -0.72], ['Vega', 0.03], ['Rigel', 0.12], ['Betelgeuse', 0.5], ['Polaris', 2.02]]) {
      expect(Math.abs(stars.vmag[star(name)] - v), name).toBeLessThan(0.0005);
    }
    expect(stars.vmag[stars.count - 1]).toBeLessThan(8.5);
  });

  it('makes Betelgeuse redder than Rigel', () => {
    const c = (i) => [stars.color[i * 3], stars.color[i * 3 + 1], stars.color[i * 3 + 2]];
    const b = c(star('Betelgeuse')), r = c(star('Rigel'));
    expect(b[0] / b[2]).toBeGreaterThan(2 * (r[0] / r[2]));
    expect(b[0]).toBe(1); // red is Betelgeuse's largest channel
    expect(r[2]).toBe(1); // blue is Rigel's
  });

  it('has unit directions and colours whose largest channel is full', () => {
    for (let i = 0; i < stars.count; i += 97) {
      expect(Math.hypot(...dir(i))).toBeCloseTo(1, 5);
      expect(Math.max(stars.color[i * 3], stars.color[i * 3 + 1], stars.color[i * 3 + 2])).toBeCloseTo(1, 2);
    }
  });
});

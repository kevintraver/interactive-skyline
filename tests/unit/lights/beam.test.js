// D5.1, data side: the headlamp maps written by scripts/make_beam.py, read through src/drive/lights/beam.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FMVSS108_LOW, FMVSS108_HIGH, DEFAULT_LAMPS, halfToFloat, decodeBeam, candelaAt, checkBeam, lampAngles,
  illuminancePerpendicular, roadIlluminance, spotMapTexture,
} from '../../../src/drive/lights/beam.js';

const dir = new URL('../../../public/data/drive/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('beam.json', dir), 'utf8'));
const low = decodeBeam(readFileSync(new URL('beam_low.bin', dir)), meta, 'low');
const high = decodeBeam(readFileSync(new URL('beam_high.bin', dir)), meta, 'high');

describe('decoding', () => {
  it('reads IEEE halves', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x7bff)).toBe(65504);
    expect(halfToFloat(0x0001)).toBe(2 ** -24);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0x7e00)).toBeNaN();
  });

  it('decodes both maps with the peaks beam.json records', () => {
    expect(low.data.length).toBe(meta.grid.nh * meta.grid.nv);
    expect(low.peakCd).toBe(meta.low.peakCd);
    expect(high.peakCd).toBe(meta.high.peakCd);
    expect(() => decodeBeam(new ArrayBuffer(10), meta)).toThrow();
  });

  it('samples bilinearly between grid nodes and is zero behind the lamp', () => {
    const { hMin, vMin, dh, dv, nh, data } = low;
    const a = data[0], b = data[1], c = data[nh];
    expect(candelaAt(low, hMin, vMin)).toBe(a);
    expect(candelaAt(low, hMin + dh / 2, vMin)).toBeCloseTo((a + b) / 2, 6);
    expect(candelaAt(low, hMin, vMin + dv / 2)).toBeCloseTo((a + c) / 2, 6);
    expect(candelaAt(low, 120, 0)).toBe(0);
    expect(candelaAt(null, 0, 0)).toBe(0);
  });
});

describe('FMVSS 108 (acceptance)', () => {
  it.each(checkBeam(low, FMVSS108_LOW).map((r) => [r.name, r]))('low beam %s is inside its limits', (_, r) => {
    if (r.min != null) expect(r.low).toBeGreaterThanOrEqual(r.min);
    if (r.max != null) expect(r.high).toBeLessThanOrEqual(r.max);
  });

  it.each(checkBeam(high, FMVSS108_HIGH).map((r) => [r.name, r]))('high beam %s is inside its limits', (_, r) => {
    expect(r.ok).toBe(true);
  });

  it('the checker catches a beam that breaks the table', () => {
    const glare = { ...low, data: low.data.map((c) => c * 3) };
    const bad = checkBeam(glare).filter((r) => !r.ok).map((r) => r.name);
    expect(bad).toContain('H-V');
    expect(bad).toContain('1U 1.5L-L');
  });
});

describe('illuminance on the road', () => {
  it('lampAngles measures right and up as positive, and subtracts the aim', () => {
    const a = lampAngles({ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 10 });
    expect(a.hDeg).toBeCloseTo(45, 9);
    expect(a.vDeg).toBeCloseTo(0, 9);
    const b = lampAngles([0, 0, 0], [0, -1, 1], { pitchDeg: -1 });
    expect(b.vDeg).toBeCloseTo(-44, 9);
  });

  it('is I cos / d^2 per lamp, and exactly zero with the lamps off', () => {
    const p = { x: 0.7, y: 0, z: 0.65 / Math.tan(4 * Math.PI / 180) }; // straight ahead of the right lamp, 4D
    const one = roadIlluminance(low, [DEFAULT_LAMPS[1]], p);
    const d2 = p.z ** 2 + 0.65 ** 2;
    expect(one).toBeCloseTo((candelaAt(low, 0, -4) * (0.65 / Math.sqrt(d2))) / d2, 6);
    expect(illuminancePerpendicular(low, DEFAULT_LAMPS[1], p)).toBeCloseTo(candelaAt(low, 0, -4) / d2, 6);
    expect(roadIlluminance(null, DEFAULT_LAMPS, p)).toBe(0);
  });

  // Plausible range, derived from the regulation itself [plan 02, C6] for two lamps 0.65 m high (DEFAULT_LAMPS):
  // the lane 30 m ahead is seen 1.24 deg down and 1.3 deg either side of each lamp's axis. Its neighbouring
  // minima are 4,500 cd (0.86D V) and 10,000-15,000 cd (0.6D 1.3R, 1.5D 2R); low beams peak at about 20,000-25,000
  // cd. E = 2 I h / d^3 gives 0.22-1.2 lux, and L = E rho / pi at rho 0.07-0.12 gives 0.005-0.05 cd/m^2.
  // For scale, a lit freeway is designed for about 0.4-0.6 cd/m^2 (ANSI/IES RP-8, recalled, not re-opened):
  // headlamps alone at 30 m are an order of magnitude dimmer, which is what drivers see on an unlit road.
  it('road luminance 30 m ahead in the lane is 0.005-0.05 cd/m^2 for asphalt of albedo 0.07-0.12 (acceptance)', () => {
    const e = roadIlluminance(low, DEFAULT_LAMPS, { x: 0, y: 0, z: 30 });
    for (const rho of [0.07, 0.12]) {
      const l = (e * rho) / Math.PI;
      expect(l).toBeGreaterThan(0.005);
      expect(l).toBeLessThan(0.05);
    }
    // nearer is brighter, farther dimmer, and the high beam reaches further
    expect(roadIlluminance(low, DEFAULT_LAMPS, { x: 0, y: 0, z: 15 })).toBeGreaterThan(e);
    expect(roadIlluminance(low, DEFAULT_LAMPS, { x: 0, y: 0, z: 60 })).toBeLessThan(e);
    expect(roadIlluminance(high, DEFAULT_LAMPS, { x: 0, y: 0, z: 60 })).toBeGreaterThan(roadIlluminance(low, DEFAULT_LAMPS, { x: 0, y: 0, z: 60 }));
  });

  it('lights the kerb side further than the oncoming side', () => {
    const right = roadIlluminance(low, DEFAULT_LAMPS, { x: 4, y: 0, z: 40 });
    const left = roadIlluminance(low, DEFAULT_LAMPS, { x: -4, y: 0, z: 40 });
    expect(right).toBeGreaterThan(left);
  });
});

describe('spot light texture', () => {
  it('is normalised to the peak and samples the map through the gnomonic projection', () => {
    const size = 64;
    const t = spotMapTexture(low, { size, halfAngleDeg: 45 });
    expect(t.data.length).toBe(size * size * 4);
    expect(t.peakCd).toBe(low.peakCd);
    expect(Math.max(...t.data)).toBeLessThanOrEqual(1);
    // the texel at (s, t) looks along (tan45 (2s - 1), tan45 (2t - 1), 1)
    const i = 40, j = 20, k = (j * size + i) * 4;
    const x = (2 * (i + 0.5)) / size - 1, y = (2 * (j + 0.5)) / size - 1;
    const h = Math.atan(x) * 180 / Math.PI, v = Math.atan2(y, Math.hypot(x, 1)) * 180 / Math.PI;
    expect(t.data[k] * t.peakCd).toBeCloseTo(candelaAt(low, h, v), 3);
    expect(t.data[k + 3]).toBe(1);
    // row 0 is down: the lower half is brighter than the upper (the cutoff)
    const sum = (j0, j1) => { let s = 0; for (let jj = j0; jj < j1; jj++) for (let ii = 0; ii < size; ii++) s += t.data[(jj * size + ii) * 4]; return s; };
    expect(sum(0, size / 2)).toBeGreaterThan(5 * sum(size / 2, size));
    expect(spotMapTexture(low, { size: 8, channels: 1 }).data.length).toBe(64);
  });
});

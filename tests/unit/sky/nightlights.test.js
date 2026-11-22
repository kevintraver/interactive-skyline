// T4.4, data half: the night-lights decoder, and the committed grids where they exist.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeNightLightsGrid, decodeRadiance, encodeRadiance, sampleGrid, createNightLights, upwardFraction } from '../../../src/sky/nightlights.js';

const spec = { x0: -1000, y0: -500, step: 500, nx: 4, ny: 3 };

function synthetic(radiance, ratio) {
  const n = spec.nx * spec.ny;
  const buf = new ArrayBuffer(3 * n);
  const view = new DataView(buf);
  radiance.forEach((r, i) => view.setUint16(2 * i, encodeRadiance(r), true));
  ratio.forEach((q, i) => (new Uint8Array(buf)[2 * n + i] = Math.round(q * 64)));
  return buf;
}

describe('night-lights decoding', () => {
  it('round-trips radiance through the square-root encoding', () => {
    for (const r of [0, 0.5, 1, 7.3, 100, 1234.5, 6553.5, 40000]) {
      const back = decodeRadiance(encodeRadiance(r));
      // one code step of sqrt(R) * 256 is at most (2 sqrt(R) + 1/256) / 256 in R
      expect(Math.abs(back - r)).toBeLessThanOrEqual((Math.sqrt(r) + 0.01) / 256 + 1e-9);
    }
    expect(encodeRadiance(1e9)).toBe(65535);
  });

  it('decodes a grid with row 0 in the south and world z = -north', () => {
    const rad = Array.from({ length: 12 }, (_, i) => i * 10);
    const ratio = Array.from({ length: 12 }, (_, i) => (i % 4) / 2);
    const g = decodeNightLightsGrid(spec, synthetic(rad, ratio));
    expect(g.radiance[5]).toBeCloseTo(50, 1);
    expect(g.ratio[3]).toBe(1.5);
    // cell centre of row 0, column 0 is x = -750, y (north) = -250, so z = +250
    expect(sampleGrid(g, g.radiance, -750, 250)).toBeCloseTo(0, 6);
    // row 2 (north), column 3: x = 750, y = 750 -> z = -750
    expect(sampleGrid(g, g.radiance, 750, -750)).toBeCloseTo(110, 1);
    // half way between two cell centres in x
    expect(sampleGrid(g, g.radiance, -500, 250)).toBeCloseTo(5, 1);
    expect(sampleGrid(g, g.radiance, 5000, 0)).toBe(0);
    expect(() => decodeNightLightsGrid(spec, new ArrayBuffer(10))).toThrow();
  });

  it('turns radiance into luminance and ground emission with k, G and F', () => {
    const g = decodeNightLightsGrid(spec, synthetic(Array(12).fill(371), Array(12).fill(1)));
    const nl = createNightLights({ meta: { calibration: { k: 371, G: 0.15 } }, metro: g });
    expect(nl.upwardLuminance(0, 0)).toBeCloseTo(1, 3);
    expect(upwardFraction(1)).toBe(0.05);
    expect(nl.groundEmission(0, 0)).toBeCloseTo(Math.PI / (0.15 * 0.95), 2);
    expect(() => createNightLights({ meta: { calibration: { k: null } }, metro: g }).upwardLuminance(0, 0)).toThrow(/not calibrated/);
  });
});

// Landmarks in Las Vegas local metres (x east, y north of Las Vegas Boulevard at Flamingo Road), from WGS84
// through the projection in public/data/lv/terrain.json.
const LV = path.resolve(import.meta.dirname, '../../../public/data/lv');
const have = fs.existsSync(path.join(LV, 'nightlights.json'));

describe.skipIf(!have)('Las Vegas night-lights grid (real VNP46A4 data)', () => {
  const meta = have ? JSON.parse(fs.readFileSync(path.join(LV, 'nightlights.json'), 'utf8')) : null;
  const load = (k) => decodeNightLightsGrid(meta.grids[k], fs.readFileSync(path.join(LV, meta.grids[k].file)));
  const metro = have ? load('metro') : null;
  const nl = have ? createNightLights({ meta, metro, region: load('region') }) : null;
  const at = (x, y) => nl.radiance(x, -y);
  const ring = (x, y, r) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(x + r * Math.cos((i * Math.PI) / 4), y + r * Math.sin((i * Math.PI) / 4)));

  it('covers the extent the drive plan asks for', () => {
    expect(meta.grids.metro.step).toBe(500);
    expect(meta.grids.metro.x0).toBeLessThanOrEqual(-60000);
    expect(meta.grids.metro.y0).toBeLessThanOrEqual(-65000);
    expect(meta.grids.metro.x0 + meta.grids.metro.nx * 500).toBeGreaterThanOrEqual(50000);
    expect(meta.grids.metro.y0 + meta.grids.metro.ny * 500).toBeGreaterThanOrEqual(50000);
  });

  it('puts the Strip among the brightest cells and brighter than its surroundings', () => {
    const strip = at(0, 0);
    const sorted = Float32Array.from(metro.radiance).sort();
    expect(strip).toBeGreaterThan(sorted[Math.floor(sorted.length * 0.99)]);
    for (const v of ring(0, 0, 4000)) expect(strip).toBeGreaterThan(v);
  });

  it('lights downtown (Fremont Street) and the airport apron', () => {
    const desert = at(-20381, 31682);
    expect(at(2681, 6214)).toBeGreaterThan(20 * Math.max(desert, 0.5));
    expect(at(2054, -3628)).toBeGreaterThan(20 * Math.max(desert, 0.5));
  });

  it('leaves the open desert dark', () => {
    expect(at(-20381, 31682)).toBeLessThan(2); // Desert National Wildlife Range
    expect(at(-34095, -34853)).toBeLessThan(2); // west of the Spring Mountains' south end
  });
});

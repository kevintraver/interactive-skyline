// The corridor format (src/drive/corridor/format.js) against the fixture the Python writer produced
// (tests/data/test_corridor.py writes and checks the same bytes): a round trip on the JS side.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { decodeCell, encodeCell, buildingRings, CorridorFormatError, TYPE, RUNGS } from '../../../src/drive/corridor/format.js';

const dir = new URL('./fixtures/', import.meta.url);
const spec = JSON.parse(fs.readFileSync(new URL('cell.json', dir), 'utf8'));
const bin = (name) => { const b = fs.readFileSync(new URL(`${name}.bin`, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

describe('corridor format', () => {
  for (const name of ['cell', 'tall']) {
    it(`${name}: encodeCell writes the bytes the Python writer wrote`, () => {
      expect(new Uint8Array(encodeCell(spec[name]))).toEqual(new Uint8Array(bin(name)));
    });
    it(`${name}: decodeCell reads back what was written`, () => {
      const s = spec[name], c = decodeCell(bin(name));
      expect(c.origin).toEqual(s.origin);
      expect(c.wide).toBe(s.wide);
      expect(c.count).toBe(s.buildings.length);
      const tol = (s.wide ? 0.01 : 0.1) / 2 + 1e-9;
      s.buildings.forEach((b, k) => {
        expect(c.type[k]).toBe(b.type);
        expect(c.rung[k]).toBe(b.rung);
        expect(Math.abs(c.height[k] / 10 - b.height)).toBeLessThanOrEqual(0.05 + 1e-9);
        const rings = buildingRings(c, k);
        expect(rings.map((r) => r.length)).toEqual(b.rings.map((r) => r.length));
        rings.forEach((r, i) => r.forEach(([x, y], j) => {
          expect(Math.abs(x - b.rings[i][j][0])).toBeLessThanOrEqual(tol);
          expect(Math.abs(y - b.rings[i][j][1])).toBeLessThanOrEqual(tol);
        }));
      });
    });
  }

  it('rounds half away from zero, as the Python writer does', () => {
    const c = decodeCell(bin('cell'));
    const [p0, p1] = buildingRings(c, 2)[0];
    expect(p0[0]).toBeCloseTo(2899.7, 6); expect(p0[1]).toBeCloseTo(-54900.2, 6);
    expect(p1[0]).toBeCloseTo(2930.2, 6);
    expect(c.height[1]).toBe(123);
  });

  it('names its types and rungs, and refuses what it cannot read', () => {
    expect(TYPE.canopy).toBe(8);
    expect(RUNGS[2]).toBe('overture');
    expect(() => decodeCell(new ArrayBuffer(8))).toThrow(CorridorFormatError);
    const bad = bin('cell').slice(0);
    new DataView(bad).setUint16(4, 2, true);
    expect(() => decodeCell(bad)).toThrow(/version 2/);
    expect(() => decodeCell(bin('cell').slice(0, 60))).toThrow(CorridorFormatError);
    expect(() => encodeCell({ origin: [0, 0], buildings: [{ rings: [[[0, 0], [4000, 0], [0, 10]]], height: 3, type: 0, rung: 3 }] })).toThrow(/too far/);
  });
});

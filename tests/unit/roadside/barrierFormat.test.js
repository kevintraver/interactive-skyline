// Barriers v1 (src/drive/roadside/barrierFormat.js): the reference writer and the Python writer
// (scripts/lib/roadside_barrier_format.py) give the same text for tests/fixtures/barriers-input.json;
// decoding and encoding again changes nothing; malformed files are refused.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeBarriers, encodeBarriers, asDecoded, num, runsBySide, BarrierFormatError } from '../../../src/drive/roadside/barrierFormat.js';

const fix = new URL('../../fixtures/', import.meta.url);
const text = readFileSync(new URL('barriers.json', fix), 'utf8');
const input = JSON.parse(readFileSync(new URL('barriers-input.json', fix), 'utf8'));
const realUrl = new URL('../../../public/data/lv/barriers.json', import.meta.url);
const realText = readFileSync(realUrl, 'utf8');
const real = JSON.parse(realText);

describe('barrier format', () => {
  it('writes the same text as the Python writer for the fixture', () => {
    expect(encodeBarriers(input)).toBe(text);
  });

  it('round-trips: decode then encode gives the file back, for the fixture and the real file', () => {
    expect(encodeBarriers(decodeBarriers(JSON.parse(text)))).toBe(text);
    expect(encodeBarriers(decodeBarriers(real))).toBe(realText);
  });

  it('decodes runs, wall fields, ends, provenance and delineators', () => {
    const d = decodeBarriers(JSON.parse(text));
    const [main, ramp] = d.roads;
    expect(main.runs[0]).toMatchObject({ s0: 0, s1: 120, side: 'left', type: 'concrete', o0: 0.45, o1: 1.2, prov: 'rule', open0: true, open1: false });
    expect(main.runs[3]).toMatchObject({ type: 'wall', h: 4, z0: 0, z1: -0.28, prov: 'mapped', open0: true, open1: true });
    expect(main.delineators[1]).toEqual({ side: 'left', colour: 'yellow', o: 0.9, s: [30, 66.5] });
    expect(ramp.role).toBe('ramp'); // unknown fields are kept
    expect(runsBySide(main).left).toHaveLength(3);
    expect(asDecoded(d)).toBe(d);
    expect(asDecoded(JSON.parse(text)).roads[0].runs[0].side).toBe('left');
  });

  it('rounds half away from zero and never writes -0', () => {
    expect(num(0.125, 2)).toBe(0.13);
    expect(num(-0.125, 2)).toBe(-0.13);
    expect(Object.is(num(-0.0001, 2), 0)).toBe(true);
    expect(num(12.0, 1)).toBe(12);
  });

  it('refuses malformed files', () => {
    const doc = JSON.parse(text);
    const bad = (f) => { const d = JSON.parse(text); f(d); return () => decodeBarriers(d); };
    expect(bad((d) => { d.version = 2; })).toThrow(BarrierFormatError);
    expect(bad((d) => { d.roads[0].runs[0][1] = -1; })).toThrow(/s0 < s1/);
    expect(bad((d) => { d.roads[0].runs[0][3] = 9; })).toThrow(/type/);
    expect(bad((d) => { d.roads[0].runs[0].length = 9; })).toThrow(/8 or 11/);
    expect(bad((d) => { d.roads[0].delineators[0][3] = [5, 4]; })).toThrow(/increase/);
    expect(bad((d) => { d.roads[0].runs.reverse(); })).toThrow(/order/);
    expect(() => decodeBarriers(doc)).not.toThrow();
  });

  it('keeps the real file small: about 100 kB or less', () => {
    const size = readFileSync(realUrl).length;
    expect(size).toBeLessThan(100_000);
  });
});

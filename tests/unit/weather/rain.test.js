import { describe, it, expect } from 'vitest';
import { dropPositions, dropCount, rainOffsets, dropVelocity, relativeRain, CLASS_SPEED, BOX_M, dropSeed, dropLocal, lowBeamShare, shutterAt } from '../../../src/drive/weather/rainMirror.js';
import { sprayStrength } from '../../../src/drive/weather/spray.js';
import { weatherFor } from '../../../src/drive/env.js';

const heavy = weatherFor(12);
const centre = [60000.25, 612.5, -41234.75];
const T = Date.parse('2026-11-22T02:30:00Z');

describe('rain', () => {
  it('draws no drops when dry and more as it rains harder', () => {
    expect(dropCount(0)).toBe(0);
    expect(dropCount(1)).toBeLessThan(dropCount(4));
    expect(dropCount(4)).toBeLessThan(dropCount(12));
  });
  it('falls at the measured speeds (Atlas et al.)', () => {
    expect(CLASS_SPEED[3]).toBeGreaterThan(7);
    expect(CLASS_SPEED[0]).toBeGreaterThan(3);
  });
  it('places the drops as a pure function of simulation time: a paused frame holds, a scrub repeats', () => {
    const a = dropPositions({ simMs: T, state: heavy, centre });
    const b = dropPositions({ simMs: T + 5000, state: heavy, centre });
    const c = dropPositions({ simMs: T, state: heavy, centre });
    expect(c.positions).toEqual(a.positions);
    expect(b.positions).not.toEqual(a.positions);
  });
  it('moves each drop by its velocity between nearby times (modulo the cube)', () => {
    const dt = 0.016;
    const o0 = rainOffsets(T, heavy, centre), o1 = rainOffsets(T + dt * 1000, heavy, centre);
    for (let i = 0; i < 200; i++) {
      const s = dropSeed(i), c = Math.min(3, Math.floor(s[3] * 4)), v = dropVelocity(heavy, c);
      const p0 = dropLocal(s, o0), p1 = dropLocal(s, o1);
      for (let k = 0; k < 3; k++) {
        let d = p1[k] - p0[k] - v[k] * dt;
        d -= Math.round(d / BOX_M) * BOX_M;
        expect(Math.abs(d)).toBeLessThan(1e-4); // v t in double precision: micrometres
      }
    }
  });
  it('stays inside the cube around its centre', () => {
    const { positions, count } = dropPositions({ simMs: T, state: heavy, centre });
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) expect(Math.abs(positions[3 * i + k] - centre[k])).toBeLessThanOrEqual(BOX_M / 2);
  });
  it('gives the windshield the rain relative to the car', () => {
    const pose = { forward: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, speed: 30 };
    const r = relativeRain(weatherFor(4, { windMps: 0 }), pose);
    expect(r.velocityCar[2]).toBeCloseTo(-30, 6); // coming at the glass
    expect(r.velocityCar[1]).toBeCloseTo(-CLASS_SPEED[2], 6);
    expect(r.volumeFlux).toBeCloseTo(4 / 3.6e6, 12);
    expect(relativeRain(weatherFor(0), pose).raining).toBe(false);
  });
  it('is brightest in the beam', () => {
    expect(lowBeamShare([Math.tan(2 * Math.PI / 180), Math.tan(-1.75 * Math.PI / 180), 1])).toBeCloseTo(1, 3);
    expect(lowBeamShare([0, 0.2, 1])).toBeLessThan(0.01);
    expect(lowBeamShare([0, 0, -1])).toBe(0);
  });
  it('keeps the shutter to the frame at the rates in use', () => {
    expect(shutterAt(1)).toBeCloseTo(1 / 60, 9);
    expect(shutterAt(16)).toBeCloseTo(4 / 60, 9);
  });
});

describe('spray', () => {
  it('is zero dry or standing, and grows with speed and wetness', () => {
    expect(sprayStrength(0, 30)).toBe(0);
    expect(sprayStrength(1, 2)).toBe(0);
    expect(sprayStrength(1, 30)).toBe(1);
    expect(sprayStrength(0.5, 20)).toBeLessThan(sprayStrength(1, 20));
    expect(sprayStrength(1, 15)).toBeLessThan(sprayStrength(1, 25));
  });
});

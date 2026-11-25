// The exposure while flying (src/flight/exposure.js): the lamps' light at the aircraft, the floor, the ground term and
// the guard at a grazing Sun, as the prior's terms plan 01's look takes (src/render/look.js setPriorTerms).
import { describe, it, expect } from 'vitest';
import {
  mergeLampCells, placeLampCells, lampIlluminance, flightPriorTerms,
  GLASS_TRANSMISSION, ADAPT_FLOOR_LUX, LIT_TERRAIN_SIN, GROUND_SHARE, GROUND_FADE_M, POOL_RANGE_M,
} from '../../../src/flight/exposure.js';
import { stackOptics, PANE_TINT } from '../../../src/flight/window/paneOptics.js';
import { POOL_RANGE_M as LAMPS_POOL_RANGE_M, GROUND_ALBEDO, ALL_LIGHT_FACTOR } from '../../../src/flight/ground/lamps.js';
import { priorEv100, physicalLights } from '../../../src/render/photometry.js';

/** A tiny pack in the drive's decoded layout: two cells of a 2 x 1 grid, the second empty. */
function pack(lamps) {
  const n = lamps.length;
  return {
    count: n, nx: 3, ny: 1, cellStart: Uint32Array.from([0, n, n, n]),
    x: Float64Array.from(lamps.map((l) => l.x)), y: Float64Array.from(lamps.map((l) => l.y)),
    lumens: Float32Array.from(lamps.map((l) => l.lm)), mount: Float32Array.from(lamps.map((l) => l.mount ?? 9)),
    type: Uint8Array.from(lamps.map((l) => l.type ?? 0)), enclosed: Uint8Array.from(lamps.map((l) => (l.enclosed ? 1 : 0))),
  };
}

describe('the lamp cells', () => {
  it('merge a cell into its flux-weighted centre, the down flux only, tunnel lamps left out', () => {
    const p = pack([{ x: 0, y: 0, lm: 1000, type: 0 }, { x: 100, y: 0, lm: 3000, type: 1 }, { x: 50, y: 50, lm: 9999, enclosed: true }]);
    const s = mergeLampCells(p, (t) => (t === 0 ? 0.5 : 1));
    expect(s.n).toBe(1);
    expect(s.flux[0]).toBe(500 + 3000);
    expect(s.x[0]).toBeCloseTo((0 * 500 + 100 * 3000) / 3500, 9);
    expect(s.y[0]).toBe(0);
  });
  it('are placed on the ground in the scene: z = -north, the curve dropped', () => {
    const s = { n: 1, x: Float64Array.of(1000), y: Float64Array.of(2000), mount: Float32Array.of(9), flux: Float64Array.of(5) };
    const c = placeLampCells([s], { heightAt: () => 900, base: 600, curveDrop: (x, y) => (x === 1000 && y === 2000 ? 7 : NaN) });
    expect(Array.from(c)).toEqual([1000, 293, -2000, 5]);
  });
});

describe('the lamps\' light at the eye', () => {
  const cell = (x, gy, z, flux) => Float64Array.of(x, gy, z, flux);
  it('is the pools as the lamp points draw them: albedo x flux / pi x cos(zenith) / d^2, through the air', () => {
    const E = lampIlluminance(cell(0, 0, 0, 1e6), { x: 0, y: 3000, z: 0 }, { extinctionM: 30000, albedo: 0.75 });
    expect(E / ((0.75 * 1e6 * Math.exp(-3000 / 30000)) / Math.PI / 3000 ** 2)).toBeCloseTo(1, 9);
    // seen at 45 degrees: cos 0.707 and twice the squared distance
    const E45 = lampIlluminance(cell(3000, 0, 0, 1e6), { x: 0, y: 3000, z: 0 }, { extinctionM: Infinity, albedo: 0.75 });
    expect(E45 / ((0.75 * 1e6 * Math.SQRT1_2) / Math.PI / (2 * 3000 ** 2))).toBeCloseTo(1, 9);
  });
  it('fades the pools in from 300 m to 2.5 km, as the sprites do, and sees nothing from below', () => {
    expect(POOL_RANGE_M).toEqual(LAMPS_POOL_RANGE_M);
    const c = cell(0, 0, 0, 1e6);
    expect(lampIlluminance(c, { x: 0, y: 250, z: 0 })).toBe(0);
    const mid = lampIlluminance(c, { x: 0, y: 1400, z: 0 }, { extinctionM: Infinity }), full = (0.75 * 1e6) / Math.PI / 1400 ** 2;
    expect(mid).toBeGreaterThan(0.3 * full);
    expect(mid).toBeLessThan(0.7 * full);
    expect(lampIlluminance(c, { x: 5000, y: -10, z: 0 })).toBe(0);
  });
  it('is zero with the lamps off, the lights out or no cells, and scales with the lit share', () => {
    const c = cell(0, 0, 0, 1e6), eye = { x: 0, y: 3000, z: 0 };
    expect(lampIlluminance(c, eye, { lit: 0 })).toBe(0);
    expect(lampIlluminance(c, eye, { cityFactor: 0 })).toBe(0);
    expect(lampIlluminance(null, eye)).toBe(0);
    expect(lampIlluminance(c, eye, { lit: 0.25 })).toBeCloseTo(0.25 * lampIlluminance(c, eye), 15);
  });
  it('uses the lamp points\' albedo by default (GROUND_ALBEDO x ALL_LIGHT_FACTOR)', () => {
    const c = cell(0, 0, 0, 1e6), eye = { x: 0, y: 3000, z: 0 };
    expect(lampIlluminance(c, eye)).toBeCloseTo(lampIlluminance(c, eye, { albedo: GROUND_ALBEDO * ALL_LIGHT_FACTOR }), 15);
  });
});

describe('the prior\'s terms while flying', () => {
  const night = physicalLights({ keyBody: 'moon', keyWeight: 1, sunPower: 0.2 }, { pinned: false, moonLux: 0, ambientLux: 0.0006, street: 1 });
  it('takes the glass within 1 % of the window stack at normal incidence times the tint', () => {
    const tint = 0.2126 * PANE_TINT[0] + 0.7152 * PANE_TINT[1] + 0.0722 * PANE_TINT[2];
    expect(Math.abs(GLASS_TRANSMISSION / (stackOptics(1).T * tint) - 1)).toBeLessThan(0.01);
  });
  it('replaces the city stand-in with the lamps through the glass plus the floor', () => {
    const t = flightPriorTerms({ ...night, keyAltDeg: -30 }, { lampLux: 0.4, keyIsSun: false });
    expect(t.cityLux).toBeCloseTo(GLASS_TRANSMISSION * 0.4 + ADAPT_FLOOR_LUX, 12);
    expect(t.emissionLux).toBe(0);
    expect(t).toMatchObject({ keyLux: night.keyLux, ambientLux: night.ambientLux, keyAltDeg: -30, lampLux: GLASS_TRANSMISSION * 0.4, groundLux: 0, floorLux: ADAPT_FLOOR_LUX });
  });
  it('takes the lights-out slider on the lamps, and gives the city light the lamps\' light at the eye (plan 01\'s on the ground)', () => {
    const half = flightPriorTerms({ ...night, keyAltDeg: -30 }, { lampLux: 0.4, keyIsSun: false, cityFactor: 0.5 });
    expect(half.lampLux).toBeCloseTo(GLASS_TRANSMISSION * 0.2, 12);
    expect(half.cityLightLux).toBe(0.4); // the look applies the slider to its light itself
    const high = flightPriorTerms({ ...night, keyAltDeg: -30 }, { lampLux: 0.001, keyIsSun: false });
    expect(high.cityLightLux).toBe(0.001);
    const ground = flightPriorTerms({ ...night, keyAltDeg: -30 }, { lampLux: 0.001, heightAboveGroundM: 0, keyIsSun: false });
    expect(ground.cityLightLux).toBeCloseTo(0.001 + night.cityLux, 12);
  });
  it('over dark desert at night exposes about three stops brighter than plan 01\'s lit street', () => {
    const plan01 = priorEv100({ ...night, keyAltDeg: -30 });
    const flying = priorEv100(flightPriorTerms({ ...night, keyAltDeg: -30 }, { lampLux: 0, keyIsSun: false }));
    expect(plan01 - flying).toBeGreaterThan(2.5);
    expect(plan01 - flying).toBeLessThan(3.5);
  });
  it('brings a share of plan 01\'s city terms back near the ground, gone by GROUND_FADE_M', () => {
    const t0 = flightPriorTerms({ ...night, keyAltDeg: -30 }, { heightAboveGroundM: 0, keyIsSun: false });
    expect(t0.groundLux).toBeCloseTo(GROUND_SHARE * (night.cityLux + night.emissionLux), 12);
    const tMid = flightPriorTerms({ ...night, keyAltDeg: -30 }, { heightAboveGroundM: GROUND_FADE_M / 2, keyIsSun: false });
    expect(tMid.groundLux).toBeCloseTo(t0.groundLux / 2, 9);
    expect(flightPriorTerms({ ...night, keyAltDeg: -30 }, { heightAboveGroundM: GROUND_FADE_M, keyIsSun: false }).groundLux).toBe(0);
    // by day plan 01's city terms are 0, so is the ground's
    expect(flightPriorTerms({ keyLux: 1e5, keyAltDeg: 40, ambientLux: 15000, cityLux: 0, emissionLux: 0 }, { heightAboveGroundM: 0 }).groundLux).toBe(0);
  });
  it('keys a grazing Sun to lit terrain, not flat ground', () => {
    const dusk = { keyLux: 59000, keyAltDeg: 0.2, ambientLux: 300, cityLux: 0, emissionLux: 0 };
    const t = flightPriorTerms(dusk);
    expect(Math.sin((t.keyAltDeg * Math.PI) / 180)).toBeCloseTo(LIT_TERRAIN_SIN, 12);
    // a desert slope (reflectance 0.3) facing the Sun at 45 degrees: about 4 stops over the prior's average, inside
    // AgX's shoulder
    const slope = (0.3 * dusk.keyLux * Math.SQRT1_2) / Math.PI;
    const avg = (2 ** priorEv100(t) * 12.5) / 100;
    expect(Math.log2(slope / avg)).toBeLessThan(4.5);
    // plan 01's flat ground put it more than six stops over
    expect(Math.log2(slope / ((2 ** priorEv100(dusk) * 12.5) / 100))).toBeGreaterThan(6);
  });
  it('fades the guard out over two degrees below the horizon and from 1 to 6 degrees above it, and leaves the Moon alone', () => {
    const at = (alt, o = {}) => flightPriorTerms({ keyLux: 59000, keyAltDeg: alt, ambientLux: 100, cityLux: 0, emissionLux: 0 }, o).keyAltDeg;
    expect(Math.sin((at(-1) * Math.PI) / 180)).toBeCloseTo(LIT_TERRAIN_SIN / 2, 12);
    expect(at(-2)).toBe(-2);
    expect(at(-5)).toBe(-5);
    expect(at(30)).toBe(30);
    // full to 1 degree up, gone by 6 (the slopes clip only below about 2): a Sun 9.6 degrees up at cruise is untouched
    expect(Math.sin((at(1) * Math.PI) / 180)).toBeCloseTo(LIT_TERRAIN_SIN, 12);
    expect(at(4.2)).toBe(4.2);
    expect(at(6)).toBe(6);
    expect(at(9.6)).toBe(9.6);
    expect(at(0.2, { keyIsSun: false })).toBe(0.2);
    expect(flightPriorTerms({ keyLux: 0, keyAltDeg: 0.2, ambientLux: 100, cityLux: 0, emissionLux: 0 }).keyAltDeg).toBe(0.2);
  });
  it('leaves a day prior within a thousandth of a stop of plan 01\'s', () => {
    for (const [alt, amb] of [[6, 4000], [9.6, 8000], [12, 9000], [30, 13000], [60, 15000]]) {
      const day = { keyLux: 100000, keyAltDeg: alt, ambientLux: amb, cityLux: 0, emissionLux: 0 };
      expect(Math.abs(priorEv100(flightPriorTerms(day, { lampLux: 0, heightAboveGroundM: 0 })) - priorEv100(day))).toBeLessThan(1e-3);
    }
  });
});

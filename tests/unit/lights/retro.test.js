// D5.2, model side: retroreflection of signs, markings and studs (src/drive/roadside/retro.js).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeBeam, DEFAULT_LAMPS, illuminancePerpendicular } from '../../../src/drive/lights/beam.js';
import {
  RETRO_TYPES, retroCoefficient, retroLuminance, retroIntensity, retroGeometry, retroFromHeadlamps, STUD_LENS_AREA_M2,
} from '../../../src/drive/roadside/retro.js';

const dir = new URL('../../../public/data/drive/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('beam.json', dir), 'utf8'));
const low = decodeBeam(readFileSync(new URL('beam_low.bin', dir)), meta, 'low');

// The driver's eye in the car frame of beam.js: ASSUMED 1.2 m up (the design eye height of the plan's G9 is
// 1.08 m for a car; a crossover sits higher), 0.35 m left of the centre line, 1.5 m behind the lamps.
const EYE = { x: -0.35, y: 1.2, z: -1.5 };
// An overhead guide sign: ASSUMED legend centre 6.4 m above the road (17 ft clearance [R5] plus half a 2.4 m
// panel), over the middle of our lane, facing us.
const sign = (z) => ({ point: { x: 0, y: 6.4, z }, normal: [0, 0, -1] });

describe('tables', () => {
  it('hold the Type XI values at their nodes', () => {
    expect(retroCoefficient('white', 0.2, -4)).toBe(580);
    expect(retroCoefficient('white', 0.5, 4)).toBe(420);
    expect(retroCoefficient('white', 1.0, -4)).toBe(120);
    expect(retroCoefficient('white', 0.2, 30)).toBe(220);
    expect(retroCoefficient('green', 0.2, -4)).toBe(58);
    expect(retroCoefficient('green', 0.5, 30)).toBe(15);
    expect(retroCoefficient('yellow', 1.0, 30)).toBe(34);
    expect(retroCoefficient('red', 0.5, -4)).toBe(63);
  });

  it('interpolate log-linearly in alpha and linearly in beta, clamped at the ends', () => {
    const mid = retroCoefficient('white', 0.35, 0);
    expect(mid).toBeCloseTo(580 * (420 / 580) ** 0.5, 6);
    expect(retroCoefficient('white', 0.2, 17)).toBeCloseTo((580 + 220) / 2, 6);
    expect(retroCoefficient('white', 0.05, 0)).toBe(580);
    expect(retroCoefficient('white', 0.2, 80)).toBe(0);
    for (const type of Object.keys(RETRO_TYPES)) {
      let prev = Infinity;
      for (let a = 0.2; a <= 2; a += 0.05) {
        const r = retroCoefficient(type, a, 0);
        expect(r).toBeLessThanOrEqual(prev + 1e-12); // falls with the observation angle
        prev = r;
      }
    }
  });
});

describe('luminance (acceptance)', () => {
  it('reproduces the worked figure of section 7.4', () => {
    const e = (2 * 500) / 150 ** 2; // two lamps at 500 cd, 150 m: 0.044 lux
    expect(e).toBeCloseTo(0.0444, 4);
    const white = retroLuminance({ type: 'white', illuminancePerp: e, alphaDeg: 0.2, betaDeg: -4, viewAngleDeg: 0 });
    const green = retroLuminance({ type: 'green', illuminancePerp: e, alphaDeg: 0.2, betaDeg: -4, viewAngleDeg: 0 });
    expect(white).toBeCloseTo(25.8, 1);
    expect(green).toBeCloseTo(2.58, 2);
    // across the regulation's 500-2,700 cd at 0.5U 1R-3R and the alpha of 0.2-0.5 deg at that range
    const lo = retroLuminance({ type: 'white', illuminancePerp: e, alphaDeg: 0.5, betaDeg: 4 });
    const hi = retroLuminance({ type: 'white', illuminancePerp: (2 * 2700) / 150 ** 2, alphaDeg: 0.2, betaDeg: 4 });
    expect(lo).toBeGreaterThan(10);
    expect(hi).toBeGreaterThan(60);
    expect(hi / lo).toBeGreaterThan(5);
  });

  it('a white legend 150 m ahead under the low beam reads 10-60 cd/m^2, the green field about a tenth', () => {
    const white = retroFromHeadlamps({ type: 'white', map: low, eye: EYE, ...sign(150) });
    const green = retroFromHeadlamps({ type: 'green', map: low, eye: EYE, ...sign(150) });
    expect(white).toBeGreaterThan(10);
    expect(white).toBeLessThan(60);
    expect(green / white).toBeGreaterThan(0.08);
    expect(green / white).toBeLessThan(0.12);
  });

  it('with the lamps off the term is exactly zero', () => {
    expect(retroFromHeadlamps({ type: 'white', map: null, eye: EYE, ...sign(150) })).toBe(0);
    for (const type of Object.keys(RETRO_TYPES)) {
      expect(retroLuminance({ type, illuminancePerp: 0, alphaDeg: 0.2, betaDeg: 0 })).toBe(0);
      expect(retroIntensity({ type, illuminancePerp: 0, alphaDeg: 0.2, betaDeg: 0 })).toBe(0);
    }
  });

  it("moving the eye 0.5 m sideways at 50 m changes the return by the table's ratio within 15%", () => {
    const { point, normal } = sign(50);
    const tableRatio = (lamps, from, to) => {
      let before = 0, after = 0;
      for (const lamp of lamps) {
        const e = illuminancePerpendicular(low, lamp, point);
        before += e * retroCoefficient('white', retroGeometry(lamp, from, point, normal).alphaDeg, 0);
        after += e * retroCoefficient('white', retroGeometry(lamp, to, point, normal).alphaDeg, 0);
      }
      return after / before;
    };
    // either way: the eye sits between the lamps, so a sideways step nears one lamp and leaves the other
    for (const dx of [-0.5, 0.5]) {
      const moved = { ...EYE, x: EYE.x + dx };
      const at = (eye) => retroFromHeadlamps({ type: 'white', map: low, eye, ...sign(50) });
      const measured = at(moved) / at(EYE);
      expect(Math.abs(measured / tableRatio(DEFAULT_LAMPS, EYE, moved) - 1)).toBeLessThan(0.15);
    }
    // one lamp, eye stepping away from it: alpha grows from about 1.4 to 1.9 deg and the return falls with it
    const lamp = [DEFAULT_LAMPS[1]];
    const away = { ...EYE, x: EYE.x - 0.5 };
    const one = (eye) => retroFromHeadlamps({ type: 'white', map: low, lamps: lamp, eye, ...sign(50) });
    const measured = one(away) / one(EYE);
    expect(measured).toBeLessThan(0.6);
    expect(Math.abs(measured / tableRatio(lamp, EYE, away) - 1)).toBeLessThan(0.15);
  });
});

describe('geometry and kinds', () => {
  it('gives alpha, beta and nu', () => {
    const g = retroGeometry([0, 0, 0], [0, 1, 0], [0, 0, 100], [0, 0, -1]);
    expect(g.alphaDeg).toBeCloseTo(Math.atan(1 / 100) * 180 / Math.PI, 9);
    expect(g.betaDeg).toBeCloseTo(0, 9);
    expect(g.viewAngleDeg).toBeCloseTo(g.alphaDeg, 9);
    expect(g.dLamp).toBe(100);
    const tilted = retroGeometry([0, 0, 0], [0, 0, 0], [0, 0, 10], [Math.sin(0.5), 0, -Math.cos(0.5)]);
    expect(tilted.betaDeg).toBeCloseTo(0.5 * 180 / Math.PI, 9);
  });

  it('divides sheeting by cos(nu) but not markings, and spreads a stud over its lens', () => {
    const base = { illuminancePerp: 1, alphaDeg: 1.05, betaDeg: 88.76 };
    expect(retroLuminance({ type: 'markingWhite', ...base, viewAngleDeg: 88.6 })).toBeCloseTo(0.25, 9); // 250 mcd/m^2/lx
    const s0 = retroLuminance({ type: 'white', illuminancePerp: 1, alphaDeg: 0.2, betaDeg: 0, viewAngleDeg: 0 });
    const s60 = retroLuminance({ type: 'white', illuminancePerp: 1, alphaDeg: 0.2, betaDeg: 0, viewAngleDeg: 60 });
    expect(s60 / s0).toBeCloseTo(2, 9);
    expect(retroLuminance({ type: 'white', illuminancePerp: 1, alphaDeg: 0.2, betaDeg: 0, viewAngleDeg: 95 })).toBe(0);
    const i = retroIntensity({ type: 'studWhite', illuminancePerp: 1, alphaDeg: 0.2, betaDeg: 0 });
    expect(i).toBeCloseTo(0.279, 9);
    expect(retroLuminance({ type: 'studWhite', illuminancePerp: 1, alphaDeg: 0.2, betaDeg: 0 })).toBeCloseTo(0.279 / STUD_LENS_AREA_M2, 6);
    expect(retroLuminance({ type: 'white', illuminancePerp: 1, alphaDeg: 0.2, betaDeg: 0, ageing: 0.5 })).toBe(290);
    expect(() => retroLuminance({ type: 'nope', illuminancePerp: 1, alphaDeg: 0, betaDeg: 0 })).toThrow();
  });

  it('a stud in our lane 30 m ahead is a bright point under the low beam', () => {
    const point = { x: 1.8, y: 0.02, z: 30 }; // on the lane line to our right
    let i = 0;
    for (const lamp of DEFAULT_LAMPS) {
      const g = retroGeometry(lamp, EYE, point, [0, 0, -1]);
      i += retroIntensity({ type: 'studWhite', illuminancePerp: illuminancePerpendicular(low, lamp, point), alphaDeg: g.alphaDeg, betaDeg: g.betaDeg });
    }
    expect(i).toBeGreaterThan(0.1); // cd: at 30 m, about a 3rd-magnitude star's worth of light times a thousand
    expect(i).toBeLessThan(20);
  });
});

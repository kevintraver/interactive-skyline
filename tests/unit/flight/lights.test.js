// The aircraft's own lights (plan 03, sections 7.5, 7.8 and 8.2; F3.8), the pure part: which lamps are on, how bright
// each group is at a moment of presentation time, the flash limit of three a second, and reduced motion.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIGHT } from '../../../src/flight/track.js';
import {
  GROUPS, MAX_FLASHES_PER_S, FLASHERS, lampLevels, inferLights, lightBits, flashLevel, limitFlashers, lampTable, COLOURS, CANDELA,
  effectiveIntensity,
} from '../../../src/flight/aircraft/lights.js';

const rig = JSON.parse(readFileSync(new URL('../../../public/models/aircraft/rig.json', import.meta.url), 'utf8'));
const FT = 0.3048;
const ALL = 255;

/** Rising edges of each flasher through 0.5 of its peak, merged and sorted, over [t0, t1) in steps of dt. */
function flashTimes(levelsAt, t0, t1, dt = 1 / 240) {
  const out = [];
  let prev = null;
  for (let t = t0; t < t1; t += dt) {
    const l = levelsAt(t);
    if (prev) for (const k of ['BEACON', 'STROBE']) if (l[GROUPS.indexOf(k)] >= 0.5 && prev[GROUPS.indexOf(k)] < 0.5) out.push(t);
    prev = l.slice();
  }
  return out.sort((a, b) => a - b);
}
const maxInAnySecond = (times) => {
  let worst = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j] < times[i] + 1; j++) n++;
    worst = Math.max(worst, n);
  }
  return worst;
};

describe('groups', () => {
  it('follows the bit field of the flight file, in its order', () => {
    expect(GROUPS).toEqual(['NAV', 'BEACON', 'STROBE', 'LANDING', 'TAXI', 'TURNOFF', 'LOGO', 'WING']);
    GROUPS.forEach((g, i) => expect(LIGHT[g]).toBe(1 << i));
    // and the baked attributes carry the same channels in the same order
    expect([...rig.lightChannels._LIGHTS0, ...rig.lightChannels._LIGHTS1]).toEqual(GROUPS);
  });
});

describe('lampLevels', () => {
  it('is 0 for a lamp whose bit is clear and 1 for a steady lamp whose bit is set', () => {
    const l = lampLevels(LIGHT.NAV | LIGHT.LANDING | LIGHT.WING, 3.21);
    expect(l[GROUPS.indexOf('NAV')]).toBe(1);
    expect(l[GROUPS.indexOf('LANDING')]).toBe(1);
    expect(l[GROUPS.indexOf('WING')]).toBe(1);
    for (const g of ['BEACON', 'STROBE', 'TAXI', 'TURNOFF', 'LOGO']) expect(l[GROUPS.indexOf(g)]).toBe(0);
  });

  it('flashes the beacon and strobes about once a second each, on presentation time', () => {
    const times = flashTimes((t) => lampLevels(ALL, t), 0, 20);
    expect(times.length).toBeGreaterThanOrEqual(36);
    expect(times.length).toBeLessThanOrEqual(42);
  });

  it('never flashes more than three times in any one second, at any playback rate', () => {
    expect(MAX_FLASHES_PER_S).toBe(3);
    for (const rate of [0.5, 1, 8, 60, 600]) {
      // journey time runs at `rate`, presentation time at the wall clock: the flashes follow the latter
      const levelsAt = (wall) => lampLevels(ALL, wall, { journeyT: wall * rate });
      expect(maxInAnySecond(flashTimes(levelsAt, 0, 12))).toBeLessThanOrEqual(3);
    }
  });

  it('gives no flashes under reduced motion: strobes and beacon steady and dim', () => {
    const times = flashTimes((t) => lampLevels(ALL, t, { reducedMotion: true }), 0, 10);
    expect(times).toEqual([]);
    const l = lampLevels(ALL, 1.234, { reducedMotion: true });
    for (const g of ['BEACON', 'STROBE']) {
      expect(l[GROUPS.indexOf(g)]).toBeGreaterThan(0);
      expect(l[GROUPS.indexOf(g)]).toBeLessThan(0.3);
    }
    expect(l[GROUPS.indexOf('NAV')]).toBe(1);
  });

  it('is a pure function of its inputs, and frozen while paused', () => {
    expect(lampLevels(ALL, 7.77)).toEqual(lampLevels(ALL, 7.77));
    const out = new Float32Array(8);
    expect(lampLevels(ALL, 7.77, {}, out)).toBe(out);
  });
});

describe('flash limiter', () => {
  it('leaves flashers alone that together stay at three a second, and staggers them', () => {
    const f = limitFlashers([{ id: 'a', rateHz: 1 }, { id: 'b', rateHz: 1 }]);
    expect(f.map((x) => x.rateHz)).toEqual([1, 1]);
    expect(f[0].phase).not.toBe(f[1].phase);
  });
  it('slows flashers that together would exceed three a second, in proportion', () => {
    const f = limitFlashers([{ id: 'a', rateHz: 2 }, { id: 'b', rateHz: 2 }, { id: 'c', rateHz: 1 }]);
    const total = f.reduce((s, x) => s + x.rateHz, 0);
    expect(total).toBeCloseTo(3, 9);
    expect(f[0].rateHz).toBeCloseTo(f[1].rateHz, 9);
    expect(f[0].rateHz).toBeGreaterThan(f[2].rateHz);
  });
  it('limits the shipped flashers', () => {
    expect(FLASHERS.reduce((s, x) => s + x.rateHz, 0)).toBeLessThanOrEqual(3);
  });
  it('makes one flash a short pulse with a dark gap', () => {
    const f = { rateHz: 1, phase: 0, widthS: 0.08 };
    expect(flashLevel(f, 0.04)).toBeGreaterThan(0.5);
    expect(flashLevel(f, 0.5)).toBe(0);
    expect(flashLevel(f, 1.04)).toBeCloseTo(flashLevel(f, 0.04), 9);
  });
});

describe('inferLights: the schedule, for a flight file without the channel', () => {
  const base = { altMsl: 11000 * FT, gear: 0, onGround: false, gs: 120 };
  it('has the position lights, beacon and strobes on in flight', () => {
    const b = inferLights(base);
    expect(b & LIGHT.NAV).toBeTruthy();
    expect(b & LIGHT.BEACON).toBeTruthy();
    expect(b & LIGHT.STROBE).toBeTruthy();
  });
  it('turns the landing lights on at 10,000 ft and off above', () => {
    expect(inferLights({ ...base, altMsl: 10100 * FT }) & LIGHT.LANDING).toBe(0);
    expect(inferLights({ ...base, altMsl: 9900 * FT }) & LIGHT.LANDING).toBeTruthy();
  });
  it('adds the runway turn-off and taxi lights with the gear, and the logo and wing lights at night below 10,000 ft', () => {
    const low = { ...base, altMsl: 3000 * FT };
    expect(inferLights(low) & (LIGHT.TAXI | LIGHT.TURNOFF)).toBe(0);
    expect(inferLights({ ...low, gear: 1 }) & LIGHT.TURNOFF).toBeTruthy();
    expect(inferLights({ ...low, gear: 1 }) & LIGHT.TAXI).toBeTruthy();
    expect(inferLights(low) & (LIGHT.LOGO | LIGHT.WING)).toBe(0);
    expect(inferLights(low, { night: true }) & LIGHT.LOGO).toBeTruthy();
    expect(inferLights(low, { night: true }) & LIGHT.WING).toBeTruthy();
    expect(inferLights(base, { night: true }) & LIGHT.WING).toBe(0);
  });
  it('lightBits takes the file\'s bits when it has them and the schedule otherwise', () => {
    expect(lightBits({ ...base, lights: LIGHT.NAV })).toBe(LIGHT.NAV);
    expect(lightBits({ ...base, lights: 0 })).toBe(inferLights(base));
    expect(lightBits({ ...base, lights: 0 }, { hasChannel: true })).toBe(0);
  });
});

describe('lampTable: the lamps of rig.json with colours and intensities', () => {
  const lamps = lampTable(rig);
  it('has every lamp, in its group, with a colour and a peak intensity in candela', () => {
    expect(lamps.length).toBe(Object.keys(rig.lights).length);
    for (const l of lamps) {
      expect(GROUPS[l.group]).toBe(rig.lights[l.name].channel);
      expect(l.colour).toEqual(COLOURS[rig.lights[l.name].colour]);
      expect(l.candela).toBeGreaterThan(0);
      expect(Math.hypot(...l.direction)).toBeCloseTo(1, 6);
    }
    const green = lamps.find((l) => l.name === 'nav_right');
    expect(green.colour[1]).toBeGreaterThan(green.colour[0]);
    expect(CANDELA.STROBE).toBeGreaterThan(CANDELA.NAV);
    expect(CANDELA.LANDING).toBeGreaterThan(CANDELA.STROBE);
  });
});

describe('photometry: the candela, colours and flashes the bake and the regulation assume', () => {
  it('uses the intensities the bake was made for (rig.json lightBake.candela, from spec.py)', () => {
    expect(rig.lightBake.candela).toEqual({ ...CANDELA });
  });

  it('gives the white aft position lights their own intensity, at least 25.1391(c)\'s 20 cd', () => {
    const lamps = lampTable(rig);
    for (const n of ['nav_aft_left', 'nav_aft_right']) expect(lamps.find((l) => l.name === n).candela).toBe(CANDELA.NAV_AFT);
    expect(CANDELA.NAV_AFT).toBeGreaterThanOrEqual(20);
    expect(CANDELA.NAV).toBeGreaterThanOrEqual(40); // 25.1391(b), within 10 degrees of ahead
  });

  it('flashes the beacon and the strobes at 25.1401(f)\'s 400 cd effective at least', () => {
    for (const f of FLASHERS) expect(effectiveIntensity(CANDELA[f.id], f.widthS), f.id).toBeGreaterThanOrEqual(400);
    // a steady light's effective intensity is its intensity: the form reduces to peak x t / (0.2 + t) for a square pulse
    expect(effectiveIntensity(1000, 1e9)).toBeCloseTo((1000 * 2) / Math.PI, 3);
  });

  /** CIE 1931 xy of a linear-sRGB colour. */
  const xyz = ([r, g, b]) => {
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const s = X + Y + Z;
    return { x: X / s, y: Y / s, z: Z / s, Y };
  };
  it('keeps aviation green and white inside 14 CFR 25.1397, and red at the display\'s red primary', () => {
    const g = xyz(COLOURS.green);
    expect(g.x).toBeLessThanOrEqual(0.440 - 0.320 * g.y);
    expect(g.x).toBeLessThanOrEqual(g.y - 0.170);
    expect(g.y).toBeGreaterThanOrEqual(0.390 - 0.170 * g.x);
    const w = xyz(COLOURS.white);
    expect(w.x).toBeGreaterThanOrEqual(0.300);
    expect(w.x).toBeLessThanOrEqual(0.540);
    expect(w.y).toBeGreaterThanOrEqual(w.x - 0.040);
    expect(w.y).toBeLessThanOrEqual(Math.min(w.x + 0.020, 0.636 - 0.400 * w.x));
    const r = xyz(COLOURS.red);
    expect(r.y).toBeLessThanOrEqual(0.335);
    expect(COLOURS.red[1]).toBe(0);
    expect(COLOURS.red[2]).toBe(0);
    for (const c of Object.values(COLOURS)) expect(xyz(c).Y).toBeCloseTo(1, 6);
  });
});

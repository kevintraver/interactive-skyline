// The wipers (plan 02, D8.2): the mode at each rain threshold, the blade angle as a function of simulation time
// (continuous, periodic, parked when dry), when a blade last passed a point, and the comfort rule at fast clock rates.
import { describe, expect, it } from 'vitest';
import {
  wiperMode, wiperSchedule, sweepAt, sweepAtPhase, wipePhase, passAgoAtPhase, passAgoAt, comfortOf, wiperState,
  WIPER_THRESHOLDS, WIPER_CPM,
} from '../../../src/drive/vehicle/wipers.js';
import { WIPERS, wiperDepth } from '../../../src/drive/vehicle/windshield.js';

const T0 = Date.parse('2026-11-22T02:30:00Z') / 1000;

describe('the wiper mode follows the rain rate', () => {
  it('off when dry, intermittent below 2.5 mm/h, low below 8, high from 8', () => {
    expect(wiperMode(0)).toBe('off');
    expect(wiperMode(-1)).toBe('off');
    expect(wiperMode(NaN)).toBe('off');
    expect(wiperMode(0.01)).toBe('intermittent');
    expect(wiperMode(1)).toBe('intermittent');
    expect(wiperMode(WIPER_THRESHOLDS.lowMmPerHour - 1e-9)).toBe('intermittent');
    expect(wiperMode(WIPER_THRESHOLDS.lowMmPerHour)).toBe('low');
    expect(wiperMode(4)).toBe('low');
    expect(wiperMode(WIPER_THRESHOLDS.highMmPerHour - 1e-9)).toBe('low');
    expect(wiperMode(WIPER_THRESHOLDS.highMmPerHour)).toBe('high');
    expect(wiperMode(12)).toBe('high');
    expect(wiperMode(100)).toBe('high');
  });

  it('the three rain presets get the three running modes; frequencies meet FMVSS 104 (one >= 45/min, 15 apart)', () => {
    expect([1, 4, 12].map(wiperMode)).toEqual(['intermittent', 'low', 'high']);
    expect(WIPER_CPM.low).toBeGreaterThanOrEqual(45);
    expect(WIPER_CPM.high - WIPER_CPM.low).toBeGreaterThanOrEqual(15);
    expect(wiperSchedule(4).periodS).toBeCloseTo(60 / 45, 9);
    expect(wiperSchedule(12).periodS).toBeCloseTo(60 / 65, 9);
    const i1 = wiperSchedule(1);
    expect(i1.pauseS).toBe(3);
    expect(i1.periodS).toBeCloseTo(3 + 60 / 45, 9);
    expect(wiperSchedule(0.1).pauseS).toBe(12);
    expect(wiperSchedule(2.4).pauseS).toBe(1.5);
  });
});

describe('the blade angle is a pure function of simulation time', () => {
  it('parked when dry, at any time', () => {
    for (let t = T0; t < T0 + 10; t += 0.37) {
      const s = wiperState(t, 0, WIPERS);
      expect(s.mode).toBe('off');
      expect(s.q).toBe(0);
      expect(s.angle).toBe(WIPERS[0].a0);
    }
  });

  it('periodic, continuous, within the arcs, reaching both ends', () => {
    for (const R of [1, 4, 12]) {
      const sched = wiperSchedule(R);
      let maxStep = 0, lo = 1, hi = 0, prev = sweepAt(T0, sched);
      const dt = 0.001;
      for (let t = T0; t < T0 + 3 * sched.periodS; t += dt) {
        const q = sweepAt(t, sched);
        expect(sweepAt(t + sched.periodS, sched)).toBeCloseTo(q, 6);
        maxStep = Math.max(maxStep, Math.abs(q - prev));
        lo = Math.min(lo, q); hi = Math.max(hi, q); prev = q;
      }
      // the steepest change of q = (1 - cos)/2 is pi / sweep per second
      expect(maxStep).toBeLessThan((Math.PI / sched.sweepS) * dt * 1.01);
      expect(lo).toBeLessThan(1e-9);
      expect(hi).toBeGreaterThan(0.9999);
      const s = wiperState(T0 + 0.3, R, WIPERS);
      expect(s.angles[0]).toBeGreaterThanOrEqual(WIPERS[0].a0);
      expect(s.angles[0]).toBeLessThanOrEqual(WIPERS[0].a1);
      expect(s.angles[1]).toBeGreaterThanOrEqual(WIPERS[1].a0);
      expect(s.angles[1]).toBeLessThanOrEqual(WIPERS[1].a1);
    }
  });

  it('intermittent: one sweep, then parked through the pause', () => {
    const sched = wiperSchedule(1);
    expect(sweepAtPhase(sched.sweepS + 0.01, sched)).toBe(0);
    expect(sweepAtPhase(sched.periodS - 0.01, sched)).toBe(0);
    expect(sweepAtPhase(sched.sweepS / 2, sched)).toBeCloseTo(1, 9);
  });
});

describe('when a blade last passed a point', () => {
  it('matches a brute-force search of the blade\'s past angles', () => {
    for (const R of [1, 4, 12]) {
      const sched = wiperSchedule(R);
      for (const q of [0.05, 0.3, 0.5, 0.77, 0.95]) {
        for (const t of [T0 + 0.1, T0 + 0.9, T0 + 2.2, T0 + 4.05]) {
          const ago = passAgoAtPhase(wipePhase(t, sched), sched, q);
          // walk back until the blade crosses q
          let found = Infinity;
          const side = Math.sign(sweepAt(t, sched) - q);
          for (let d = 0.0005; d < 2 * sched.periodS; d += 0.0005) {
            if (Math.sign(sweepAt(t - d, sched) - q) !== side) { found = d; break; }
          }
          expect(Math.abs(ago - found), `R ${R} q ${q} t ${t}`).toBeLessThan(0.002);
        }
      }
    }
  });

  it('Infinity outside the swept area and when the wipers are off', () => {
    const sched = wiperSchedule(4);
    expect(passAgoAt(0.02, 0.78, 0.5, sched, WIPERS)).toBe(Infinity); // top left corner: unswept
    expect(passAgoAt(0.46, 0.4, 0.5, sched, WIPERS)).toBeLessThan(sched.periodS); // the driver's view: swept
    expect(passAgoAt(0.46, 0.4, 0.5, wiperSchedule(0), WIPERS)).toBe(Infinity);
    // the same swept area as the dirt mask
    for (let x = 0.01; x < 1.66; x += 0.05) {
      for (let y = 0.01; y < 0.81; y += 0.05) {
        const inMask = WIPERS.some((w) => wiperDepth(x, y, w) > 0);
        expect(Number.isFinite(passAgoAt(x, y, 0.5, sched, WIPERS))).toBe(inMask);
      }
    }
  });
});

describe('comfort at fast clock rates (4.11)', () => {
  it('sharp at 1x, a whole-cycle average at 16x, nothing paused', () => {
    const high = wiperSchedule(12);
    expect(comfortOf(high, 1, true).c).toBe(0);
    expect(comfortOf(high, 1, true).exposureS).toBeCloseTo(1 / 60, 9);
    const fast = comfortOf(high, 16, true);
    expect(fast.c).toBe(1);
    expect(fast.exposureS).toBeCloseTo(high.periodS, 9);
    expect(fast.wipesPerRealS).toBeGreaterThan(3);
    expect(comfortOf(high, 16, false)).toEqual({ c: 0, exposureS: 0, wipesPerRealS: 0 });
    expect(comfortOf(wiperSchedule(0), 16, true).c).toBe(0);
    // averaged over a whole period, the blade's drawn coverage no longer depends on when the frame falls
    const avg = (t) => { let s = 0; for (let k = 0; k < 12; k++) s += sweepAt(t - (fast.exposureS * k) / 11, high); return s / 12; };
    const vals = Array.from({ length: 40 }, (_, k) => avg(T0 + k * 0.0167 * 16));
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThan(0.1);
  });
});

// Plan 03, F7.2 (4.6) and the decision of 25 Nov 2026: big changes must not take 46 minutes. The orbit flies every
// change at airliner rates (1,500 ft/min, 3 deg/s of roll, 27 deg of bank), right for a small change and absurd for a
// preset: 4,500 to 41,000 ft would take 46 minutes. A change whose flown transition would take longer than 60 seconds
// is made as a cut instead: the new orbit starts already established on the new circle, at the bearing from its centre
// nearest the old position. Small changes are flown; presets always cut.
import { describe, it, expect } from 'vitest';
import { createFrame } from '../../../src/world/frame.js';
import { createOrbitTrack, changeOrbit, planChange, estimateChangeS, ORBIT, PRESETS } from '../../../src/flight/orbit.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);
const FT = 0.3048;
const strip = { x: 316, n: 415 };
const base = createOrbitTrack({ center: strip, altFt: 12000, radiusKm: 9, phaseDeg: 140, seat: '22F', rollIn: false }, { frame });
const tNow = 333.3;
const fromCentre = (st, c) => Math.hypot(st.position.x - c.x, -st.position.z - c.n);
const bearing = (st, c) => ((Math.atan2(st.position.x - c.x, -st.position.z - c.n) * 180) / Math.PI + 360) % 360;
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

describe('the limit', () => {
  it('is 60 seconds of flown transition', () => {
    expect(ORBIT.flownMaxS).toBe(60);
  });
});

describe('estimateChangeS: a quick lower bound on the flown transition', () => {
  const cases = [
    ['a slightly wider circle', { radiusKm: 9.5 }],
    ['a wider circle', { radiusKm: 20 }],
    ['a climb of 1,000 ft', { altFt: 13000 }],
    ['a new centre nearby', { center: { x: -3000, n: 2500 } }],
    ['the other seat side', { seat: '22A' }],
    ['The Strip preset', { altFt: PRESETS.strip.altFt, radiusKm: PRESETS.strip.radiusKm }],
  ];
  for (const [name, change] of cases) {
    it(`never exceeds the flown transition: ${name}`, () => {
      const est = estimateChangeS(base, tNow, change);
      const flown = changeOrbit(base, tNow, change).track.joinT;
      expect(est).toBeGreaterThan(0);
      expect(est).toBeLessThanOrEqual(flown + 1e-6);
    });
  }

  it('is far over a minute for the 46-minute climb from 4,500 to 41,000 ft, without flying it', () => {
    const low = createOrbitTrack({ center: strip, altFt: 4500, radiusKm: 15, seat: '22F', rollIn: false }, { frame });
    const t0 = performance.now();
    const est = estimateChangeS(low, 10, { altFt: 41000 });
    expect(performance.now() - t0).toBeLessThan(20);
    // 36,500 ft at 1,500 ft/min is 24 minutes at the steady rate; the quintic's peak rate makes it longer
    expect(est).toBeGreaterThan((36500 / 1500) * 60);
  });
});

describe('planChange: flown when short, a cut when long', () => {
  it('flies a small radius change from where the aircraft is', () => {
    const r = planChange(base, tNow, { radiusKm: 9.5 });
    expect(r.cut).toBe(false);
    expect(r.flownS).toBeLessThanOrEqual(ORBIT.flownMaxS);
    expect(r.track.joinT).toBeGreaterThan(0);
    expect(r.track.sample(0).position.distanceTo(base.sample(tNow).position)).toBeLessThan(0.01);
    expect(r.params.radiusKm).toBeCloseTo(9.5, 9);
  });

  it('cuts a large radius change: on the new circle at once, at the bearing nearest the old position', () => {
    const was = base.sample(tNow);
    const r = planChange(base, tNow, { radiusKm: 20 });
    expect(r.cut).toBe(true);
    expect(r.track.joinT).toBe(0);
    const st = r.track.sample(0);
    expect(Math.abs(fromCentre(st, strip) - 20000)).toBeLessThan(1);
    expect(angleDiff(bearing(st, strip), bearing(was, strip))).toBeLessThan(1e-6);
    expect(Math.abs(st.altMsl - 12000 * FT)).toBeLessThan(0.01);
    expect(r.params.phaseDeg).toBeCloseTo(bearing(was, strip), 6);
    // established: the steady bank already, not a roll from the old one
    expect(Math.abs(r.track.sample(0).roll - r.track.sample(30).roll)).toBeLessThan(1e-6);
    // the clock goes on: the new track's start is the old one's at that moment
    expect(r.track.recordedStartMs).toBe(base.recordedStartMs + tNow * 1000);
  });

  it('cuts the climb from 4,500 to 41,000 ft and lands on the new height', () => {
    const low = createOrbitTrack({ center: strip, altFt: 4500, radiusKm: 15, seat: '22F', rollIn: false }, { frame });
    const r = planChange(low, 10, { altFt: 41000 });
    expect(r.cut).toBe(true);
    expect(Math.abs(r.track.sample(0).altMsl - 41000 * FT)).toBeLessThan(0.01);
  });

  it('always cuts a preset, however small the change', () => {
    const r = planChange(base, tNow, { altFt: 12000, radiusKm: 9.5 }, { cut: true });
    expect(r.cut).toBe(true);
    expect(r.track.joinT).toBe(0);
  });

  it('cuts a move of the centre beyond a minute, measuring the bearing from the new centre', () => {
    const was = base.sample(tNow);
    const c = { x: -3000, n: 2500 };
    const r = planChange(base, tNow, { center: c });
    expect(r.cut).toBe(true);
    const st = r.track.sample(0);
    expect(Math.abs(fromCentre(st, c) - 9000)).toBeLessThan(1);
    expect(angleDiff(bearing(st, c), bearing(was, c))).toBeLessThan(1e-6);
  });

  it('reverses the direction for the other seat side (a cut: the S-turn takes minutes)', () => {
    expect(base.orbit.direction).toBe('cw');
    const r = planChange(base, tNow, { seat: '22A' });
    expect(r.cut).toBe(true);
    expect(r.params.direction).toBe('ccw');
    expect(r.params.seat).toBe('22A');
    // anticlockwise: the bearing from the centre falls with time
    const a = r.track.phaseAt(0), b = r.track.phaseAt(5);
    expect(((a - b + 360) % 360)).toBeGreaterThan(0);
    expect(((a - b + 360) % 360)).toBeLessThan(10);
  });

  it('changes nothing for another seat on the same side', () => {
    const r = planChange(base, tNow, { seat: '30F' });
    expect(r.unchanged).toBe(true);
    expect(r.cut).toBe(false);
    expect(r.track).toBe(base);
  });

  it('keeps a chosen direction through a cut of the radius', () => {
    const ccw = createOrbitTrack({ center: strip, altFt: 12000, radiusKm: 9, seat: '22F', direction: 'ccw', rollIn: false }, { frame });
    const r = planChange(ccw, 50, { radiusKm: 25 });
    expect(r.cut).toBe(true);
    expect(r.params.direction).toBe('ccw');
  });

  it('is deterministic', () => {
    const a = planChange(base, tNow, { radiusKm: 20 }), b = planChange(base, tNow, { radiusKm: 20 });
    expect(a.track.sample(17).position.toArray()).toEqual(b.track.sample(17).position.toArray());
  });
});

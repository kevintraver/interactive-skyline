// Plan 03, F7.1/F7.2 (4.6): the orbit's controls as pure logic. Each change (radius, altitude, direction, speed, the
// centre) returns new parameters and a track that starts where the aircraft is at that moment: no jump in position,
// heading or bank, and the new track ends on the new circle. A change made in the middle of another is as smooth.
import { describe, it, expect } from 'vitest';
import { createFrame } from '../../../src/world/frame.js';
import { createOrbitTrack, changeOrbit, orbitSpeed, ORBIT } from '../../../src/flight/orbit.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);
const FT = 0.3048, DEG = Math.PI / 180;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const fromCentre = (st, c) => Math.hypot(st.position.x - c.x, -st.position.z - c.n);
const strip = { x: 316, n: 415 };
const base = createOrbitTrack({ center: strip, altFt: 12000, radiusKm: 9, phaseDeg: 140, seat: '22F', rollIn: false }, { frame });

/** The old track at tOld and the new one at 0 are the same aircraft. */
function expectContinuous(oldTrack, tOld, next) {
  const a = oldTrack.sample(tOld), b = next.sample(0);
  expect(b.position.distanceTo(a.position)).toBeLessThan(0.01);
  expect(Math.abs(wrapPi(b.heading - a.heading)) / DEG).toBeLessThan(1e-4);
  expect(Math.abs(b.roll - a.roll) / DEG).toBeLessThan(1e-4);
  expect(Math.abs(b.pitch - a.pitch) / DEG).toBeLessThan(1e-3);
  expect(b.velocity.distanceTo(a.velocity)).toBeLessThan(1e-4);
}

/** No step anywhere along a track: per quarter second, heading, bank and position move only as flight allows. */
function expectSmooth(track, until = track.joinT + 60) {
  let prev = track.sample(0);
  for (let t = 0.25; t <= until; t += 0.25) {
    const st = track.sample(t);
    expect(Math.abs(st.roll - prev.roll) / 0.25 / DEG, `roll rate at ${t}`).toBeLessThan(ORBIT.rollRateDegS * 1.05);
    expect(Math.abs(st.roll) / DEG, `bank at ${t}`).toBeLessThan(ORBIT.changeBankDeg + 1e-6);
    expect(Math.abs(wrapPi(st.heading - prev.heading)) / DEG, `heading step at ${t}`).toBeLessThan(1.5);
    expect(Math.abs(st.vs) * 60 / FT, `climb rate at ${t}`).toBeLessThan(ORBIT.climbFpm * 1.03);
    prev = st;
  }
}

const cases = [
  ['a wider circle', { radiusKm: 20 }, 'cw'],
  ['a tighter circle', { radiusKm: 5 }, 'cw'],
  ['a climb', { altFt: 18000 }, 'cw'],
  ['a descent below 6,000 ft (slower, flaps 1)', { altFt: 5500 }, 'cw'],
  ['a new centre (Orbit this)', { center: { x: -3000, n: 2500 } }, 'cw'],
  ['a faster speed', { iasKt: 250 }, 'cw'],
  ['looking outward: the direction reverses', { outward: true }, 'ccw'],
  ['another seat side: the direction reverses', { seat: '22A' }, 'ccw'],
  ['the direction itself', { direction: 'ccw' }, 'ccw'],
];

describe('every control change continues from the current position', () => {
  for (const [name, change, direction] of cases) {
    it(`${name}: no jump, smooth, and onto the new circle`, () => {
      const tNow = 333.3;
      const { params, track } = changeOrbit(base, tNow, change);
      expectContinuous(base, tNow, track);
      expectSmooth(track);
      expect(track.overLimit).toBe(false);
      // on the new circle once joined, at the new height and speed
      const c = params.center;
      for (const dt of [0, 77, track.lapS / 2]) {
        const st = track.sample(track.joinT + dt);
        expect(Math.abs(fromCentre(st, c) - params.radiusKm * 1000)).toBeLessThan(1);
        expect(st.altMsl).toBeCloseTo(params.altFt * FT, 6);
        expect(st.tas).toBeCloseTo(orbitSpeed(params.altFt * FT, params.iasKt ?? undefined).tas, 6);
      }
      expect(params.direction).toBe(direction);
      expect(track.orbit.direction).toBe(direction);
      expect(Math.sign(track.sample(track.joinT + 30).roll)).toBe(direction === 'cw' ? 1 : -1);
      expect(track.recordedStartMs).toBe(base.recordedStartMs + tNow * 1000);
    });
  }

  it('keeps the side the seat looks to: reversing puts the centre on the other wing', () => {
    const { track } = changeOrbit(base, 100, { outward: true });
    const st = track.sample(track.joinT + 50);
    expect(st.roll).toBeLessThan(0);
    expect(track.orbit.direction).toBe('ccw');
  });

  it('holds a change inside the limits: a radius below the smallest for the new altitude is raised to it', () => {
    const { params } = changeOrbit(base, 100, { altFt: 35000, radiusKm: 5 });
    expect(params.radiusKm).toBeGreaterThan(11.6);
  });

  it('is smooth for a change made in the middle of another (dragging a slider)', () => {
    const first = changeOrbit(base, 100, { radiusKm: 20 }).track;
    const tMid = first.joinT * 0.4;
    const second = changeOrbit(first, tMid, { radiusKm: 6, altFt: 9000 }).track;
    expectContinuous(first, tMid, second);
    expectSmooth(second);
    const third = changeOrbit(second, 5, { outward: true }).track;
    expectContinuous(second, 5, third);
    expectSmooth(third);
    expect(Math.abs(fromCentre(third.sample(third.joinT + 10), strip) - 6000)).toBeLessThan(1);
  });

  it('changes from the steady circle after many laps (the mode wraps the phase)', () => {
    const t = base.wrap(base.durationS + 1234.5);
    expect(t).toBeLessThanOrEqual(base.durationS);
    expect(base.sample(t).position.distanceTo(base.sample(t + base.lapS).position)).toBeLessThan(0.01);
    const { track } = changeOrbit(base, t, { radiusKm: 12 });
    expectContinuous(base, t, track);
  });

  it('gives back the same parameters and an unchanged path when nothing changes', () => {
    const { params, track } = changeOrbit(base, 200, {});
    expect(params.radiusKm).toBe(base.orbit.radiusKm);
    expect(Math.abs(fromCentre(track.sample(50), strip) - 9000)).toBeLessThan(1);
  });
});

describe('changes at the edges: strong wind, far centres, the smallest radius', () => {
  const windy = createOrbitTrack({ center: strip, altFt: 35000, radiusKm: 12, wind: { east: 40, north: 10 }, seat: '22F', rollIn: false }, { frame });
  const edge = [
    ['a reversal in a 40 m/s wind', windy, { outward: true }],
    ['a reversal and a descent in a 40 m/s wind', windy, { outward: true, altFt: 20000 }],
    ['a new wind', windy, { wind: { east: -10, north: 25 } }],
    ['Orbit this, 56 km away, at 35,000 ft near the bank limit', createOrbitTrack({ center: strip, altFt: 35000, radiusKm: 12, rollIn: false, seat: '22F' }, { frame }), { center: { x: 40000, n: -40000 } }],
    ['a reversal at the smallest radius, 6,000 ft', createOrbitTrack({ center: strip, altFt: 6000, radiusKm: 1, rollIn: false, seat: '22F' }, { frame }), { outward: true }],
  ];
  for (const [name, from, change] of edge) {
    it(`${name}: continuous, inside the limits, onto the new circle within 25 minutes`, () => {
      const tNow = 123.4;
      const { params, track } = changeOrbit(from, tNow, change);
      expectContinuous(from, tNow, track);
      expectSmooth(track);
      expect(track.overLimit).toBe(false);
      expect(track.joinT).toBeLessThan(25 * 60);
      expect(Math.abs(fromCentre(track.sample(track.joinT + 40), params.center) - params.radiusKm * 1000)).toBeLessThan(1);
    });
  }
});

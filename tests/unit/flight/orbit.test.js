// Plan 03, F7.1 (section 7.12, 4.6): the orbit as a generated track. The speed schedule and its limits, the circle's
// geometry, the coordinated-turn kinematics, the attitude from the lift model, the configuration and lights, and
// determinism. The expected numbers come from the plan's text (7.12, 7.3, 7.8), not from the module's own formulas.
import { describe, it, expect } from 'vitest';
import { orbitSpeed, minRadiusM, ORBIT, LIFT, pitchDeg, tasFromCas, createOrbitTrack, orbitParams, PRESETS, applySun } from '../../../src/flight/orbit.js';
import { createFrame } from '../../../src/world/frame.js';
import { LIGHT } from '../../../src/flight/track.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const FT = 0.3048, KT = 1852 / 3600, DEG = Math.PI / 180;

describe('the speed schedule (7.12: the FAA holding speeds, capped at the cruise Mach)', () => {
  it('is 200 KIAS to 6,000 ft, 230 KIAS to 14,000 ft and 265 KIAS above', () => {
    expect(orbitSpeed(4500 * FT).iasKt).toBe(200);
    expect(orbitSpeed(6000 * FT).iasKt).toBe(200);
    expect(orbitSpeed(6001 * FT).iasKt).toBe(230);
    expect(orbitSpeed(14000 * FT).iasKt).toBe(230);
    expect(orbitSpeed(20000 * FT).iasKt).toBe(265);
  });

  it('gives true airspeed from the standard atmosphere: about 2% more per 1,000 ft at these heights', () => {
    // the pilot's rule of thumb, an independent check of the compressible conversion at 10,000 ft
    const s = orbitSpeed(10000 * FT);
    expect(s.tas / KT).toBeGreaterThan(230 * 1.15);
    expect(s.tas / KT).toBeLessThan(230 * 1.21);
  });

  it('is capped at Mach 0.78 high up: 450 kt true at 35,000 ft (7.12)', () => {
    const s = orbitSpeed(35000 * FT);
    expect(s.mach).toBeCloseTo(0.78, 6);
    expect(Math.abs(s.tas / KT - 450)).toBeLessThan(2);
    expect(s.iasKt).toBeLessThan(265);
  });
});

describe('the smallest radius: the 25 degree bank limit (7.12)', () => {
  it('is 4.1 km at 230 KIAS and 10,000 ft and 11.7 km at 35,000 ft, as the plan works out', () => {
    expect(ORBIT.bankMaxDeg).toBe(25);
    expect(minRadiusM(10000 * FT) / 1000).toBeCloseTo(4.1, 1);
    expect(minRadiusM(35000 * FT) / 1000).toBeCloseTo(11.7, 1);
  });

  it('grows with a wind, which raises the ground speed downwind', () => {
    expect(minRadiusM(10000 * FT, 20)).toBeGreaterThan(minRadiusM(10000 * FT) + 500);
  });
});

describe('the lift model (7.3), the same as the bake fits', () => {
  it('fits the constants scripts/lib/attitude.py fits from the reference attitudes', () => {
    expect(LIFT.clAlpha).toBeCloseTo(0.092572, 5);
    expect(LIFT.alpha0(0)).toBeCloseTo(-2.5247, 3);
    expect(LIFT.alpha0(5)).toBeCloseTo(-5.5888, 3);
    expect(LIFT.alpha0(1)).toBeCloseTo(-3.1375, 3); // between clean and flaps 5 by the surface angle
  });

  it('returns 7.3s pitch attitudes at 60 t: 2.5 deg in cruise, 5.0 deg level clean at manoeuvring speed', () => {
    const cruiseTas = 0.78 * 296.535; // M0.78 at 35,000 ft (speed of sound 296.5 m/s)
    expect(pitchDeg({ tas: cruiseTas, altM: 35000 * FT, flap: 0, weightKg: 60000 })).toBeCloseTo(2.5, 1);
    const tas = tasFromCas(205 * KT, 5000 * FT);
    expect(pitchDeg({ tas, altM: 5000 * FT, flap: 0, weightKg: 60000 })).toBeCloseTo(5.0, 1);
  });

  it('raises the nose in a turn: lift must carry the load factor', () => {
    const base = { tas: 140, altM: 10000 * FT, flap: 0 };
    const level = pitchDeg(base), banked = pitchDeg({ ...base, n: 1 / Math.cos(25 * Math.PI / 180) });
    expect(banked - level).toBeGreaterThan(0.5);
    expect(banked - level).toBeLessThan(3);
  });
});

// ---------------------------------------------------------------------------------------------------- the track

const frame = createFrame(cities.lv);
const G0 = 9.80665;
/** Horizontal distance (m) of a sampled state from a centre, in the file's axes (x east, n north). */
const fromCentre = (st, c) => Math.hypot(st.position.x - c.x, -st.position.z - c.n);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

describe('the circle (7.12: a turn around a point)', () => {
  const center = { x: 316, n: 415 };
  const track = createOrbitTrack({ center, altFt: 10000, radiusKm: 9, phaseDeg: 140, seat: '22F', rollIn: false }, { frame });

  it('holds the radius within a metre all the way round, at constant height', () => {
    for (let t = 0; t <= track.durationS; t += 7.3) {
      const st = track.sample(t);
      expect(Math.abs(fromCentre(st, center) - 9000)).toBeLessThan(1);
      expect(Math.abs(st.altMsl - 10000 * FT)).toBeLessThan(1e-6);
      expect(st.vs).toBe(0);
    }
  });

  it('closes after a full turn: the same place and heading one lap later, and a lap is 2 pi r / V', () => {
    const v = orbitSpeed(10000 * FT).tas;
    expect(track.lapS).toBeCloseTo((2 * Math.PI * 9000) / v, 3);
    const a = track.sample(track.joinT + 10), b = track.sample(track.joinT + 10 + track.lapS);
    expect(a.position.distanceTo(b.position)).toBeLessThan(0.01);
    expect(Math.abs(wrapPi(a.heading - b.heading))).toBeLessThan(1e-6);
  });

  it('starts at the phase asked for: the bearing from the centre, clockwise from north', () => {
    const st = track.sample(0);
    expect(st.position.x - center.x).toBeCloseTo(9000 * Math.sin(140 * DEG), 3);
    expect(-st.position.z - center.n).toBeCloseTo(9000 * Math.cos(140 * DEG), 3);
    expect(track.phaseAt(0)).toBeCloseTo(140, 6);
  });

  it('banks atan(V^2 / (g r)) with the load factor 1 / cos(bank) and the turn rate V / r', () => {
    const v = orbitSpeed(10000 * FT).tas;
    const want = Math.atan((v * v) / (G0 * 9000));
    const st = track.sample(500);
    expect(Math.abs(st.roll - want) / DEG).toBeLessThan(0.01);
    expect(track.loadFactorAt(500)).toBeCloseTo(1 / Math.cos(want), 6);
    const dt = 1, h0 = track.sample(500 - dt / 2).heading, h1 = track.sample(500 + dt / 2).heading;
    expect(wrapPi(h1 - h0) / dt).toBeCloseTo(v / 9000, 6);
    expect(st.tas).toBeCloseTo(v, 6);
    expect(st.gs).toBeCloseTo(v, 6);
  });

  it('turns clockwise for a right-hand seat, so the seat looks into the circle (7.12)', () => {
    const st = track.sample(100);
    expect(st.roll).toBeGreaterThan(0); // right wing down
    // the centre is off the right wing: the heading plus 90 degrees points at it
    const toCentre = Math.atan2(center.x - st.position.x, center.n + st.position.z);
    expect(Math.abs(wrapPi(toCentre - (st.heading + Math.PI / 2))) / DEG).toBeLessThan(0.01);
    expect(track.orbit.direction).toBe('cw');
  });

  it('turns anticlockwise for a left-hand seat, and outward when asked to look at the mountains', () => {
    const left = createOrbitTrack({ center, altFt: 10000, radiusKm: 9, seat: '22A', rollIn: false }, { frame });
    expect(left.orbit.direction).toBe('ccw');
    expect(left.sample(100).roll).toBeLessThan(0);
    const out = createOrbitTrack({ center, altFt: 10000, radiusKm: 9, seat: '22F', outward: true, rollIn: false }, { frame });
    expect(out.orbit.direction).toBe('ccw');
  });

  it('pitches by the lift model at the load factor, and is clean above 210 KIAS, flaps 1 below (7.12)', () => {
    const st = track.sample(300);
    const v = orbitSpeed(10000 * FT).tas, bank = Math.atan((v * v) / (G0 * 9000));
    expect(st.pitch / DEG).toBeCloseTo(pitchDeg({ tas: v, altM: 10000 * FT, n: 1 / Math.cos(bank) }), 3);
    expect(st.flap).toBe(0);
    expect(st.slat).toBe(0);
    expect(st.gear).toBe(0);
    const low = createOrbitTrack({ center, altFt: 5000, radiusKm: 6, rollIn: false }, { frame }).sample(10);
    expect(low.ias / KT).toBeCloseTo(200, 6);
    expect(low.flap).toBe(1);
    expect(low.slat).toBe(1);
  });

  it('is never on the ground and never lands', () => {
    expect(track.touchdownT).toBe(Infinity);
    expect(track.sample(track.durationS / 2).onGround).toBe(false);
  });
});

describe('the roll-in (a smooth start from straight flight)', () => {
  const center = { x: 316, n: 415 };
  const track = createOrbitTrack({ center, altFt: 10000, radiusKm: 6, phaseDeg: 200, seat: '22F' }, { frame });

  it('starts wings level on a straight line and joins the circle at the phase asked for', () => {
    expect(track.joinT).toBeGreaterThan(0);
    expect(Math.abs(track.sample(0).roll)).toBeLessThan(1e-9);
    expect(track.phaseAt(track.joinT)).toBeCloseTo(200, 4);
    expect(Math.abs(fromCentre(track.sample(track.joinT), center) - 6000)).toBeLessThan(0.01);
    expect(track.events.map((e) => e.id).slice(0, 2)).toEqual(['rollIn', 'join']);
  });

  it('rolls no faster than 3 deg/s and never past the bank limit, with no step in heading or bank', () => {
    let prev = track.sample(0);
    for (let t = 0.25; t <= track.joinT + 30; t += 0.25) {
      const st = track.sample(t);
      expect(Math.abs(st.roll - prev.roll) / 0.25 / DEG).toBeLessThan(ORBIT.rollRateDegS * 1.05);
      expect(Math.abs(st.roll) / DEG).toBeLessThanOrEqual(ORBIT.bankMaxDeg + 1e-6);
      expect(Math.abs(wrapPi(st.heading - prev.heading)) / DEG).toBeLessThan(1);
      expect(st.position.distanceTo(prev.position)).toBeLessThan(st.gs * 0.25 * 1.01);
      prev = st;
    }
  });
});

describe('with a wind: the turn around a point (7.12, 8.2)', () => {
  const center = { x: 316, n: 415 };
  const wind = { east: 0, north: -20 }; // 20 m/s from the north (toward the south)
  const track = createOrbitTrack({ center, altFt: 10000, radiusKm: 9, seat: '22F', wind, rollIn: false }, { frame });
  const v = orbitSpeed(10000 * FT).tas;

  it('keeps the ground track a circle within 1 m', () => {
    for (let t = 0; t <= track.lapS * 1.2; t += 5.1) expect(Math.abs(fromCentre(track.sample(t), center) - 9000)).toBeLessThan(1);
  });

  it('flies the true airspeed through the air all the way round, the ground speed varying by the wind', () => {
    let lo = Infinity, hi = 0;
    for (let t = 0; t <= track.lapS; t += 3) {
      const st = track.sample(t);
      expect(Math.hypot(st.airVelocity.x, st.airVelocity.z)).toBeCloseTo(v, 6);
      lo = Math.min(lo, st.gs); hi = Math.max(hi, st.gs);
    }
    expect(hi - lo).toBeGreaterThan(38); // nearly twice the wind: v + 20 downwind, v - 20 upwind
  });

  it('banks steepest downwind and shallowest upwind, as atan(Vg^2 / (g r)) at each end', () => {
    // clockwise, the aircraft flies south (downwind) east of the centre, at phase 90, and north at phase 270
    const down = track.sample(track.timeAtPhase(90)), up = track.sample(track.timeAtPhase(270));
    expect(down.roll).toBeGreaterThan(up.roll);
    expect(down.roll / DEG).toBeCloseTo(Math.atan(((v + 20) ** 2) / (G0 * 9000)) / DEG, 1);
    expect(up.roll / DEG).toBeCloseTo(Math.atan(((v - 20) ** 2) / (G0 * 9000)) / DEG, 1);
  });

  it('crabs into the wind: the heading differs from the ground track where the wind is across it', () => {
    const st = track.sample(track.timeAtPhase(0)); // north of the centre, flying east, wind across from the left
    const trackDir = Math.atan2(st.velocity.x, -st.velocity.z);
    expect(Math.abs(wrapPi(st.heading - trackDir)) / DEG).toBeGreaterThan(5);
  });

  it('takes longer over a lap than in still air', () => {
    expect(track.lapS).toBeGreaterThan((2 * Math.PI * 9000) / v);
  });
});

describe('determinism', () => {
  it('gives the same track from the same parameters', () => {
    const o = { center: { x: 1200, n: -800 }, altFt: 18000, radiusKm: 14, phaseDeg: 33, seat: '9A', wind: { east: 7, north: 3 } };
    const a = createOrbitTrack(o, { frame }), b = createOrbitTrack(o, { frame });
    expect(b.durationS).toBe(a.durationS);
    for (const t of [0, 17.25, a.joinT, a.durationS * 0.7]) {
      const sa = a.sample(t), sb = b.sample(t);
      expect(sb.position.toArray()).toEqual(sa.position.toArray());
      expect(sb.quaternion.toArray()).toEqual(sa.quaternion.toArray());
    }
  });
});

describe('the limits (4.6)', () => {
  it('holds the altitude between 4,500 and 41,000 ft and the radius between the bank limit and 60 km', () => {
    const lowHigh = [orbitParams({ altFt: 1000 }), orbitParams({ altFt: 60000 })];
    expect(lowHigh.map((p) => p.altFt)).toEqual([4500, 41000]);
    const tight = orbitParams({ altFt: 35000, radiusKm: 2 });
    expect(tight.radiusKm).toBeCloseTo(minRadiusM(35000 * FT) / 1000, 9);
    expect(orbitParams({ radiusKm: 500 }).radiusKm).toBe(60);
    const t = createOrbitTrack({ altFt: 35000, radiusKm: 2, rollIn: false }, { frame });
    expect(t.bankDeg).toBeCloseTo(25, 6);
  });

  it('flies the presets: Overhead 35,000 ft, The valley 12,000 ft, The Strip 6,500 ft', () => {
    expect(Object.values(PRESETS).map((p) => p.altFt)).toEqual([35000, 12000, 6500]);
    for (const pr of Object.values(PRESETS)) {
      const t = createOrbitTrack({ altFt: pr.altFt, radiusKm: pr.radiusKm }, { frame });
      expect(t.bankDeg).toBeLessThanOrEqual(25);
      expect(t.overLimit).toBe(false);
    }
  });
});

describe('lights and the cabin light for the height and the hour (7.8, 7.3)', () => {
  const at = (altFt, sunAltDeg) => createOrbitTrack({ altFt, radiusKm: 12, rollIn: false, sunAltDeg }, { frame }).sample(10);

  it('has the position lights, beacon and strobes on always in flight', () => {
    for (const st of [at(35000, 40), at(6000, -20)]) for (const b of [LIGHT.NAV, LIGHT.BEACON, LIGHT.STROBE]) expect(st.lights & b).toBe(b);
  });

  it('has the landing lights on below 10,000 ft only, day or night, and no taxi or turn-off lights (gear up)', () => {
    expect(at(9000, 40).lights & LIGHT.LANDING).toBe(LIGHT.LANDING);
    expect(at(12000, -20).lights & LIGHT.LANDING).toBe(0);
    expect(at(6000, -20).lights & (LIGHT.TAXI | LIGHT.TURNOFF)).toBe(0);
  });

  it('has the wing and logo lights on at night below 10,000 ft, and the cabin dimmed when the Sun is 6 degrees down', () => {
    expect(at(6000, -1).lights & (LIGHT.WING | LIGHT.LOGO)).toBe(LIGHT.WING | LIGHT.LOGO);
    expect(at(6000, 10).lights & (LIGHT.WING | LIGHT.LOGO)).toBe(0);
    expect(at(6000, -3).cabinLight).toBe(1);
    expect(at(6000, -7).cabinLight).toBe(0.3);
    expect(at(12000, -20).cabinLight).toBe(1);
  });

  it('can be set again for the Sun now, since scrubbing the hour leaves the track as it is (7.12)', () => {
    const st = at(6000, 40);
    applySun(st, -10);
    expect(st.lights & LIGHT.WING).toBe(LIGHT.WING);
    expect(st.cabinLight).toBe(0.3);
  });
});

// Plan 03, section 4.10: the orbit's state in the address bar, and a link that reproduces the same orbit at the same
// moment. ?city=lv&mode=flight&orbit=1&alt=12000&r=9&phase=140&seat=22F&t=2026-11-14T01:07:30Z
import { describe, it, expect } from 'vitest';
import { decodeOrbitState, encodeOrbitState, clearOrbitState, orbitLinkState, orbitInput, ORBIT_KEYS } from '../../../src/flight/orbitUrl.js';
import { decodeFlightState } from '../../../src/flight/url.js';
import { createOrbitTrack, changeOrbit } from '../../../src/flight/orbit.js';
import { createFrame } from '../../../src/world/frame.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);
const DEG = Math.PI / 180;
const strip = { x: 316, n: 415 };

describe('decodeOrbitState', () => {
  it('reads the example link of section 4.10', () => {
    const s = decodeOrbitState('?city=lv&mode=flight&orbit=1&alt=12000&r=9&phase=140&seat=22F&t=2026-11-14T01:07:30Z');
    expect(s).toMatchObject({ orbit: true, altFt: 12000, radiusKm: 9, phaseDeg: 140, seat: '22F', t: Date.parse('2026-11-14T01:07:30Z') });
    for (const k of ['center', 'on', 'outward', 'iasKt', 'yaw', 'pitch', 'lens', 'frame']) expect(s[k], k).toBeUndefined();
  });

  it('says orbit: false without orbit=1 or outside mode=flight', () => {
    expect(decodeOrbitState('?mode=flight&flight=lv-19-day&at=10').orbit).toBe(false);
    expect(decodeOrbitState('?mode=drive&orbit=1').orbit).toBe(false);
    expect(decodeOrbitState('?mode=flight&orbit=0').orbit).toBe(false);
  });

  it('reads the centre, a building to circle, the outward switch, a speed and the look', () => {
    const s = decodeOrbitState('?mode=flight&orbit=1&c=-3000,2500&on=w27858550&out=1&ias=250&yaw=-10&pitch=-8&lens=26&frame=0');
    expect(s.center).toEqual({ x: -3000, n: 2500 });
    expect(s.on).toBe('w27858550');
    expect(s.outward).toBe(true);
    expect(s.iasKt).toBe(250);
    expect([s.yaw, s.pitch, s.lens, s.frame]).toEqual([-10, -8, 26, false]);
  });

  it('drops malformed values instead of guessing', () => {
    const s = decodeOrbitState('?mode=flight&orbit=1&alt=high&r=-2&phase=x&c=1,2,3&on=../x&out=maybe&ias=0&seat=99Z&t=yesterday');
    for (const k of ['altFt', 'radiusKm', 'phaseDeg', 'center', 'on', 'outward', 'iasKt', 'seat', 't']) expect(s[k], k).toBeUndefined();
  });
});

describe('encodeOrbitState', () => {
  it('writes mode=flight, orbit=1 and the orbit keys, keeping other parameters and dropping the recorded flight\'s', () => {
    const p = encodeOrbitState({ altFt: 12000, radiusKm: 9, phaseDeg: 140, seat: '22F', t: Date.parse('2026-11-14T01:07:30Z') },
      '?city=lv&renderer=webgpu&mode=flight&flight=lv-19-day&at=300&route=i15n');
    expect(p.toString()).toBe('city=lv&renderer=webgpu&mode=flight&orbit=1&alt=12000&r=9&phase=140&seat=22F&t=2026-11-14T01%3A07%3A30Z');
  });

  it('writes the centre only when one is given, a building id beside it, and the outward switch only when on', () => {
    const p = encodeOrbitState({ altFt: 6500, radiusKm: 5.25, phaseDeg: 12.345, center: { x: -3000.4, n: 2500.6 }, on: 'w1', outward: true, iasKt: 250 });
    expect(p.get('c')).toBe('-3000,2501');
    expect(p.get('on')).toBe('w1');
    expect(p.get('out')).toBe('1');
    expect(p.get('ias')).toBe('250');
    expect(p.get('r')).toBe('5.25');
    expect(p.get('phase')).toBe('12.35');
    expect(encodeOrbitState({ altFt: 6500 }).has('out')).toBe(false);
  });

  it('round-trips through decode', () => {
    const s = { altFt: 18000, radiusKm: 14.5, phaseDeg: 271.25, seat: '9A', center: { x: 1200, n: -800 }, outward: true, yaw: 5, pitch: -3, lens: 35, frame: false };
    expect(decodeOrbitState(encodeOrbitState(s))).toMatchObject(s);
  });

  it('is cleared without touching another mode\'s address, and the recorded flight\'s decoder ignores it', () => {
    const p = clearOrbitState('?city=lv&mode=flight&orbit=1&alt=12000&r=9&phase=140&seat=22F');
    expect(p.toString()).toBe('city=lv&mode=flight&seat=22F');
    expect(clearOrbitState('?mode=drive&route=i15n&r=3').toString()).toBe('mode=drive&route=i15n&r=3');
    expect(ORBIT_KEYS).toContain('orbit');
    expect(decodeFlightState('?mode=flight&orbit=1&alt=12000').id).toBeUndefined();
  });
});

describe('a link reproduces the same orbit at the same moment', () => {
  it('from a steady circle: the decoded orbit starts where and as the aircraft was', () => {
    const track = createOrbitTrack({ center: strip, altFt: 12000, radiusKm: 9, phaseDeg: 140, seat: '22F' }, { frame });
    for (const t of [track.joinT + 1.3, track.joinT + 600, track.durationS - 5]) {
      const link = encodeOrbitState(orbitLinkState(track, t, { seat: '22F', defaultCenter: strip }), '?city=lv');
      const again = createOrbitTrack(orbitInput(decodeOrbitState(link), { center: strip }), { frame });
      const a = track.sample(t), b = again.sample(0);
      // the phase is written to 0.01 degree: 1.6 m at 9 km
      expect(b.position.distanceTo(a.position)).toBeLessThan(2);
      expect(Math.abs(b.heading - a.heading) / DEG).toBeLessThan(0.02);
      expect(Math.abs(b.roll - a.roll) / DEG).toBeLessThan(1e-6);
      expect(b.altMsl).toBeCloseTo(a.altMsl, 6);
    }
  });

  it('keeps the side looked to, the centre and the speed of a changed orbit', () => {
    const base = createOrbitTrack({ center: strip, altFt: 12000, radiusKm: 9, seat: '22F', rollIn: false }, { frame });
    const changed = changeOrbit(base, 50, { outward: true, center: { x: 2000, n: -1000 }, iasKt: 250 }).track;
    const t = changed.joinT + 90;
    const s = orbitLinkState(changed, t, { seat: '22F' });
    expect(s.outward).toBe(true);
    const again = createOrbitTrack(orbitInput(decodeOrbitState(encodeOrbitState(s))), { frame });
    expect(again.orbit.direction).toBe('ccw');
    expect(again.sample(0).position.distanceTo(changed.sample(t).position)).toBeLessThan(3);
    expect(again.sample(0).tas).toBeCloseTo(changed.sample(t).tas, 6);
  });

  it('starts the decoded orbit on its circle, not with a roll-in', () => {
    const input = orbitInput(decodeOrbitState('?mode=flight&orbit=1&alt=12000&r=9&phase=140&seat=22F'));
    expect(input.rollIn).toBe(false);
    expect(createOrbitTrack(input, { frame }).phaseAt(0)).toBeCloseTo(140, 6);
  });
});

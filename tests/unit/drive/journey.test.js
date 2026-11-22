import { describe, it, expect } from 'vitest';
import { createJourney, createSpeedProfile, MPH, ACCEL } from '../../../src/drive/journey.js';
import { createRefline } from '../../../src/drive/roadnet/refline.js';
import { curveDrop } from '../../../src/world/frame.js';
import { fixture } from './helpers.js';

const { route, road, frame } = fixture();
const ROUTE = route('test');
const ROAD = road('test.main');
const DEPART = Date.parse('2026-11-21T23:00:00Z');
const make = (extra = {}) => createJourney({ route: ROUTE, road: ROAD, frame, departMs: DEPART, ...extra });

/** Map lateral offset (positive left) of a scene position from the reference line at s. */
function offsetOf(s, position) {
  const r = createRefline(ROAD).at(s);
  return (position.x - r.x) * -Math.sin(r.heading) + (-position.z - r.y) * Math.cos(r.heading);
}

describe('journey timing', () => {
  const j = make();

  it('starts at the route start at departMs and has the route fields', () => {
    expect(j.id).toBe('test');
    expect(make({ city: 'lv' }).id).toBe('lv/test');
    expect(j.length).toBe(2800);
    expect(j.sAt(DEPART)).toBeCloseTo(100, 9);
    expect(j.departMs).toBe(DEPART);
    expect(j.markers.map((m) => m.s)).toEqual([800, 1500, 2000]);
    expect(j.reveal.s).toBe(2000);
  });

  it('advances 31.29 m/s at 70 mph', () => {
    const v = (j.sAt(DEPART + 60000) - j.sAt(DEPART + 10000)) / 50;
    expect(Math.abs(v - 31.29) / 31.29).toBeLessThan(0.01);
    expect(j.speedAt(1000)).toBeCloseTo(70 * MPH, 9);
  });

  it('is monotonic and invertible to 1 mm', () => {
    let last = -Infinity;
    for (let t = DEPART; t <= j.timeAt(2900); t += 137) {
      const s = j.sAt(t);
      expect(s).toBeGreaterThan(last);
      last = s;
    }
    for (let s = 100; s <= 2900; s += 7.3) expect(Math.abs(j.sAt(j.timeAt(s)) - s)).toBeLessThan(1e-3);
  });

  it('gives identical poses for identical times, whatever came before', () => {
    const times = [DEPART + 70000, DEPART + 20000, DEPART + 50000];
    const forward = times.map((t) => j.poseAt(t));
    j.poseAt(DEPART + 90000); // scrub away and back
    const back = [...times].reverse().map((t) => j.poseAt(t)).reverse();
    expect(back).toEqual(forward);
  });

  it('rebases so that s falls at the given time', () => {
    const k = make();
    const later = DEPART + 3 * 3600000;
    k.rebase(1700, later);
    expect(k.sAt(later)).toBeCloseTo(1700, 4); // epoch ms resolve about 7 micrometres here
    expect(k.timeAt(1700)).toBeCloseTo(later, 3);
  });

  it('honours startS', () => {
    const k = make({ startS: 1700 });
    expect(k.sAt(DEPART)).toBeCloseTo(1700, 6);
    expect(k.timeAt(100)).toBeLessThan(DEPART);
  });

  it('holds at the ends', () => {
    const end = j.poseAt(j.timeAt(2900) + 600000);
    expect(end.s).toBe(2900);
    expect(end.speed).toBe(0);
    const before = j.poseAt(DEPART - 600000);
    expect(before.s).toBe(100);
    expect(before.speed).toBe(0);
    expect(j.poseAt(DEPART + 1000).speed).toBeCloseTo(70 * MPH, 6);
  });
});

describe('speed profile', () => {
  const zoned = { ...ROAD, speed: [{ s0: 0, mph: 70 }, { s0: 1200, mph: 55 }, { s0: 2000, mph: 65 }] };
  const p = createSpeedProfile(zoned, 0, 3000);
  const limit = (s) => (s < 1200 ? 70 : s < 2000 ? 55 : 65) * MPH;

  it('never exceeds the limit, eases with bounded acceleration and continuous speed', () => {
    let lastV = p.speedOf(0);
    for (let s = 0; s <= 3000; s += 0.5) {
      const v = p.speedOf(s);
      expect(v).toBeLessThanOrEqual(limit(s) + 1e-6);
      expect(Math.abs(p.accelOf(s))).toBeLessThanOrEqual(ACCEL + 1e-9);
      expect(Math.abs(v - lastV)).toBeLessThan(0.05);
      lastV = v;
    }
    expect(p.speedOf(1500)).toBeCloseTo(55 * MPH, 9);
    expect(p.speedOf(2800)).toBeCloseTo(65 * MPH, 9);
  });

  it('starts and ends each change with zero acceleration', () => {
    const ch = p.segments.filter((g) => g.v1 !== g.v2);
    expect(ch.length).toBe(2);
    for (const g of ch) {
      expect(Math.abs(p.accelOf(g.sa + 1e-6))).toBeLessThan(1e-3);
      expect(Math.abs(p.accelOf(g.sb - 1e-6))).toBeLessThan(1e-3);
    }
    expect(ch[0].sb).toBeCloseTo(1200, 6); // slow down before the lower limit
    expect(ch[1].sa).toBeCloseTo(2000, 6); // speed up after the higher one
  });

  it('is invertible across changes', () => {
    for (let s = 0; s <= 3000; s += 3.7) expect(Math.abs(p.sOf(p.timeOf(s)) - s)).toBeLessThan(1e-3);
  });

  it('lowers a zone too short for its changes', () => {
    const q = createSpeedProfile({ ...ROAD, speed: [{ s0: 0, mph: 40 }, { s0: 1000, mph: 80 }, { s0: 1100, mph: 40 }] }, 0, 3000);
    for (let s = 0; s <= 3000; s += 1) expect(Math.abs(q.accelOf(s))).toBeLessThanOrEqual(ACCEL + 1e-9);
    expect(q.speedOf(1050)).toBeLessThan(80 * MPH);
    expect(q.speedOf(1050)).toBeGreaterThan(40 * MPH);
    for (let s = 0; s <= 3000; s += 3.7) expect(Math.abs(q.sOf(q.timeOf(s)) - s)).toBeLessThan(1e-3);
  });

  it('falls back to 65 mph when a road has no zones', () => {
    expect(createSpeedProfile({ ...ROAD, speed: [] }, 0, 3000).speedOf(500)).toBeCloseTo(65 * MPH, 9);
  });
});

describe('pose', () => {
  const j = make();

  it('has an orthonormal, right-handed frame', () => {
    for (let s = 100; s <= 2900; s += 50) {
      const { forward: f, up: u, right: r } = j.poseAtS(s);
      for (const v of [f, u, r]) expect(v.length()).toBeCloseTo(1, 9);
      expect(f.dot(u)).toBeCloseTo(0, 9);
      expect(f.dot(r)).toBeCloseTo(0, 9);
      expect(u.dot(r)).toBeCloseTo(0, 9);
      expect(f.clone().cross(u).dot(r)).toBeCloseTo(1, 9);
      expect(u.y).toBeGreaterThan(0.99);
    }
  });

  it('forward includes the grade and up leans with the crossfall', () => {
    const climb = j.poseAtS(1700); // 4% climb, straight after the curve
    expect(climb.grade).toBeCloseTo(0.04, 6);
    expect(climb.forward.y).toBeCloseTo(0.04 / Math.hypot(1, 0.04), 2);
    const banked = j.poseAtS(1200); // -3% crossfall: right edge higher, so up leans left
    expect(banked.crossfall).toBeCloseTo(-0.03, 6);
    expect(banked.up.dot(banked.right)).toBeCloseTo(0, 9);
    const leftScene = banked.right.clone().negate();
    expect(leftScene.y).toBeLessThan(0); // the left edge is lower
  });

  it('puts the car on the road surface, curvature drop included', () => {
    const rl = createRefline(ROAD);
    for (const s of [150, 900, 1200, 1650, 2300, 2900]) {
      const p = j.poseAtS(s);
      const r = rl.at(s);
      const d = offsetOf(s, p.position);
      const x = p.position.x, y = -p.position.z;
      expect(p.position.y).toBeCloseTo(r.h + r.crossfall * d - frame.base - curveDrop(x, y), 6);
      expect(curveDrop(x, y)).toBeGreaterThan(100); // 55 km out: the drop matters
    }
  });

  it('drives the centre of its lane and eases across a lane-count change', () => {
    // lane 2 of 3 (centred) is the reference line; lane 2 of 4 is 1.83 m to its left
    expect(offsetOf(1400, j.poseAtS(1400).position)).toBeCloseTo(0, 6);
    expect(offsetOf(1800, j.poseAtS(1800).position)).toBeCloseTo(1.83, 6);
    expect(j.poseAtS(1400).lane).toBe(2);
    expect(j.poseAtS(1400).lateral).toBeCloseTo(0, 6);
    const mid = j.poseAtS(1600);
    expect(offsetOf(1600, mid.position)).toBeCloseTo(0.915, 3);
    expect(mid.lateral).toBeCloseTo(0.915 - 1.83, 3);
    // continuous, gentle, and the same whichever way it is walked
    const up = [], down = [];
    for (let s = 1500; s <= 1700; s += 0.25) up.push(offsetOf(s, j.poseAtS(s).position));
    for (let s = 1700; s >= 1500; s -= 0.25) down.push(offsetOf(s, j.poseAtS(s).position));
    expect(down.reverse()).toEqual(up);
    for (let i = 1; i < up.length; i++) expect(Math.abs(up[i] - up[i - 1])).toBeLessThan(0.01);
    // spread over about 4 s of travel
    expect(offsetOf(1600 - 0.5 * 4 * 31.29 - 1, j.poseAtS(1600 - 63.6).position)).toBeCloseTo(0, 6);
    expect(offsetOf(1664, j.poseAtS(1664).position)).toBeCloseTo(1.83, 6);
  });

  it('clamps the lane to the lane count', () => {
    const south = createJourney({ route: route('south'), road: road('test.south'), frame, departMs: DEPART });
    const p = south.poseAtS(600);
    expect(p.lane).toBe(2);
  });
});

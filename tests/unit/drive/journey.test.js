import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';
import { laneCentreAt, tapersOf } from '../../../src/drive/roadnet/crosssection.js';
import { parseRoutes } from '../../../src/drive/routes.js';
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
    // the route starts in a live lane: at speed at s0, not standing
    const before = j.poseAt(DEPART - 600000);
    expect(before.s).toBe(100);
    expect(before.speed).toBeCloseTo(70 * MPH, 9);
    expect(j.poseAt(DEPART).speed).toBeCloseTo(70 * MPH, 9);
    for (const t of [DEPART + 2 * 3600000 + 0.3, DEPART + 7 * 3600000 + 0.7]) {
      const k = make();
      k.rebase(100, t);
      expect(k.poseAt(k.timeAt(100)).speed).toBeCloseTo(70 * MPH, 9); // whatever the rounding of the start chip
    }
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

  it('drives the centre of its lane through tapers, the lane keeping its identity', () => {
    // lane 2 (the middle of three) is the reference line; lane 4 opens on the right over 1600..1856.2
    // and lane 1 closes on the left over 2143.8..2400, and neither moves lane 2
    for (const s of [150, 1400, 1600, 1700, 1800, 2200, 2300, 2600, 2900]) {
      expect(offsetOf(s, j.poseAtS(s).position)).toBeCloseTo(0, 6);
      expect(j.poseAtS(s).lateral).toBeCloseTo(0, 6);
      expect(j.poseAtS(s).laneId).toBe(2);
    }
    expect(j.poseAtS(1400).lane).toBe(2);
    expect(j.poseAtS(2600).lane).toBe(1); // lane 1 has gone: lane 2 is now the leftmost
    expect(j.lanePlan).toEqual([{ s0: 100, s1: 100, lane: 2 }]);
  });

  describe('a planned lane change', () => {
    const v = 70 * MPH;
    const T = 4.72; // what the pipeline uses for a 3.66 m change: 4 s would peak at 1.32 m/s^2
    const s1 = 1840; // lane 1 starts to close at 2143.8: out of it 300 m before
    const plan = [{ s0: 100, lane: 1 }, { s0: s1 - T * v, s1, lane: 2 }];
    const k = createJourney({ route: { ...ROUTE, lane: 1, lanePlan: plan }, road: ROAD, frame, departMs: DEPART });
    const step = 0.25;
    const d = (s) => k.offsetAt(s);

    it('starts in lane 1 and ends in lane 2, continuous and the same in both directions', () => {
      expect(d(1000)).toBeCloseTo(3.66, 9);
      expect(d(1900)).toBeCloseTo(0, 9);
      expect(k.poseAtS(1000).lane).toBe(1);
      expect(k.poseAtS(1900).lane).toBe(2);
      const up = [], down = [];
      for (let s = 1600; s <= 1900; s += step) up.push(offsetOf(s, k.poseAtS(s).position));
      for (let s = 1900; s >= 1600; s -= step) down.push(offsetOf(s, k.poseAtS(s).position));
      expect(down.reverse()).toEqual(up);
      for (let i = 1; i < up.length; i++) expect(Math.abs(up[i] - up[i - 1])).toBeLessThan(0.02);
    });

    it('keeps lateral acceleration under 1.0 m/s^2 and jerk under 2.5 m/s^3', () => {
      let aMax = 0, jMax = 0, prevA = null;
      for (let s = 1600; s <= 1900; s += step) {
        const d2 = (d(s + step) - 2 * d(s) + d(s - step)) / (step * step);
        const a = v * v * d2;
        aMax = Math.max(aMax, Math.abs(a));
        if (prevA !== null) jMax = Math.max(jMax, Math.abs((a - prevA) / step) * v);
        prevA = a;
      }
      expect(aMax).toBeGreaterThan(0.8);
      expect(aMax).toBeLessThanOrEqual(1.0);
      expect(jMax).toBeLessThanOrEqual(2.5);
    });

    it('is out of the closing lane 300 m before it starts to close', () => {
      const closes = ROAD.sections[2].taper.s0;
      for (let s = 100; s <= 2900; s += 5) if (k.poseAtS(s).laneId === 1 || s < s1) expect(closes - s >= 300 || s >= s1).toBe(true);
      expect(closes - s1).toBeGreaterThanOrEqual(300);
    });
  });

  it('clamps the lane to the lane count', () => {
    const south = createJourney({ route: route('south'), road: road('test.south'), frame, departMs: DEPART });
    const p = south.poseAtS(600);
    expect(p.lane).toBe(2);
  });
});

describe('the real route', () => {
  const read = (p) => readFileSync(new URL(`../../../public/data/lv/${p}`, import.meta.url));
  const bin = read('roadnet.bin');
  const net = decodeRoadNet(JSON.parse(read('roadnet.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const { routes } = parseRoutes(JSON.parse(read('routes.json')), net);
  const route = routes.find((r) => r.id === 'i15n');
  const road = net.roads.find((r) => r.id === route.road);
  const jr = createJourney({ route, road, frame, departMs: DEPART });

  /** Where each lane stops being full width, if it ends before the road does. */
  function laneEnds() {
    const ends = new Map();
    const secs = road.sections;
    secs.forEach((sec, i) => {
      if (i === secs.length - 1) return;
      const next = new Set(secs[i + 1].lanes.map((l) => l.id));
      for (const l of sec.lanes) {
        if (next.has(l.id)) continue;
        const tp = tapersOf(road).find((x) => x.from <= i && i < x.i);
        ends.set(l.id, tp ? tp.s0 : secs[i + 1].s0);
      }
    });
    return ends;
  }

  it('has a lane plan that starts in route.lane', () => {
    expect(Array.isArray(route.lanePlan)).toBe(true);
    expect(route.lanePlan[0].lane).toBe(route.lane);
    expect(jr.lanePlan[0].lane).toBe(route.lane);
  });

  it('is in a lane, continuously, along the whole route, never one ending within 300 m', () => {
    const ends = laneEnds();
    let prev = jr.offsetAt(route.s0);
    for (let s = route.s0; s <= route.s1; s += 2) {
      const pose = jr.poseAtS(s);
      const d = jr.offsetAt(s);
      expect(Number.isFinite(d)).toBe(true);
      expect(Math.abs(d - prev)).toBeLessThan(0.15); // no jumps: at most 1 m sideways per 20 m, and lane changes
      prev = d;
      expect(laneCentreAt(road, pose.laneId, s)).not.toBeNull();
      const end = ends.get(pose.laneId);
      if (end !== undefined) expect(end - s).toBeGreaterThanOrEqual(300);
    }
  });

  it('keeps lateral acceleration under 1.0 m/s^2 and jerk under 2.5 m/s^3 at the speed there', () => {
    const step = 0.5;
    let aMax = 0, jMax = 0, prevA = null;
    for (let s = route.s0 + step; s < route.s1 - step; s += step) {
      const v = jr.speedAt(s);
      const d0 = jr.offsetAt(s - step), d1 = jr.offsetAt(s), d2 = jr.offsetAt(s + step);
      const a = v * v * (d2 - 2 * d1 + d0) / (step * step) + jr.profile.accelOf(s) * (d2 - d0) / (2 * step);
      aMax = Math.max(aMax, Math.abs(a));
      if (prevA !== null) jMax = Math.max(jMax, Math.abs(a - prevA) / step * v);
      prevA = a;
    }
    console.log(`real route: lateral acceleration up to ${aMax.toFixed(3)} m/s^2, jerk up to ${jMax.toFixed(3)} m/s^3`);
    expect(aMax).toBeLessThanOrEqual(1.0);
    expect(jMax).toBeLessThanOrEqual(2.5);
  });
});

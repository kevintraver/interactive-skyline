// The journeys of the other two routes (plan 02, D9.1, D9.2), each on its own RoadNet, held to the
// same rules as i15n's: monotonic and invertible in time, continuous in position and heading along
// the whole route, and a lane plan the car can follow.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { loadRoutes } from '../../../src/drive/routes.js';
import { laneCentreAt, tapersOf } from '../../../src/drive/roadnet/crosssection.js';
import { createJourney } from '../../../src/drive/journey.js';
import { createFrame } from '../../../src/world/frame.js';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const LV = JSON.parse(readFileSync(new URL('../../../data/cities.json', import.meta.url), 'utf8')).lv;
const frame = createFrame(LV);
const DEPART = Date.parse('2026-11-21T23:00:00Z');
const io = {
  fetchJson: async (n) => JSON.parse(readFileSync(new URL(n, DATA), 'utf8')),
  fetchBinary: async (n) => { const b = readFileSync(new URL(n, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
};
const routesDoc = existsSync(new URL('routes.json', DATA)) ? JSON.parse(readFileSync(new URL('routes.json', DATA), 'utf8')) : { routes: [] };
// plan 02, section 1 and 8.2: length, and the reveal (within 1.5 km on the coarse terrain)
const PLAN = { i15s: { length: 45200, reveal: 6800 }, us93: { length: 59500, reveal: 25200 } };
const net = await loadRoutes(io);

/** Where each lane stops being full width, if it ends before the road does. */
function laneEnds(road) {
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

for (const id of Object.keys(PLAN).filter((k) => routesDoc.routes.some((r) => r.id === k))) {
  describe(`route ${id}`, async () => {
    const { route, road } = await net.loadRoute(id);
    const jr = createJourney({ route, road, frame, departMs: DEPART });

    it('has the plan\'s length, its reveal and three starts on the route', () => {
      expect(Math.abs(route.length - PLAN[id].length) / PLAN[id].length).toBeLessThanOrEqual(0.005);
      expect(Math.abs(route.reveal.s - PLAN[id].reveal)).toBeLessThanOrEqual(1500);
      expect(Object.keys(route.starts).sort()).toEqual(['city', 'reveal', 'start']);
      for (const s of Object.values(route.starts)) {
        expect(s).toBeGreaterThanOrEqual(route.s0);
        expect(s).toBeLessThan(route.s1);
      }
      expect(route.starts.reveal).toBeLessThan(route.reveal.s);
      const ss = route.markers.map((m) => m.s);
      expect(ss).toEqual([...ss].sort((a, b) => a - b));
    });

    it('is monotonic and invertible to 1 mm over the whole route', () => {
      let last = -Infinity;
      for (let t = DEPART; t <= jr.timeAt(route.s1); t += 4000) {
        const s = jr.sAt(t);
        expect(s).toBeGreaterThanOrEqual(last);
        if (s < route.s1) expect(s).toBeGreaterThan(last);
        last = s;
      }
      for (let s = route.s0; s <= route.s1; s += 97.3) expect(Math.abs(jr.sAt(jr.timeAt(s)) - s)).toBeLessThan(1e-3);
      expect(jr.duration / 1000).toBeGreaterThan(route.length / (75 * 0.44704));
    });

    it('is continuous in position and heading along the whole route', () => {
      const step = 2;
      let prev = jr.poseAtS(route.s0);
      let worstTurn = 0, worstStep = 0;
      for (let s = route.s0 + step; s <= route.s1; s += step) {
        const p = jr.poseAtS(s);
        for (const k of ['x', 'y', 'z']) expect(Number.isFinite(p.position[k])).toBe(true);
        const d = p.position.distanceTo(prev.position);
        worstStep = Math.max(worstStep, Math.abs(d - step));
        worstTurn = Math.max(worstTurn, p.forward.angleTo(prev.forward));
        prev = p;
      }
      // no jumps (a lane change adds a little sideways), no kinks: under 1.2 degrees per 2 m
      expect(worstStep).toBeLessThan(0.1);
      expect(worstTurn).toBeLessThan(0.021);
    });

    it('is in a lane, continuously, never one ending within 300 m, and in a through lane at the end', () => {
      const ends = laneEnds(road);
      let prev = jr.offsetAt(route.s0);
      for (let s = route.s0; s <= route.s1; s += 2) {
        const pose = jr.poseAtS(s);
        const d = jr.offsetAt(s);
        expect(Number.isFinite(d)).toBe(true);
        expect(Math.abs(d - prev)).toBeLessThan(0.15);
        prev = d;
        expect(laneCentreAt(road, pose.laneId, s)).not.toBeNull();
        const end = ends.get(pose.laneId);
        if (end !== undefined) expect(end - s).toBeGreaterThanOrEqual(300);
      }
      expect(route.lanePlan[0].lane).toBe(route.lane);
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
      expect(aMax).toBeLessThanOrEqual(1.0);
      expect(jMax).toBeLessThanOrEqual(2.5);
    });
  });
}

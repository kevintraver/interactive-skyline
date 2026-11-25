// D6.5 in this build's form (reference.js): the visitor's car as one of the traffic. On all three routes' data,
// through the model (route switching in the app is not wired yet): the car's lane carries the car's speed and
// the lanes beside it the plan's offsets; the car rides an integer slot; its slot is never drawn and the
// vehicles ahead and behind in its lane keep at least 0.8 s; the counts are kept; and all of it is a pure
// function of time across a re-timing of the journey.
import { describe, it, expect } from 'vitest';
import { loadRoute, haveRoutes, ROUTE_IDS } from './routes.js';
import { GAP } from '../../../src/drive/traffic/fleet.js';
import { SMOOTH_M, SEGMENT_EASE_M } from '../../../src/drive/traffic/reference.js';

const TIMES = ['2026-11-21T02:30:00Z', '2026-11-17T11:00:00Z', '2026-11-22T19:00:00Z', '2026-07-11T00:30:00Z', '2026-11-20T23:15:00Z'].map(Date.parse);

/** Is s inside an eased reference change (or the phase bump before one)? */
const nearSwitch = (ref, s, margin = 0) => ref.switches.some((w) => Math.abs(s - w.s) < SMOOTH_M / 2 + margin);

describe.skipIf(!haveRoutes)('the visitor\'s car in traffic (D6.5)', () => {
  for (const id of ROUTE_IDS) {
    describe(id, () => {
      it('never draws the car\'s slot, and keeps the vehicles ahead and behind in its lane at least 0.8 s away, for a sweep of times and places', () => {
        const { journey, traffic, reference, fleet } = loadRoute(id);
        let frames = 0, checked = 0, minAhead = Infinity, minBehind = Infinity;
        for (const t0 of TIMES) {
          for (let s = journey.s0 + 1200; s < journey.s1 - 1200; s += 2900) {
            journey.rebase(s, t0);
            reference.shifts(traffic, journey);
            for (let k = 0; k < 6; k++) {
              const t = t0 + k * 3100;
              const p = journey.poseAt(t);
              const pl = fleet.place(t, p.s - 400, p.s + 400, p);
              const st = fleet.stats();
              frames++;
              expect(st.guard).toBe(0); // free flow: the gap rule never weighs in
              for (let i = 0; i < pl.count; i++) {
                if (pl.dir[i] !== 0 || pl.alpha[i] <= 0.002) continue;
                const ex = pl.pos[3 * i] - p.position.x, ey = pl.pos[3 * i + 1] - p.position.y, ez = pl.pos[3 * i + 2] - p.position.z;
                const lat = ex * p.right.x + ey * p.right.y + ez * p.right.z;
                if (Math.abs(lat) >= GAP.LAT_IN) continue;
                expect(pl.lane[i] === st.refLane && pl.k[i] === st.carSlot).toBe(false);
                const h = (pl.s[i] - p.s) / p.speed;
                if (h > 0) minAhead = Math.min(minAhead, h); else minBehind = Math.min(minBehind, -h);
                checked++;
              }
            }
          }
        }
        expect(frames).toBeGreaterThan(60);
        expect(checked).toBeGreaterThan(50);
        expect(minAhead).toBeGreaterThanOrEqual(0.8);
        expect(minBehind).toBeGreaterThanOrEqual(0.8);
      }, 60000);

      it('runs the car\'s lane at the car\'s speed, lanes to its left faster and to its right slower by the lane offsets', () => {
        const { journey, traffic, reference, data } = loadRoute(id);
        const segs = data.directions.with.segments;
        let n = 0;
        for (let s = journey.s0 + 700; s < journey.s1 - 700; s += 1300) {
          if (nearSwitch(reference, s, 50)) continue;
          const g = segs.find((x) => x.s0 <= s && s < x.s1);
          // the lanes' speed steps at segment boundaries are eased over SEGMENT_EASE_M (not the car's own lane)
          const nearBoundary = segs.some((x) => Math.abs(x.s0 - s) < SEGMENT_EASE_M / 2 + 10);
          const t = journey.timeAt(s);
          const ref = reference.refLaneAt(s);
          const off = (l) => g.laneSpeedOffsetsMps[Math.min(l - 1, g.lanes - 1)];
          const vCar = journey.speedAt(s);
          for (const L of traffic.lanes('with')) {
            if (L.lane > g.lanes || (nearBoundary && L.lane !== ref)) continue;
            const nSlot = traffic.slotAt('with', L.lane, s, t);
            const v = traffic.slotSpeed('with', L.lane, nSlot, t);
            // within 0.2 m/s: the tables' 10 m steps inside the journey's speed changes (1 m/s^2 at most)
            expect(Math.abs(v - (vCar + off(L.lane) - off(ref)))).toBeLessThan(0.2);
            n++;
          }
        }
        expect(n).toBeGreaterThan(40);
      });

      it('puts the car on an integer slot of its lane (away from the eased changes)', () => {
        const { journey, traffic, reference } = loadRoute(id);
        for (const t0 of TIMES) {
          journey.rebase(journey.s0 + 3000, t0);
          reference.shifts(traffic, journey);
          for (let s = journey.s0 + 500; s < journey.s1 - 500; s += 1777) {
            if (nearSwitch(reference, s, 0)) continue;
            const t = journey.timeAt(s);
            const nSlot = traffic.slotAt('with', reference.refLaneAt(s), s, t);
            expect(Math.abs(nSlot - Math.round(nSlot))).toBeLessThan(0.02);
          }
        }
      });

      it('eases a change of reference lane so that traffic never brakes for it', () => {
        const { reference, journey } = loadRoute(id);
        for (const w of reference.switches) {
          if (!w.jump) continue;
          const v = journey.speedAt(w.s);
          let peak = 0;
          for (let s = w.s - SMOOTH_M / 2; s < w.s + SMOOTH_M / 2; s += 2) {
            const dv = (reference.easedJumpAt(s + 1) - reference.easedJumpAt(s - 1)) / 2;
            peak = Math.max(peak, Math.abs(v * dv));
          }
          expect(peak).toBeLessThan(0.4); // m/s^2: the brake lamps' threshold (demand.js accel)
        }
      });

      it('keeps the counted flow: the referenced lanes carry what the file\'s lanes do', () => {
        const { traffic, base, journey } = loadRoute(id);
        for (const t of TIMES) {
          for (let s = journey.s0 + 2000; s < journey.s1 - 2000; s += 6100) {
            const a = traffic.stateAt('with', s, t), b = base.stateAt('with', s, t);
            expect(Math.abs(a.q - b.q) / b.q).toBeLessThan(0.02);
          }
        }
      });

      it('is a pure function of time across a re-timing: the same shifts and vehicles after rebasing away and back', () => {
        const { journey, traffic, reference, fleet } = loadRoute(id);
        const s = journey.s0 + 9000, t = TIMES[0] + 777;
        const snap = () => {
          const sh = reference.shifts(traffic, journey).map((x) => [x.lane, x.shift, x.k]);
          const p = journey.poseAt(t);
          const pl = fleet.place(t, p.s - 300, p.s + 600, p);
          return { sh, ids: Array.from(pl.id.subarray(0, pl.count)), a: Array.from(pl.alpha.subarray(0, pl.count)) };
        };
        journey.rebase(s, t);
        const a = snap();
        journey.rebase(s + 4000, t - 86400e3);
        snap();
        traffic.clear();
        journey.rebase(s, t);
        const b = snap();
        expect(b).toEqual(a);
        expect(a.ids.length).toBeGreaterThan(5);
      });
    });
  }
});

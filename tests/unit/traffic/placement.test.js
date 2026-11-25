// D6.4: the traffic part's placement (lanemap.js, fleet.js) on the real I-15 road and counts: lane centre
// lines on both carriageways and through tapers, the chainage mapping to the opposing carriageway,
// determinism across a seek, the gap kept around the visitor's car, and the count over 1 km.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';
import { createRefline } from '../../../src/drive/roadnet/refline.js';
import { edgesAt, tapersOf } from '../../../src/drive/roadnet/crosssection.js';
import { createTraffic, createVehicleBuffer } from '../../../src/drive/traffic/demand.js';
import { createLaneMap } from '../../../src/drive/traffic/lanemap.js';
import { createFleet, GAP, CAR_LENGTH } from '../../../src/drive/traffic/fleet.js';
import { createFrame, EARTH_R } from '../../../src/world/frame.js';

const root = new URL('../../../', import.meta.url);
const file = (p) => new URL(p, root);
const have = fs.existsSync(file('public/data/lv/traffic/i15n.json')) && fs.existsSync(file('public/data/lv/roadnet.bin'));
const LENGTHS = [4.9, 4.6, 5.89, 5.93, 22.24, 13.72];
const HALF_WIDTH = 1.3; // the widest body's half width, m
const FRI_PEAK = Date.parse('2026-07-11T00:30:00Z'); // Friday 17:30 PDT
const TIMES = [FRI_PEAK, Date.parse('2026-11-20T23:00:00Z'), Date.parse('2026-11-17T11:00:00Z'), Date.parse('2026-07-12T18:00:00Z')];

let road, traffic, laneMap, fleet, frame;
beforeAll(() => {
  if (!have) return;
  const b = fs.readFileSync(file('public/data/lv/roadnet.bin'));
  const net = decodeRoadNet(JSON.parse(fs.readFileSync(file('public/data/lv/roadnet.json'), 'utf8')), b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  road = (id) => net.roads.find((r) => r.id === id);
  traffic = createTraffic(JSON.parse(fs.readFileSync(file('public/data/lv/traffic/i15n.json'), 'utf8')));
  laneMap = createLaneMap({ traffic, roads: { with: road('i15n.main'), against: road('i15s.opp') } });
  frame = createFrame(JSON.parse(fs.readFileSync(file('data/cities.json'), 'utf8')).lv);
  fleet = createFleet({ traffic, laneMap, frame, lengths: LENGTHS, earthR: EARTH_R });
});

/** The visitor's car on lane `id` (RoadNet lane id) of i15n.main at s, as the journey's pose has it. */
function carAt(s, laneNumber) {
  const r = road('i15n.main');
  const ref = createRefline(r);
  const lanes = edgesAt(r, s).strips.filter((x) => x.kind === 'lane');
  const st = lanes[Math.min(laneNumber, lanes.length) - 1];
  const d = (st.left + st.right) / 2;
  const p = ref.at(s, {});
  const x = p.x - Math.sin(p.heading) * d, y = p.y + Math.cos(p.heading) * d;
  const position = { x, y: frame.sceneY(p.h + p.crossfall * d, x, y), z: -y };
  const forward = { x: Math.cos(p.heading), y: p.grade, z: -Math.sin(p.heading) };
  const fl = Math.hypot(forward.x, forward.y, forward.z);
  forward.x /= fl; forward.y /= fl; forward.z /= fl;
  const right = { x: Math.sin(p.heading), y: 0, z: Math.cos(p.heading) };
  return { s, position, forward, right, lane: laneNumber, d };
}

describe.skipIf(!have)('lane map', () => {
  it('maps the route to the opposing carriageway monotonically, each sample at the nearest point within a metre', () => {
    const a = laneMap.dirs.against;
    const s = a.sRoad;
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeLessThanOrEqual(s[i - 1]);
    const ra = createRefline(road('i15n.main')), rb = createRefline(road('i15s.opp'));
    const opp = road('i15s.opp');
    const p = {}, q = {};
    for (let i = 0; i < s.length; i += 97) {
      ra.at(laneMap.S0 + i * laneMap.step, p);
      rb.at(s[i], q);
      const mapped = Math.hypot(p.x - q.x, p.y - q.y);
      // brute force over the stations near the mapped one, finely
      let best = Infinity;
      for (let t = Math.max(0, s[i] - 400); t <= Math.min(rb.length, s[i] + 400); t += 0.5) {
        rb.at(t, q);
        best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
      }
      expect(mapped - best).toBeLessThan(1);
      void opp;
    }
    expect(laneMap.chainStats().held).toBe(0);
  });

  for (const dir of ['with', 'against']) {
    it(`${dir}: a vehicle in lane i sits on that lane, between its edges, wholly on the lanes (never a shoulder), through every taper`, () => {
      const d = laneMap.dirs[dir];
      const r = d.road;
      const out = {};
      let checked = 0, inTaper = 0;
      const segs = traffic.segments(dir);
      for (let s = laneMap.S0 + 2; s < laneMap.S1 - 2; s += 7) {
        const g = segs.find((x) => x.s0 <= s && s < x.s1);
        for (let lane = 1; lane <= g.lanes; lane++) {
          laneMap.at(dir, lane, s, out);
          if (out.w <= 0.01) continue; // not shown here
          const cs = edgesAt(r, out.sRoad);
          const lanes = cs.strips.filter((x) => x.kind === 'lane');
          const left = lanes[0].left, right = lanes[lanes.length - 1].right;
          // the body is on the pavement's lanes: never over an edge line onto a shoulder
          expect(out.d + HALF_WIDTH).toBeLessThanOrEqual(left + 0.15);
          expect(out.d - HALF_WIDTH).toBeGreaterThanOrEqual(right - 0.15);
          // and, outside the blend where a stream changes lane, between one lane's edges
          const own = lanes.find((x) => x.left - x.right > 2.5 && out.d <= x.left + 0.05 && out.d >= x.right - 0.05);
          const steady = Math.abs(out.dds) < 0.004;
          if (steady) {
            expect(own, `${dir} lane ${lane} at s ${s.toFixed(0)}: ${out.d.toFixed(2)} in [${lanes.map((x) => `${x.left.toFixed(2)}..${x.right.toFixed(2)}`).join(' ')}]`).toBeTruthy();
            if (own) expect(Math.abs(out.d - (own.left + own.right) / 2)).toBeLessThan(0.35);
          }
          if (cs.taper) inTaper++;
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(10000);
      expect(inTaper).toBeGreaterThan(100);
      expect(tapersOf(r).length).toBeGreaterThan(10);
    });
  }

  it('keeps lanes apart: two lanes of one direction are never closer than 2.9 m (the widest bodies, 2.59 m, side by side never touch)', () => {
    const a = {}, b = {};
    for (const dir of ['with', 'against']) {
      const segs = traffic.segments(dir);
      for (let s = laneMap.S0 + 2; s < laneMap.S1 - 2; s += 3) {
        const g = segs.find((x) => x.s0 <= s && s < x.s1);
        for (let l = 1; l < g.lanes; l++) {
          laneMap.at(dir, l, s, a); laneMap.at(dir, l + 1, s, b);
          if (a.w > 0.01 && b.w > 0.01) expect(a.d - b.d).toBeGreaterThan(2.9);
        }
      }
    }
  });
});

const snapshot = (p) => Array.from({ length: p.count }, (_, i) => [p.id[i], +p.pos[3 * i].toFixed(4), +p.pos[3 * i + 1].toFixed(4), +p.pos[3 * i + 2].toFixed(4), +p.fwd[3 * i].toFixed(5), +p.alpha[i].toFixed(5)]);

describe.skipIf(!have)('fleet', () => {
  it('places every vehicle on its carriageway facing its direction of travel, wheels on the pavement', () => {
    const p = fleet.place(FRI_PEAK, 58000, 61000, null);
    expect(p.count).toBeGreaterThan(200);
    const refW = createRefline(road('i15n.main')), refA = createRefline(road('i15s.opp'));
    const q = {};
    for (let i = 0; i < p.count; i++) {
      const ref = p.dir[i] === 0 ? refW : refA;
      ref.at(p.sRoad[i], q);
      // facing: forward along the road's heading (both roads are driven along their own +s)
      const fx = p.fwd[3 * i], fz = -p.fwd[3 * i + 2];
      expect(fx * Math.cos(q.heading) + fz * Math.sin(q.heading)).toBeGreaterThan(0.99);
      // on the surface: height of the pavement at that offset
      const x = p.pos[3 * i], y = -p.pos[3 * i + 2];
      const h = frame.sceneY(q.h + q.crossfall * p.d[i], x, y);
      expect(Math.abs(p.pos[3 * i + 1] - h)).toBeLessThan(0.01);
      // up is nearly vertical, tilted by grade and crossfall only
      expect(p.up[3 * i + 1]).toBeGreaterThan(0.99);
    }
    // the two directions are on different carriageways: oncoming vehicles are left of the route's line
    for (let i = 0; i < p.count; i++) {
      if (p.dir[i] !== 1) continue;
      refW.at(p.s[i], q);
      const x = p.pos[3 * i], y = -p.pos[3 * i + 2];
      const lateral = -(x - q.x) * Math.sin(q.heading) + (y - q.y) * Math.cos(q.heading);
      expect(lateral).toBeGreaterThan(3);
    }
  });

  it('is a pure function of time: the same instances after a seek away and back', () => {
    const t = FRI_PEAK + 1234;
    const a = snapshot(fleet.place(t, 59000, 61000, carAt(60000, 3)));
    fleet.place(t + 3 * 86400e3, 59000, 61000, carAt(60000, 3));
    fleet.place(t - 40 * 86400e3, 20000, 22000, carAt(21000, 2));
    traffic.clear();
    const b = snapshot(fleet.place(t, 59000, 61000, carAt(60000, 3)));
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(100);
  });

  it('keeps the gap around the visitor\'s car: no vehicle in its path within the window, for a sweep of times and places', () => {
    let near = 0;
    for (const t0 of TIMES) {
      for (const [s, laneNo] of [[12000, 2], [30000, 1], [46000, 2], [52000, 3], [58000, 3], [60000, 3], [64000, 4]]) {
        for (let k = 0; k < 12; k++) {
          const t = t0 + k * 7300, ss = s + k * 61;
          const car = carAt(ss, laneNo);
          const p = fleet.place(t, ss - 500, ss + 500, car);
          for (let i = 0; i < p.count; i++) {
            if (p.dir[i] !== 0) continue;
            const ex = p.pos[3 * i] - car.position.x, ey = p.pos[3 * i + 1] - car.position.y, ez = p.pos[3 * i + 2] - car.position.z;
            const lat = ex * car.right.x + ey * car.right.y + ez * car.right.z;
            const lon = ex * car.forward.x + ey * car.forward.y + ez * car.forward.z;
            if (Math.abs(lat) >= GAP.LAT_IN) continue;
            const gap = Math.abs(lon) - 0.5 * (LENGTHS[p.body[i]] + CAR_LENGTH);
            // nothing ever overlaps, and nothing inside the window is drawn
            expect(gap).toBeGreaterThan(GAP.HARD_M);
            if (lon > 0) expect(gap).toBeGreaterThan(GAP.AHEAD_M);
            else expect(gap).toBeGreaterThan(GAP.BEHIND_M);
            if (gap < GAP.AHEAD_M + GAP.BAND_M) near++;
          }
        }
      }
    }
    void near;
  });

  it('dissolves rather than pops: a vehicle\'s opacity changes by little between frames 1/60 s apart', () => {
    const car0 = 60000;
    let prev = null, maxStep = 0, pairs = 0;
    for (let f = 0; f < 600; f++) {
      const t = FRI_PEAK + f * (1000 / 60);
      const s = car0 + f * (29 / 60);
      const p = fleet.place(t, s - 800, s + 800, carAt(s, 3));
      const cur = new Map();
      for (let i = 0; i < p.count; i++) cur.set(p.id[i], { a: p.alpha[i], ds: Math.abs(p.s[i] - s) });
      if (prev) {
        for (const [id, v] of cur) {
          if (v.ds > 700) continue; // the range's own end (the renderer dissolves over its last 150 m)
          const before = prev.get(id);
          const a0 = before ? before.a : 0;
          if (!before && v.ds > 650) continue;
          maxStep = Math.max(maxStep, Math.abs(v.a - a0));
          pairs++;
        }
        for (const [id, v] of prev) if (!cur.has(id) && v.ds < 650) maxStep = Math.max(maxStep, v.a);
      }
      prev = cur;
    }
    expect(pairs).toBeGreaterThan(10000);
    expect(maxStep).toBeLessThan(0.2);
  });

  it('places as many vehicles over 1 km as the model has there, within one (D6.4)', () => {
    const buf = createVehicleBuffer();
    for (const t of TIMES) {
      for (const s of [15000, 45000, 55000, 60000, 66000]) {
        for (const dir of [0, 1]) {
          const p = fleet.place(t, s, s + 1000, null);
          let shown = 0;
          for (let i = 0; i < p.count; i++) if (p.dir[i] === dir && p.s[i] >= s && p.s[i] <= s + 1000) shown += p.alpha[i];
          traffic.vehiclesIn(dir === 0 ? 'with' : 'against', s, s + 1000, t, buf);
          let model = 0;
          for (let i = 0; i < buf.count; i++) model += buf.fade[i];
          // whole vehicles: the count the model gives; faded ones (joining or leaving at a ramp) count by their opacity
          expect(Math.abs(shown - model)).toBeLessThanOrEqual(1);
          // and against the density surface: the integral of k over the kilometre
          let k = 0;
          for (let x = s + 5; x < s + 1000; x += 10) k += traffic.stateAt(dir === 0 ? 'with' : 'against', x, t).k * 10;
          expect(Math.abs(buf.count - k)).toBeLessThan(Math.max(5, 0.1 * k));
        }
      }
    }
  });
});

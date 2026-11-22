// D6.2: the cumulative-count surface N(s, t) and the vehicles on it (plan 02, sections 5.8, 7.10).
import { describe, it, expect } from 'vitest';
import { createTraffic, createVehicleBuffer, BODIES } from '../../../src/drive/traffic/demand.js';
import { hourOfWeek } from '../../../src/drive/traffic/flow.js';
import { rampsFile, bottleneckFile, BOTTLENECK, at, TZ } from './fixtures.js';

const HOUR = 3600e3;
const ramps = rampsFile();
const trR = createTraffic(ramps);
const bfile = bottleneckFile();
const trB = createTraffic(bfile);
/** Tuesday 8 July 2025, 08:00 PDT: inside the constant 5000/h block of the bottleneck file. */
const T8 = at('2025-07-08T15:00:00Z');

/** Table value for UTC hour starting at ms, straight from the file (an independent index). */
function tableAt(seg, ms) {
  const local = new Date(ms + 30 * 60e3 - (new Date(ms).toLocaleString('en-US', { timeZone: TZ, timeZoneName: 'short' }).includes('PDT') ? 7 : 8) * HOUR);
  return seg.flow[ramps.seasonOfMonth[local.getUTCMonth()]][hourOfWeek(ms + 30 * 60e3, TZ)];
}

/** Snapshot of vehiclesIn as plain arrays. */
function snap(tr, dir, sA, sB, ms) {
  const b = tr.vehiclesIn(dir, sA, sB, ms, createVehicleBuffer(8));
  const out = [];
  for (let i = 0; i < b.count; i++) out.push({ id: b.id[i], k: b.k[i], s: b.s[i], v: b.speed[i], lane: b.lane[i], body: b.body[i], colour: b.colour[i], truck: b.truck[i], accel: b.accel[i] });
  return out;
}

describe('flow through a station equals the input', () => {
  // night, peak, both daylight-saving changes, the week wrap (Sunday 23:00 -> Monday 00:00 PDT)
  const hours = ['2025-07-08T10:00:00Z', '2025-07-11T22:00:00Z', '2025-07-08T15:00:00Z', '2025-03-09T09:00:00Z', '2025-03-09T10:00:00Z',
    '2025-11-02T08:00:00Z', '2025-11-02T09:00:00Z', '2025-07-14T06:00:00Z', '2025-07-14T07:00:00Z', '2025-01-15T19:00:00Z'];
  for (const dir of ['with', 'against']) {
    // Below about 400 an hour 2% is under the whole-vehicle floor: each lane's count over an hour can be
    // off by one at the hour's ends and by one or two more from the presence sequence's unevenness, so
    // at night the bound is two vehicles per lane (measured: RMS 2-4 vehicles an hour per carriageway).
    it(`${dir}: every segment middle, every hour, within 2% (at night within two vehicles per lane)`, () => {
      let worst = 0;
      for (const iso of hours) {
        const ms = at(iso);
        for (const seg of ramps.directions[dir].segments) {
          const n = trR.crossings(dir, (seg.s0 + seg.s1) / 2, ms, ms + HOUR);
          const q = tableAt(seg, ms);
          const tol = q >= 400 ? 0.02 * q : 2 * seg.lanes;
          expect(Math.abs(n - q), `${dir} ${iso} s=${(seg.s0 + seg.s1) / 2}: ${n} vs ${q.toFixed(1)}`).toBeLessThanOrEqual(tol);
          if (q >= 400) worst = Math.max(worst, Math.abs(n - q) / q);
        }
      }
      expect(worst).toBeLessThan(0.02);
    });
  }
  it('the continuous state carries the input flow (within 1%) at a segment middle', () => {
    for (const iso of ['2025-07-11T22:20:00Z', '2025-07-08T10:40:00Z']) {
      for (const seg of ramps.directions.with.segments) {
        const s = (seg.s0 + seg.s1) / 2;
        const st = trR.stateAt('with', s, at(iso));
        expect(st.vph / trR.demandAt('with', s, at(iso))).toBeCloseTo(1, 2);
      }
    }
  });
});

describe('density times speed is flow', () => {
  it('by construction, everywhere, free and queued, both directions (1e-9)', () => {
    for (const [tr, f] of [[trR, ramps], [trB, bfile]]) {
      for (const dir of ['with', 'against']) {
        for (let i = 0; i < 200; i++) {
          const s = f.range[0] + ((i * 7919) % 1000) / 1000 * (f.range[1] - f.range[0]);
          const st = tr.stateAt(dir, s, T8 + ((i * 104729) % 360) * 60e3);
          expect(Math.abs(st.k * st.v - st.q)).toBeLessThanOrEqual(1e-9 * Math.max(1, st.q));
          for (const l of st.lanes) expect(Math.abs(l.k * l.v - l.q)).toBeLessThanOrEqual(1e-9 * Math.max(1, l.q));
        }
      }
    }
  });
  it('and the state agrees with the vehicles drawn: density from a count over 2 km, within 5%', () => {
    for (const ms of [at('2025-07-11T22:10:00Z'), at('2025-07-11T23:40:00Z')]) {
      let count = 0, dens = 0;
      for (let i = 0; i < 20; i++) {
        const t = ms + i * 30e3;
        count += snap(trR, 'with', 13000, 15000, t).length;
        for (let s = 13050; s < 15000; s += 100) dens += trR.stateAt('with', s, t).k * 100;
      }
      expect(count / dens).toBeCloseTo(1, 1);
      expect(Math.abs(count / dens - 1)).toBeLessThan(0.05);
    }
  });
});

describe('headway', () => {
  const minHeadway = (tr, dir, s, ms0, ms1) => {
    const times = {};
    tr.crossings(dir, s, ms0, ms1, (id, lane, k, tc) => (times[lane] ||= []).push(tc));
    let min = Infinity;
    for (const l in times) { const a = times[l].sort((p, q) => p - q); for (let i = 1; i < a.length; i++) min = Math.min(min, (a[i] - a[i - 1]) / 1000); }
    return min;
  };
  it('is never under 0.8 s in a lane in free flow at the Friday peak', () => {
    for (const s of [3000, 9000, 21000]) expect(minHeadway(trR, 'with', s, at('2025-07-11T21:30:00Z'), at('2025-07-11T23:30:00Z'))).toBeGreaterThanOrEqual(0.8);
  });
  it('is never under 0.8 s in a lane in a queue and in its discharge', () => {
    for (const s of [15000, 19000, 25000]) expect(minHeadway(trB, 'with', s, T8 - HOUR / 2, T8 + 3 * HOUR)).toBeGreaterThanOrEqual(0.8);
  });
});

describe('a bottleneck matches the kinematic-wave closed form', () => {
  // lane-drop: demand 5000/h meets 4000/h of capacity at s = 20 km
  const seg = bfile.directions.with.segments[0];
  const vfe = 1 / seg.laneShares.reduce((a, sh, i) => a + sh / (seg.freeFlowMps + seg.laneSpeedOffsetsMps[i]), 0);
  const w = trB.options.waveMps;
  const qA = BOTTLENECK.qHigh / 3600, c = BOTTLENECK.downCap / 3600;
  const kj = (BOTTLENECK.upCap / 3600) * (1 / vfe + 1 / w);
  const kA = qA / vfe, kC = kj - c / w;
  const u = (qA - c) / (kC - kA); // speed of the queue's tail upstream, m/s
  const tail = (ms) => { // first s (upstream) where traffic runs below half the free speed
    for (let s = 0; s < BOTTLENECK.x; s += 10) if (trB.stateAt('with', s, ms).v < vfe / 2) return s;
    return null;
  };
  it('the tail grows backward at (qA - c) / (kC - kA)', () => {
    const t1 = T8 + 20 * 60e3, t2 = T8 + 100 * 60e3; // 08:20 and 09:40 local, demand constant at the tail
    const x1 = tail(t1), x2 = tail(t2);
    const measured = (x1 - x2) / ((t2 - t1) / 1000);
    expect(measured / u).toBeCloseTo(1, 1);
    expect(Math.abs(measured / u - 1)).toBeLessThan(0.03);
  });
  it('the queue discharges at capacity and is at the jam state for that flow', () => {
    const down = trB.stateAt('with', 25000, T8 + 60 * 60e3);
    expect(down.vph / BOTTLENECK.downCap).toBeCloseTo(1, 2);
    const inQueue = trB.stateAt('with', 18000, T8 + 60 * 60e3);
    expect(inQueue.vph / BOTTLENECK.downCap).toBeCloseTo(1, 1);
    expect(inQueue.k / kC).toBeCloseTo(1, 1);
  });
  it('the queue clears when the counted excess has drained (area balance), within 2 minutes', () => {
    // independent: integrate the demand curve at the bottleneck (the downstream segment's demand, shifted
    // from its middle to its start by the free travel time) minus capacity, from onset until it is zero
    const seg1 = bfile.directions.with.segments[1];
    const vfe1 = 1 / seg1.laneShares.reduce((a, sh, i) => a + sh / (seg1.freeFlowMps + seg1.laneSpeedOffsetsMps[i]), 0);
    const shift = 5000 / vfe1 * 1000;
    const demand = (ms) => trB.demandAt('with', 25000, ms + shift) / 3600;
    let ms = T8 - 2 * HOUR, Q = 0, started = false, clear = null;
    for (; ms < T8 + 12 * HOUR; ms += 1000) {
      Q = Math.max(0, Q + (demand(ms) - c));
      if (Q > 0) started = true;
      if (started && Q === 0) { clear = ms; break; }
    }
    // downstream, the flow stays at capacity until the queue is gone, then falls to the demand: take the
    // middle of that fall (the 60 s grid spreads it over a few minutes)
    const travel = 5000 / vfe1 * 1000;
    const after = demand(clear + 10 * 60e3) * 3600;
    let end = null;
    for (let t = T8 + 3 * HOUR; t < T8 + 12 * HOUR; t += 10e3) if (trB.stateAt('with', 25000, t + travel).vph < (BOTTLENECK.downCap + after) / 2) { end = t; break; }
    expect(Math.abs(end - clear) / 60e3).toBeLessThan(2);
  });
});

describe('seeking and scrubbing', () => {
  for (const [name, tr, f, ms] of [['free flow', trR, ramps, at('2025-07-11T22:10:00Z')], ['queue', trB, bfile, T8 + 40 * 60e3]]) {
    it(`${name}: N and the vehicles are identical when rebuilt after a seek away and back`, () => {
      const t = createTraffic(f, { cache: 1 });
      const n1 = [0, 5000, 10000, 15000].map((s) => t.slotAt('with', 2, s, ms));
      const v1 = snap(t, 'with', 12000, 19000, ms);
      const a1 = snap(t, 'against', 2000, 9000, ms);
      t.vehiclesIn('with', 0, 5000, ms + 5 * 86400e3, createVehicleBuffer());
      t.vehiclesIn('against', 0, 5000, ms - 40 * 86400e3, createVehicleBuffer());
      expect(t.stats().builds).toBeGreaterThanOrEqual(4);
      expect([0, 5000, 10000, 15000].map((s) => t.slotAt('with', 2, s, ms))).toEqual(n1);
      expect(snap(t, 'with', 12000, 19000, ms)).toEqual(v1);
      expect(snap(t, 'against', 2000, 9000, ms)).toEqual(a1);
      expect(v1.length).toBeGreaterThan(20);
      void tr;
    });
  }

  /** Frames at 60 Hz (or any step): every vehicle seen in both moves by about v dt, and a lane keeps its order. */
  function checkFrames(tr, dir, sA, sB, ms0, steps, stepMs) {
    const bounds = tr.segments(dir).map((g) => g.s0);
    let prev = null, maxErr = 0;
    for (let f = 0; f <= steps; f++) {
      const ms = ms0 + f * stepMs;
      const cur = snap(tr, dir, sA, sB, ms);
      // order within a lane: k decreases along the direction of travel
      const byLane = {};
      for (const v of cur) (byLane[v.lane] ||= []).push(v);
      for (const l in byLane) {
        const a = byLane[l].sort((p, q) => (dir === 'with' ? p.s - q.s : q.s - p.s));
        for (let i = 1; i < a.length; i++) expect(a[i].k).toBeLessThan(a[i - 1].k);
      }
      if (prev) {
        const was = new Map(prev.map((v) => [v.id, v]));
        const now = new Map(cur.map((v) => [v.id, v]));
        const sign = dir === 'with' ? 1 : -1;
        for (const v of cur) {
          const p = was.get(v.id);
          if (p) {
            maxErr = Math.max(maxErr, Math.abs((v.s - p.s) * sign - ((p.v + v.v) / 2) * (stepMs / 1000)));
            expect([v.lane, v.body, v.colour, v.truck]).toEqual([p.lane, p.body, p.colour, p.truck]);
          } else {
            // a vehicle appears only at the stretch's upstream edge or at a segment boundary (a ramp)
            const edge = dir === 'with' ? Math.abs(v.s - sA) : Math.abs(v.s - sB);
            const ramp = Math.min(...bounds.map((b) => Math.abs(v.s - b)));
            expect(Math.min(edge, ramp), `id ${v.id} appeared at ${v.s}`).toBeLessThan(v.v * (stepMs / 1000) + 1);
          }
        }
        for (const p of prev) {
          if (now.has(p.id)) continue;
          const edge = dir === 'with' ? Math.abs(p.s - sB) : Math.abs(p.s - sA);
          const ramp = Math.min(...bounds.map((b) => Math.abs(p.s - b)));
          expect(Math.min(edge, ramp), `id ${p.id} vanished at ${p.s}`).toBeLessThan(p.v * (stepMs / 1000) + 1);
        }
      }
      prev = cur;
    }
    return maxErr;
  }
  it('vehicles keep identity and order at 60 Hz across segment boundaries and a window change (free flow)', () => {
    const tile = 3 * HOUR;
    const ms0 = Math.ceil(at('2025-07-11T22:00:00Z') / tile) * tile - 2000; // crosses a tile boundary
    expect(checkFrames(trR, 'with', 4000, 14000, ms0, 240, 1000 / 60)).toBeLessThan(0.05);
    expect(checkFrames(trR, 'against', 4000, 14000, ms0, 240, 1000 / 60)).toBeLessThan(0.05);
  });
  it('and in a queue at 60 Hz', () => {
    expect(checkFrames(trB, 'with', 15000, 22000, T8 + 30 * 60e3, 90, 1000 / 60)).toBeLessThan(0.2);
  });
  it('scrubbing back and forth gives the same vehicles at the same time', () => {
    const ms = at('2025-07-11T22:10:00Z');
    const a = snap(trR, 'with', 5000, 15000, ms);
    snap(trR, 'with', 5000, 15000, ms + 40 * 60e3);
    snap(trR, 'with', 5000, 15000, ms - 7 * 60e3);
    expect(snap(trR, 'with', 5000, 15000, ms)).toEqual(a);
    const b = snap(trB, 'with', 12000, 20000, T8 + 30 * 60e3);
    snap(trB, 'with', 12000, 20000, T8 - 3 * HOUR);
    expect(snap(trB, 'with', 12000, 20000, T8 + 30 * 60e3)).toEqual(b);
  });
  it('oncoming traffic travels towards smaller s, and its ids differ from the other direction', () => {
    const ms = at('2025-07-11T22:10:00Z');
    const a = snap(trR, 'against', 8000, 12000, ms), b = snap(trR, 'against', 7000, 13000, ms + 1000);
    const later = new Map(b.map((v) => [v.id, v]));
    let n = 0;
    for (const v of a) if (later.has(v.id)) { expect(later.get(v.id).s).toBeLessThan(v.s); n++; }
    expect(n).toBeGreaterThan(5);
    const w = new Set(snap(trR, 'with', 8000, 12000, ms).map((v) => v.id));
    for (const v of a) expect(w.has(v.id)).toBe(false);
  });
});

describe('vehicles', () => {
  const ms = at('2025-07-11T22:10:00Z');
  const all = snap(trR, 'with', 0, 24000, ms);
  it('have bodies, colours, lanes inside the carriageway, and the counted truck share', () => {
    expect(all.length).toBeGreaterThan(300);
    for (const v of all) {
      expect(v.body).toBeGreaterThanOrEqual(0);
      expect(v.body).toBeLessThan(BODIES.length);
      expect(v.truck === 1).toBe(v.body >= 4);
      expect(v.lane).toBeGreaterThanOrEqual(1);
    }
    // trucks over an hour at the last segment (25%) and the second (10%)
    for (const [s, share] of [[21000, 0.25], [9000, 0.1]]) {
      let n = 0, t = 0;
      trR.crossings('with', s, ms, ms + HOUR, (id, lane, k, tc, truck) => { n++; if (truck) t++; });
      expect(t / n).toBeCloseTo(share, 1);
    }
  });
  it('trucks keep to the right lanes', () => {
    const lanes = { truck: [], car: [] };
    trR.crossings('with', 3000, ms, ms + HOUR, (id, lane, k, tc, truck) => lanes[truck ? 'truck' : 'car'].push(lane));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(lanes.truck)).toBeGreaterThan(mean(lanes.car));
  });
  it('left lanes run faster in free flow; speeds sit near the lane speed', () => {
    const seg = ramps.directions.with.segments[0];
    const inSeg = all.filter((v) => v.s < 5800 && v.s > 200);
    for (let l = 1; l <= 3; l++) {
      const vs = inSeg.filter((v) => v.lane === l).map((v) => v.v);
      const want = seg.freeFlowMps + seg.laneSpeedOffsetsMps[l - 1];
      for (const v of vs) expect(Math.abs(v - want)).toBeLessThan(1.5);
    }
  });
  it('brake lamps come on at the tail of a queue, not in free flow', () => {
    const free = snap(trR, 'with', 1000, 5000, ms);
    expect(free.filter((v) => v.accel < 0).length).toBe(0);
    const t = T8 + 40 * 60e3;
    const x = (() => { for (let s = 0; s < 20000; s += 20) if (trB.stateAt('with', s, t).v < 15) return s; return 0; })();
    const atTail = snap(trB, 'with', x - 300, x + 100, t);
    expect(atTail.some((v) => v.accel < 0)).toBe(true);
  });
  it('reuse the buffer: no new arrays once it is big enough', () => {
    const b = createVehicleBuffer(4096);
    const ids = b.id;
    trR.vehiclesIn('with', 0, 24000, ms, b);
    trR.vehiclesIn('against', 0, 24000, ms, b, true);
    expect(b.id).toBe(ids);
    expect(b.count).toBeGreaterThan(600);
  });
});

describe('level sets for the visitor\'s car (D6.5)', () => {
  const ms = at('2025-07-11T22:10:00Z');
  it('slotTime inverts slotPosition, free and queued', () => {
    for (const [tr, t] of [[trR, ms], [trB, T8 + 30 * 60e3]]) {
      const k = Math.floor(tr.slotAt('with', 2, 10000, t));
      const s = tr.slotPosition('with', 2, k, t);
      expect(Math.abs(tr.slotTime('with', 2, k, s) - t)).toBeLessThan(5);
    }
  });
  it('a ghost slot is not a vehicle and is at least 0.8 s from the vehicles around it', () => {
    for (const [tr, t, s] of [[trR, ms, 10000], [trB, T8 + 60 * 60e3, 17000]]) {
      const k = tr.nearestSlot('with', 2, s, t);
      expect(tr.isPresent('with', 2, k, s)).toBe(false);
      const tk = tr.slotTime('with', 2, k, s);
      let ahead = k - 1, behind = k + 1;
      while (!tr.isPresent('with', 2, ahead, s)) ahead--;
      while (!tr.isPresent('with', 2, behind, s)) behind++;
      expect((tk - tr.slotTime('with', 2, ahead + 0.08, s)) / 1000).toBeGreaterThanOrEqual(0.8);
      expect((tr.slotTime('with', 2, behind - 0.08, s) - tk) / 1000).toBeGreaterThanOrEqual(0.8);
    }
  });
  it('travels at the lane speed when free and slows in the queue', () => {
    const seg = ramps.directions.with.segments[0];
    const L = trR.levelSet('with', 2, Math.floor(trR.slotAt('with', 2, 3000, ms)));
    expect(L.speedAt(ms)).toBeCloseTo(seg.freeFlowMps + seg.laneSpeedOffsetsMps[1], 6);
    const s0 = L.sAt(ms);
    expect(L.sAt(ms + 10000) - s0).toBeCloseTo(10 * L.speedAt(ms), 3);
    const t = T8 + 60 * 60e3;
    const Q = trB.levelSet('with', 2, Math.floor(trB.slotAt('with', 2, 17000, t)));
    expect(Q.speedAt(t)).toBeLessThan(10);
    // the queue costs time: crossing 10..19 km takes longer than at the free speed
    const dur = (Q.timeAt(19000) - Q.timeAt(10000)) / 1000;
    expect(dur).toBeGreaterThan(9000 / 30 * 2);
  });
});

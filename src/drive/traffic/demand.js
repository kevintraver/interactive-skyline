// The demand surface: which vehicles are where at any simulation time (plan 02, sections 5.8 and
// 7.10; D6.2). Everything is a pure function of (s, t), so scrubbing time either way, or seeking and
// coming back, shows the same vehicles in the same places.
//
// ------------------------------------------------------------------------------------- the model
// Per direction, the carriageway is a kinematic-wave road (triangular fundamental diagram per
// segment: free speed vfe, capacity c, wave speed w, jam density kj = c (1/vfe + 1/w)). The counted
// flow of each segment is its demand, as a cumulative count A_j(t) at the segment's start (the
// table describes the segment's middle, so A_j is shifted by the free travel time to it). Where
// demand exceeds a segment's capacity its start is a bottleneck: departures follow Newell's
// envelope D_b(t) = min over tau <= t of [Â_b(tau) + c_b (t - tau)], and the stored vertical queue
// Q_b = Â_b - D_b spreads upstream at the wave speed: the count at a point upstream is the lower
// envelope of the free-flow arrivals and every downstream bottleneck's departures carried back by
// the backward wave plus the jam storage between (Newell's simplified kinematic-wave theory). That
// gives the speed field v(s, t) of the carriageway; outside every queue it is the free speed.
//
// Vehicles. Each lane (numbered from the left of its direction) is a stream of SLOTS: slot k enters
// the route at T = k / A_l, A_l a constant per lane (no more than 3600 per hour, so slots are at
// least a second apart). Slots ride the lane's speed field, which is the carriageway's scaled by the
// lane's free speed, so N_l(s, t) = A_l * T_l(s, t), with T_l the entry time of the slot through
// (s, t), is constant along each slot's path: vehicle k is where N_l(s, t) = k. Slots never pass
// one another, so a lane keeps its order. T_l(s, t) = t - tau_l(s) - d_l(s, t): tau_l is the free
// travel time, d_l the delay, on a grid (dx by dt) only when the window holds a queue.
//
// Which slots are vehicles (the nested ramp rule, plan 5.8). On segment j slot k is a vehicle iff
// its presence coordinate u_k (R2 sequence) is below theta = phi * classFactor, where phi is the
// ratio of the lane's real flow (share_jl * carriageway flow) to the slot flow at the segment's
// start, at the time slot k crossed it. phi is fixed for a slot on a segment, so vehicles appear
// and vanish only at segment boundaries (they joined or left by a ramp), in the counted
// proportions, and a slot below every segment's threshold stays the same vehicle all the way.
// The class coordinate v_k decides truck or not (trucks are a share P_l of slots, weighted to the
// right lanes), with each class thinned to the segment's truck share.
//
// Windows. The surface is built for a window of simulation time: tiles of `tileHours` with
// `marginHours` either side (six hours by default), plus `preHours` of run-in for slots already on
// the road, and bottleneck queues are traced back `lookbackHours`. A time always maps to the same
// tile and every number is a function of absolute time, so a rebuilt window is identical.

import { parseTraffic, DIRECTIONS } from './format.js';
import { createClock, createSegmentFlow } from './flow.js';
import * as H from './hash.js';

// local bindings: the hot loop then calls plain functions, not module-namespace getters (which a
// module runner such as Vitest's adds to every imported binding)
const { presenceU, classV, hash32, unit } = H;

export const BODIES = ['sedan', 'crossover', 'pickup', 'van', 'tractor', 'coach'];
/** Cumulative mix of light vehicles: sedan, crossover, pickup, van (a generic US mix, assumed). */
const LIGHT_MIX = [0.36, 0.74, 0.91, 1];
const COACH_SHARE = 0.08;
/** Truck preference by lane position from the right: rightmost, next, the rest. */
const TRUCK_LANE_WEIGHT = [1.6, 1.25, 0.45];
export const MAX_SLOT_VPH = 3600;
const MIN_SLOT_VPH = 36;

export const DEFAULTS = Object.freeze({
  dx: 100, // m, grid columns
  dt: 60, // s, grid rows
  tileHours: 3,
  marginHours: 1.5,
  preHours: 2,
  lookbackHours: 24,
  bottleneckStep: 20, // s
  waveMps: 5.5, // backward wave speed, about 20 km/h
  jitter: 0.08, // slot fraction: small speed variation that never reorders a lane
  minSpeed: 0.5, // m/s, floor in a jam
  cache: 4, // windows kept
});

/** A reusable result buffer for vehiclesIn; grows (and only then allocates) when full. */
export function createVehicleBuffer(capacity = 512) {
  const b = { count: 0, capacity: 0 };
  b.grow = (n) => {
    const old = b.capacity ? b : null;
    const make = (T) => new T(n);
    const fields = { id: Float64Array, k: Float64Array, s: Float64Array, speed: Float32Array, accel: Int8Array, lane: Uint8Array, lanes: Uint8Array, body: Uint8Array, colour: Uint32Array, truck: Uint8Array };
    for (const [name, T] of Object.entries(fields)) {
      const a = make(T);
      if (old) a.set(b[name].subarray(0, b.count));
      b[name] = a;
    }
    b.capacity = n;
  };
  b.grow(capacity);
  return b;
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Index of the segment holding x (x0[j] <= x < x0[j+1]; the end belongs to the last). */
function segIndex(x0, J, x) {
  let lo = 0, hi = J - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (x0[m] <= x) lo = m; else hi = m - 1; }
  return lo;
}

/** The static description of one direction, in travel coordinates x (0 at its entry). */
function buildDirection(name, dirIndex, D, range, clock, refMonth) {
  const [S0, S1] = range;
  const L = S1 - S0;
  const raw = name === 'with' ? D.segments : D.segments.slice().reverse();
  const J = raw.length;
  const x0 = new Float64Array(J + 1);
  raw.forEach((g, j) => { x0[j] = name === 'with' ? g.s0 - S0 : S1 - g.s1; });
  x0[J] = L;
  x0[0] = 0;
  const Lmax = Math.max(...raw.map((g) => g.lanes));
  const segs = raw.map((g, j) => {
    const lanes = g.lanes;
    const share = new Float64Array(Lmax), vl = new Float64Array(Lmax), ts = new Float64Array(Lmax);
    let slow = 0;
    for (let l = 0; l < Lmax; l++) {
      const o = g.laneSpeedOffsetsMps[Math.min(l, lanes - 1)];
      vl[l] = g.freeFlowMps + o;
      share[l] = l < lanes ? g.laneShares[l] : 0;
      slow += share[l] / vl[l];
    }
    // trucks keep right: weight by position from the right, normalised so the segment's share holds
    let wsum = 0;
    const w = new Float64Array(Lmax);
    for (let l = 0; l < lanes; l++) { w[l] = TRUCK_LANE_WEIGHT[Math.min(lanes - 1 - l, 2)]; wsum += share[l] * w[l]; }
    for (let l = 0; l < lanes; l++) ts[l] = Math.min(1, (g.truckShare * w[l]) / (wsum || 1));
    const vfe = 1 / slow;
    const cap = g.capacityVph / 3600;
    return { j, lanes, share, vl, ts, vfe, cap, flow: createSegmentFlow(g.flow, clock, refMonth), src: g };
  });
  const tauC = new Float64Array(J + 1), Kc = new Float64Array(J + 1), tmid = new Float64Array(J);
  const tauL = [];
  for (let l = 0; l < Lmax; l++) tauL.push(new Float64Array(J + 1));
  const kj = new Float64Array(J), vfe = new Float64Array(J), cap = new Float64Array(J);
  segs.forEach((g, j) => {
    const len = x0[j + 1] - x0[j];
    vfe[j] = g.vfe; cap[j] = g.cap;
    tauC[j + 1] = tauC[j] + len / g.vfe;
    tmid[j] = len / 2 / g.vfe;
    for (let l = 0; l < Lmax; l++) tauL[l][j + 1] = tauL[l][j] + len / g.vl[l];
  });
  // slot streams per lane
  const lanes = [];
  for (let l = 0; l < Lmax; l++) {
    let P = 0, need = 0;
    for (const g of segs) if (g.share[l] > 0) P = Math.max(P, g.ts[l]);
    const thetaT = new Float64Array(J), thetaC = new Float64Array(J), share = new Float64Array(J), vl = new Float64Array(J);
    segs.forEach((g, j) => {
      share[j] = g.share[l];
      vl[j] = g.vl[l];
      thetaT[j] = P > 0 ? g.ts[l] / P : 0;
      thetaC[j] = P < 1 ? (1 - g.ts[l]) / (1 - P) : 0;
      if (g.share[l] > 0) need = Math.max(need, g.share[l] * g.flow.peak() * Math.max(thetaT[j], thetaC[j]));
    });
    if (!(need > 0)) { lanes.push(null); continue; }
    const vph = clamp(need * 1.02, MIN_SLOT_VPH, MAX_SLOT_VPH);
    lanes.push({ l, A: vph / 3600, P, thetaT, thetaC, share, vl, tau: tauL[l], salt: dirIndex * 16 + l, saturated: need * 1.02 > MAX_SLOT_VPH });
  }
  return { name, dirIndex, road: D.road, S0, S1, L, J, x0, segs, Lmax, lanes, tauC, Kc, tmid, kj, vfe, cap };
}

/**
 * The demand surface for one route.
 * @param {object} data  a traffic file (raw or parsed by parseTraffic)
 * @param {object} [options]  overrides of DEFAULTS
 */
export function createTraffic(data, options = {}) {
  const file = data && data.range ? data : parseTraffic(data);
  const o = { ...DEFAULTS, ...options };
  const clock = createClock(file.tz, file.seasonOfMonth);
  const dirs = DIRECTIONS.map((name, i) => buildDirection(name, i, file.directions[name], file.range, clock, file.year * 12));
  for (const d of dirs) {
    // jam storage with the chosen wave speed
    for (let j = 0; j < d.J; j++) {
      d.kj[j] = d.cap[j] * (1 / d.vfe[j] + 1 / o.waveMps);
      d.Kc[j + 1] = d.Kc[j] + d.kj[j] * (d.x0[j + 1] - d.x0[j]);
    }
  }
  const dirOf = (dir) => {
    const d = typeof dir === 'number' ? dirs[dir] : dirs[DIRECTIONS.indexOf(dir)];
    if (!d) throw new Error(`traffic: no direction ${dir}`);
    return d;
  };
  const tileSec = o.tileHours * 3600;
  const cache = new Map();
  const stats = { builds: 0, lastBuildMs: 0, maxBuildMs: 0, congestedBuilds: 0 };

  // ---------------------------------------------------------------------------------- windows
  function buildWindow(d, tile) {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { J, x0, segs, tauC, Kc, kj, vfe, cap, tmid, L } = d;
    const w = o.waveMps, dt = o.dt, dx = o.dx;
    const Wu0 = tile * tileSec - o.marginHours * 3600;
    const Wu1 = (tile + 1) * tileSec + o.marginHours * 3600;
    const G0 = Wu0 - o.preHours * 3600;
    const nr = Math.round((Wu1 - G0) / dt) + 1;
    const Tlb = G0 - o.lookbackHours * 3600;
    const H0 = Math.floor(Tlb / 3600) - 2;
    const H1 = Math.ceil(Wu1 / 3600) + 2;
    const spans = segs.map((g) => g.flow.span(H0, H1));
    const A = (j, t) => spans[j].countAt(t + tmid[j]);

    // bottlenecks, upstream first
    const active = [];
    const Qat = (b, t) => {
      const f = (t - b.t0) / b.step;
      if (f <= 0) return 0;
      const i = Math.floor(f);
      if (i >= b.n - 1) return b.Q[b.n - 1];
      return b.Q[i] + (b.Q[i + 1] - b.Q[i]) * (f - i);
    };
    const held = (j, t, upto) => { // vehicles held in queues at or upstream of segment j's start
      let s = 0;
      for (let a = 0; a < active.length; a++) {
        const b = active[a];
        if (b.j > j || (upto && b.j === j)) continue;
        s += Qat(b, t - (tauC[j] - tauC[b.j]));
      }
      return s;
    };
    const Dcum = (j, t) => A(j, t) - held(j, t, false);
    for (let j = 0; j < J; j++) {
      let peak = 0;
      for (let t = Math.floor(Tlb / 1800) * 1800; t <= Wu1 + 1800; t += 1800) peak = Math.max(peak, spans[j].flowAt(t + tmid[j]));
      if (!(active.length || peak / 3600 > cap[j] * 0.999)) continue;
      const step = o.bottleneckStep;
      const n = Math.ceil((Wu1 - Tlb) / step) + 2;
      const Q = new Float64Array(n);
      let Dprev = 0, maxQ = 0, tq0 = Infinity, tq1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const t = Tlb + i * step;
        const ah = A(j, t) - held(j, t, true);
        const D = i === 0 ? ah : Math.min(ah, Dprev + cap[j] * step);
        Q[i] = ah - D;
        Dprev = D;
        if (Q[i] > 1e-6) { maxQ = Math.max(maxQ, Q[i]); tq0 = Math.min(tq0, t); tq1 = Math.max(tq1, t); }
      }
      if (maxQ > 1e-6) {
        let kgap = Infinity;
        for (let i = 0; i < j; i++) kgap = Math.min(kgap, (cap[i] - peak / 3600) / vfe[i] + Math.max(0, cap[i] - cap[j]) / w);
        kgap = Math.max(0.01, kgap);
        const reach = Math.min(x0[j], (1.2 * maxQ) / kgap + 1000);
        active.push({ j, x0: x0[j], Q, t0: Tlb, step, n, maxQ, tq0, tq1, reach });
      }
    }

    // carriageway count at (x in segment i, t): the lower envelope of free-flow arrivals and each
    // downstream bottleneck's departures carried back by the wave; branch -1 = free, else which
    const branch = { at: -1 };
    /** Value of bottleneck a's branch at (x in segment i, t). */
    const wave = (x, i, t, a) => {
      const b = active[a];
      const tp = t - (b.x0 - x) / w;
      let v = Dcum(i, tp - (tauC[b.j] - tauC[i])) + Kc[b.j] - (Kc[i] + (x - x0[i]) * kj[i]);
      for (let c = 0; c < active.length; c++) {
        const m = active[c];
        if (m.j > i && m.j <= b.j) v -= Qat(m, tp - (tauC[b.j] - tauC[m.j]));
      }
      return v;
    };
    const envelope = (x, i, t) => {
      let best = Dcum(i, t - (x - x0[i]) / vfe[i]);
      branch.at = -1;
      for (let a = 0; a < active.length; a++) {
        const b = active[a];
        if (b.j <= i || x < b.x0 - b.reach) continue;
        const v = wave(x, i, t, a);
        if (v < best) { best = v; branch.at = a; }
      }
      return best;
    };
    const flowAtNode = (x, i, t) => (envelope(x, i, t + 5) - envelope(x, i, t - 5)) / 10;
    /** Speed ratio vfe / v at a node: 1 in free flow, from the congested branch of the diagram in a queue. */
    const ratioAt = (x, si, t) => {
      envelope(x, si, t);
      const a = branch.at;
      if (a < 0) return 1;
      const q = (wave(x, si, t + 5, a) - wave(x, si, t - 5, a)) / 10;
      let v = vfe[si];
      if (q > 0) { const k = kj[si] - q / w; v = k > 0 ? q / k : v; } else v = o.minSpeed;
      v = clamp(v, o.minSpeed, vfe[si]);
      return vfe[si] / v;
    };

    const win = { tile, d, G0, nr, Wu0, Wu1, dt, dx, congested: active.length > 0, active, spans, Dcum };
    // carriageway flow at each segment start, per row (veh/s)
    const rate = new Float64Array(J * nr);
    for (let j = 0; j < J; j++) {
      for (let n = 0; n < nr; n++) {
        const t = G0 + n * dt;
        rate[j * nr + n] = win.congested ? Math.max(0, flowAtNode(x0[j], j, t)) : spans[j].flowAt(t + tmid[j]) / 3600;
      }
    }
    win.rate = rate;

    if (win.congested) {
      stats.congestedBuilds++;
      const nc = Math.ceil(L / dx) + 1;
      const xs = new Float64Array(nc);
      for (let i = 0; i < nc; i++) xs[i] = Math.min(i * dx, L);
      const rr = new Float32Array(nc * nr).fill(1);
      const rrOne = new Uint8Array(nc).fill(1);
      for (const b of active) {
        const ia = Math.max(0, Math.floor((b.x0 - b.reach) / dx)), ib = Math.min(nc - 1, Math.ceil(b.x0 / dx));
        const na = Math.max(0, Math.floor((b.tq0 - 300 - G0) / dt));
        const nb = Math.min(nr - 1, Math.ceil((b.tq1 + b.reach / w + 300 - G0) / dt));
        // every other row, the rows between interpolated (a shock is smeared over two minutes)
        for (let ci = ia; ci <= ib; ci++) {
          const x = xs[ci];
          if (x >= b.x0) continue;
          const si = segIndex(x0, J, x);
          const base = ci * nr;
          let prev = -1, prevR = 1;
          for (let n = na; ; n = Math.min(n + 2, nb)) {
            const r = ratioAt(x, si, G0 + n * dt);
            if (r > rr[base + n]) rr[base + n] = r;
            if (prev >= 0 && n - prev === 2) {
              const mid = 0.5 * (r + prevR);
              if (mid > rr[base + n - 1]) rr[base + n - 1] = mid;
            }
            if (r !== 1 || prevR !== 1) rrOne[ci] = 0;
            prev = n; prevR = r;
            if (n >= nb) break;
          }
        }
      }
      win.nc = nc; win.xs = xs; win.rr = rr;
      win.delay = [];
      win.dB = [];
      win.mf = [];
      for (const lane of d.lanes) {
        if (!lane) { win.delay.push(null); win.dB.push(null); win.mf.push(null); continue; }
        const del = new Float32Array(nc * nr);
        let zero = true;
        const tauX = (x) => { const j = segIndex(x0, J, x); return lane.tau[j] + (x - x0[j]) / lane.vl[j]; };
        let tPrev = tauX(xs[0]);
        for (let ci = 0; ci + 1 < nc; ci++) {
          const tNext = tauX(xs[ci + 1]);
          const dtau = tNext - tPrev;
          tPrev = tNext;
          if (zero && rrOne[ci] && rrOne[ci + 1]) continue;
          let any = false;
          const base = (ci + 1) * nr;
          const cb = ci * nr, last = nr - 1;
          for (let n = 0; n < nr; n++) {
            const r1 = rr[base + n];
            let f = n - (dtau * r1) / dt, m, u;
            if (f <= 0) { m = 0; u = 0; } else if (f >= last) { m = last - 1; u = 1; } else { m = f | 0; u = f - m; }
            const r0 = rr[cb + m] + (rr[cb + m + 1] - rr[cb + m]) * u;
            const dtc = dtau * 0.5 * (r0 + r1);
            f = n - dtc / dt;
            if (f <= 0) { m = 0; u = 0; } else if (f >= last) { m = last - 1; u = 1; } else { m = f | 0; u = f - m; }
            let v = del[cb + m] + (del[cb + m + 1] - del[cb + m]) * u + (dtc - dtau);
            if (n > 0 && v > del[base + n - 1] + dt) v = del[base + n - 1] + dt;
            if (v < 0) v = 0;
            del[base + n] = v;
            if (v !== 0) any = true;
          }
          zero = !any;
        }
        win.delay.push(del);
        // delay and slot-flow factor at each segment start
        const dB = new Float64Array(J * nr), mf = new Float64Array(J * nr);
        for (let j = 0; j < J; j++) {
          const f = x0[j] / dx, ci = Math.min(nc - 2, Math.floor(f)), u = f - ci;
          for (let n = 0; n < nr; n++) dB[j * nr + n] = del[ci * nr + n] * (1 - u) + del[(ci + 1) * nr + n] * u;
          for (let n = 0; n < nr; n++) {
            const a = dB[j * nr + Math.max(0, n - 1)], b = dB[j * nr + Math.min(nr - 1, n + 1)];
            const span = (Math.min(nr - 1, n + 1) - Math.max(0, n - 1)) * dt;
            mf[j * nr + n] = Math.max(0.02, 1 - (b - a) / span);
          }
        }
        win.dB.push(dB);
        win.mf.push(mf);
      }
    }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
    stats.builds++;
    stats.lastBuildMs = ms;
    stats.maxBuildMs = Math.max(stats.maxBuildMs, ms);
    return win;
  }

  function windowAt(d, tSec) {
    const tile = Math.floor(tSec / tileSec);
    const key = d.dirIndex * 1e9 + tile;
    let win = cache.get(key);
    if (win) { cache.delete(key); cache.set(key, win); return win; }
    win = buildWindow(d, tile);
    cache.set(key, win);
    while (cache.size > o.cache) cache.delete(cache.keys().next().value);
    return win;
  }

  // ------------------------------------------------------------------------- slot geometry
  const rowF = (win, t) => clamp((t - win.G0) / win.dt, 0, win.nr - 1);
  /** Delay of lane l's slots at (x, t), and its derivatives, into out = [d, d_t, d_x]. */
  function delayAt(win, l, x, t, out) {
    if (!win.congested) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const del = win.delay[l], nr = win.nr;
    const fx = clamp(x / win.dx, 0, win.nc - 1), ci = Math.min(win.nc - 2, Math.floor(fx)), u = fx - ci;
    const fr = rowF(win, t), n = Math.min(nr - 2, Math.floor(fr)), v = fr - n;
    const a = del[ci * nr + n], b = del[ci * nr + n + 1], c = del[(ci + 1) * nr + n], e = del[(ci + 1) * nr + n + 1];
    out[0] = (a * (1 - v) + b * v) * (1 - u) + (c * (1 - v) + e * v) * u;
    out[1] = ((b - a) * (1 - u) + (e - c) * u) / win.dt;
    out[2] = ((c * (1 - v) + e * v) - (a * (1 - v) + b * v)) / win.dx;
    return out;
  }
  const scratch = [0, 0, 0];
  const tauAt = (d, lane, x, j) => lane.tau[j] + (x - d.x0[j]) / lane.vl[j];

  /** Entry time (s) of the slot through (x, t) in lane l: T = t - tau(x) - delay. */
  function entryTime(d, win, lane, x, t) {
    const j = segIndex(d.x0, d.J, x);
    return t - tauAt(d, lane, x, j) - delayAt(win, lane.l, x, t, scratch)[0];
  }

  /** Time (s) at which continuous slot n crosses the start of segment j. */
  function crossStart(d, win, lane, j, n) {
    const c = n / lane.A + lane.tau[j];
    if (!win.congested) return c;
    const dB = win.dB[lane.l], nr = win.nr, base = j * nr, G0 = win.G0, dt = win.dt;
    const h = (i) => G0 + i * dt - dB[base + i];
    if (c <= h(0)) return c + dB[base];
    if (c >= h(nr - 1)) return c + dB[base + nr - 1];
    let lo = 0, hi = nr - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (h(m) <= c) lo = m; else hi = m; }
    const a = h(lo), b = h(hi);
    return G0 + (lo + (b > a ? (c - a) / (b - a) : 0)) * dt;
  }

  /** Expected real share (0..1) of lane l's slots on segment j for slots crossing its start at tc. */
  function phiAt(d, win, lane, j, tc) {
    const nr = win.nr, f = rowF(win, tc), n = Math.min(nr - 2, Math.floor(f)), u = f - n;
    const r = win.rate[j * nr + n] * (1 - u) + win.rate[j * nr + n + 1] * u;
    let mf = 1;
    if (win.congested) { const m = win.mf[lane.l]; mf = m[j * nr + n] * (1 - u) + m[j * nr + n + 1] * u; }
    return (lane.share[j] * r) / (lane.A * mf);
  }

  /** Is integer slot k of this lane a vehicle on segment j? */
  function present(d, win, lane, j, k) {
    if (!(lane.share[j] > 0)) return false;
    const phi = phiAt(d, win, lane, j, crossStart(d, win, lane, j, k));
    const truck = classV(k, lane.salt) < lane.P;
    return presenceU(k, lane.salt) < phi * (truck ? lane.thetaT[j] : lane.thetaC[j]);
  }

  /**
   * Jitter of slot k at t (slot fraction), its rate and its second derivative, into
   * out = [eps, epsDot, epsDDot]. Periods of one to two minutes keep the speed variation within about
   * half a metre per second and its acceleration far below the brake-lamp threshold.
   */
  function jitter(lane, k, t, out) {
    if (!o.jitter) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const h = hash32(k, lane.salt + 101);
    const period = 60 + 60 * ((h & 0xffff) / 65536);
    const w = (2 * Math.PI) / period;
    // reduce before the sine: t is ~1.8e9 s, and sin of a huge argument is slow
    const c = t / period + (h >>> 16) / 65536;
    const ph = 2 * Math.PI * (c - Math.floor(c));
    out[0] = o.jitter * Math.sin(ph);
    out[1] = o.jitter * w * Math.cos(ph);
    out[2] = -w * w * out[0];
    return out;
  }
  const jit = [0, 0, 0];

  /** Solve tau(x) + delay(x, t) = y for x in lane l, starting the walk at segment j0. Returns x. */
  function invert(d, win, lane, y, t, j0) {
    const { x0, J } = d;
    if (!win.congested) {
      let j = j0;
      while (j + 1 < J && lane.tau[j + 1] <= y) j++;
      while (j > 0 && lane.tau[j] > y) j--;
      return x0[j] + (y - lane.tau[j]) * lane.vl[j];
    }
    // g(x) = tau(x) + delay(x, t), increasing; bracket on the grid columns, then solve per piece
    const g = (x) => { const j = segIndex(x0, J, x); return tauAt(d, lane, x, j) + delayAt(win, lane.l, x, t, scratch)[0]; };
    let a = 0, b = d.L;
    if (y <= g(0)) return (y - g(0)) * lane.vl[0];
    if (y >= g(b)) return b + (y - g(b)) * lane.vl[J - 1];
    // binary search on columns
    let lo = 0, hi = win.nc - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g(win.xs[m]) <= y) lo = m; else hi = m; }
    a = win.xs[lo]; b = win.xs[hi];
    for (let it = 0; it < 40 && b - a > 1e-4; it++) { const m = (a + b) / 2; if (g(m) <= y) a = m; else b = m; }
    return (a + b) / 2;
  }

  // A walk for many inversions at one time in a congested window: the columns' delay and
  // g = tau + delay at time t, then each y found by moving a pointer (y only grows along a lane).
  let colD = new Float64Array(0), colG = new Float64Array(0);
  const walk = { ca: 0, cb: 0, ci: 0 };
  function prepareWalk(d, win, lane, t, xa, xb) {
    if (colD.length < win.nc) { colD = new Float64Array(win.nc); colG = new Float64Array(win.nc); }
    const nr = win.nr, del = win.delay[lane.l];
    const fr = rowF(win, t), n = Math.min(nr - 2, Math.floor(fr)), v = fr - n;
    walk.ca = Math.max(0, Math.floor(xa / win.dx) - 1);
    walk.cb = Math.min(win.nc - 1, Math.ceil(xb / win.dx) + 1);
    walk.ci = walk.ca;
    let j = segIndex(d.x0, d.J, win.xs[walk.ca]);
    for (let ci = walk.ca; ci <= walk.cb; ci++) {
      const x = win.xs[ci];
      while (j + 1 < d.J && d.x0[j + 1] <= x) j++;
      colD[ci] = del[ci * nr + n] * (1 - v) + del[ci * nr + n + 1] * v;
      colG[ci] = tauAt(d, lane, x, j) + colD[ci];
    }
  }
  function invertWalk(d, win, lane, y) {
    const { ca, cb } = walk;
    if (y < colG[ca]) return -Infinity;
    if (y >= colG[cb]) return Infinity;
    let ci = walk.ci;
    while (ci + 1 < cb && colG[ci + 1] <= y) ci++;
    while (ci > ca && colG[ci] > y) ci--;
    walk.ci = ci;
    const a = win.xs[ci], b = win.xs[ci + 1];
    const da = colD[ci], slope = b > a ? (colD[ci + 1] - da) / (b - a) : 0;
    let j = segIndex(d.x0, d.J, a);
    for (;;) {
      const pa = Math.max(a, d.x0[j]), pb = Math.min(b, d.x0[j + 1]);
      const g0 = lane.tau[j] + (pa - d.x0[j]) / lane.vl[j] + da + slope * (pa - a);
      const rate = 1 / lane.vl[j] + slope;
      if (j + 1 >= d.J || pb >= b || y <= g0 + rate * (pb - pa)) return pa + (y - g0) / rate;
      j++;
    }
  }

  /** Speed (m/s) of the vehicle on continuous slot path at (x, t), with jitter rate epsDot. */
  function slotSpeed(d, win, lane, x, j, t, epsDot) {
    delayAt(win, lane.l, x, t, scratch);
    const Tt = 1 - scratch[1];
    const Tx = -1 / lane.vl[j] - scratch[2];
    return (epsDot / lane.A - Tt) / Tx;
  }

  const toX = (d, s) => (d.name === 'with' ? s - d.S0 : d.S1 - s);
  const toS = (d, x) => (d.name === 'with' ? x + d.S0 : d.S1 - x);

  // --------------------------------------------------------------------------------- queries
  /**
   * Vehicles between route chainages sA and sB (either order) at simMs, in one direction.
   * Fills `out` (createVehicleBuffer) from index 0, or after its current count when append.
   * Per vehicle: id (unique per direction, lane and slot), k (slot), s (route chainage), speed (m/s,
   * along its own direction), accel (-1 braking, 0, +1), lane (1 = leftmost of its direction),
   * lanes (lanes there), body (index into BODIES), colour (32-bit seed), truck (0/1).
   */
  function vehiclesIn(dir, sA, sB, simMs, out, append = false) {
    const d = dirOf(dir);
    const t = simMs / 1000;
    const win = windowAt(d, t);
    let xa = toX(d, sA), xb = toX(d, sB);
    if (xa > xb) { const z = xa; xa = xb; xb = z; }
    xa = Math.max(0, xa); xb = Math.min(d.L, xb);
    if (!append) out.count = 0;
    if (!(xb > xa)) return out;
    const ja = segIndex(d.x0, d.J, xa);
    for (const lane of d.lanes) {
      if (!lane) continue;
      const A = lane.A;
      const nHi = A * entryTime(d, win, lane, xa, t) + o.jitter;
      const nLo = A * entryTime(d, win, lane, xb, t) - o.jitter;
      let j = ja;
      if (win.congested) prepareWalk(d, win, lane, t, xa, xb);
      for (let k = Math.floor(nHi); k >= Math.ceil(nLo); k--) {
        jitter(lane, k, t, jit);
        const y = t - (k + jit[0]) / A;
        const x = win.congested ? invertWalk(d, win, lane, y) : invert(d, win, lane, y, t, j);
        if (x < xa) continue;
        if (x > xb) break;
        while (j + 1 < d.J && d.x0[j + 1] <= x) j++;
        if (!present(d, win, lane, j, k)) continue;
        if (out.count >= out.capacity) out.grow(out.capacity * 2);
        const i = out.count++;
        const v = slotSpeed(d, win, lane, x, j, t, jit[1]);
        // acceleration: the jitter's own (free flow: x' = v (1 - eps'/A)), plus the change of the
        // slot's speed half a second on at the predicted place (a slower segment, a queue)
        let acc = (-v * jit[2]) / A;
        const x2 = Math.min(d.L, x + v * 0.5);
        let j2 = j;
        while (j2 + 1 < d.J && d.x0[j2 + 1] <= x2) j2++;
        if (win.congested || j2 !== j) acc += (slotSpeed(d, win, lane, x2, j2, t + 0.5, 0) - slotSpeed(d, win, lane, x, j, t, 0)) / 0.5;
        const truck = classV(k, lane.salt) < lane.P;
        const h = hash32(k, lane.salt);
        let body;
        if (truck) body = unit(h) < COACH_SHARE ? 5 : 4;
        else { const u = unit(h); body = u < LIGHT_MIX[0] ? 0 : u < LIGHT_MIX[1] ? 1 : u < LIGHT_MIX[2] ? 2 : 3; }
        out.id[i] = k * 32 + lane.salt;
        out.k[i] = k;
        out.s[i] = toS(d, x);
        out.speed[i] = v;
        out.accel[i] = acc < -0.4 ? -1 : acc > 0.4 ? 1 : 0;
        out.lane[i] = lane.l + 1;
        out.lanes[i] = d.segs[j].lanes;
        out.body[i] = body;
        out.colour[i] = hash32(k, lane.salt + 57);
        out.truck[i] = truck ? 1 : 0;
      }
    }
    return out;
  }

  /**
   * Density, speed and flow of one direction at route chainage s and simMs, summed over lanes:
   * q (veh/s), k (veh/m), v (m/s, space-mean) with q = k * v exactly, plus vph and per-lane values.
   */
  function stateAt(dir, s, simMs, out = {}) {
    const d = dirOf(dir);
    const t = simMs / 1000;
    const win = windowAt(d, t);
    const x = clamp(toX(d, s), 0, d.L);
    const j = segIndex(d.x0, d.J, x);
    let q = 0, k = 0;
    const lanes = out.lanes || (out.lanes = []);
    lanes.length = 0;
    for (const lane of d.lanes) {
      if (!lane || !(lane.share[j] > 0)) continue;
      delayAt(win, lane.l, x, t, scratch);
      const Tt = 1 - scratch[1], Tx = -1 / lane.vl[j] - scratch[2];
      const n = lane.A * (t - tauAt(d, lane, x, j) - scratch[0]);
      const phi = Math.min(1, phiAt(d, win, lane, j, crossStart(d, win, lane, j, n)));
      const ql = phi * lane.A * Tt, kl = -phi * lane.A * Tx;
      lanes.push({ lane: lane.l + 1, q: ql, k: kl, v: ql / kl });
      q += ql; k += kl;
    }
    out.q = q; out.k = k; out.v = k > 0 ? q / k : d.vfe[j];
    out.vph = q * 3600;
    out.congested = out.v < d.vfe[j] * 0.95;
    return out;
  }

  /** Counted (input) flow of the segment holding s at simMs, vph: the table curve at the middle. */
  function demandAt(dir, s, simMs) {
    const d = dirOf(dir);
    const t = simMs / 1000;
    const win = windowAt(d, t);
    const j = segIndex(d.x0, d.J, clamp(toX(d, s), 0, d.L));
    return win.spans[j].flowAt(t);
  }

  // ------------------------------------------------------------------- level sets (for D6.5)
  const laneOf = (d, lane) => {
    const L = d.lanes[lane - 1];
    if (!L) throw new Error(`traffic: ${d.name} has no traffic in lane ${lane}`);
    return L;
  };
  /** Continuous slot number at (s, simMs) in a lane (1 = leftmost); vehicle k is where this is k. */
  function slotAt(dir, lane, s, simMs) {
    const d = dirOf(dir), L = laneOf(d, lane), t = simMs / 1000;
    return L.A * entryTime(d, windowAt(d, t), L, clamp(toX(d, s), 0, d.L), t);
  }
  /** Route chainage of continuous slot n at simMs (no jitter), NaN when it is not on the route. */
  function slotPosition(dir, lane, n, simMs) {
    const d = dirOf(dir), L = laneOf(d, lane), t = simMs / 1000;
    const x = invert(d, windowAt(d, t), L, t - n / L.A, t, 0);
    return x < 0 || x > d.L ? NaN : toS(d, x);
  }
  /** Speed (m/s) of continuous slot n at simMs (no jitter). */
  function slotSpeedAt(dir, lane, n, simMs) {
    const d = dirOf(dir), L = laneOf(d, lane), t = simMs / 1000;
    const win = windowAt(d, t);
    const x = clamp(invert(d, win, L, t - n / L.A, t, 0), 0, d.L);
    return slotSpeed(d, win, L, x, segIndex(d.x0, d.J, x), t, 0);
  }
  /** simMs at which continuous slot n passes route chainage s. */
  function slotTime(dir, lane, n, s) {
    const d = dirOf(dir), L = laneOf(d, lane);
    const x = clamp(toX(d, s), 0, d.L);
    const j = segIndex(d.x0, d.J, x);
    const c = n / L.A + tauAt(d, L, x, j);
    let t = c;
    for (let it = 0; it < 4; it++) {
      const win = windowAt(d, t);
      if (!win.congested) return t * 1000;
      // solve t - delay(x, t) = c on the window's rows
      const h = (tt) => tt - delayAt(win, L.l, x, tt, scratch)[0];
      let lo = win.G0, hi = win.G0 + (win.nr - 1) * win.dt;
      if (c <= h(lo)) t = c + delayAt(win, L.l, x, lo, scratch)[0];
      else if (c >= h(hi)) t = c + delayAt(win, L.l, x, hi, scratch)[0];
      else { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (h(m) <= c) lo = m; else hi = m; } t = (lo + hi) / 2; }
      if (t >= win.Wu0 && t <= win.Wu1) break;
    }
    return t * 1000;
  }
  /** Is integer slot k a vehicle on the segment holding s? */
  function isPresent(dir, lane, k, s) {
    const d = dirOf(dir), L = laneOf(d, lane);
    const x = clamp(toX(d, s), 0, d.L);
    const j = segIndex(d.x0, d.J, x);
    const t = slotTime(dir, lane, k, toS(d, d.x0[j])) / 1000;
    return present(d, windowAt(d, t), L, j, k);
  }
  /**
   * The integer slot nearest (s, simMs) in a lane. With ghost (default) only a slot that is NOT a
   * vehicle on that segment, so the visitor's car can take it without overlapping anyone.
   */
  function nearestSlot(dir, lane, s, simMs, { ghost = true } = {}) {
    const n = slotAt(dir, lane, s, simMs);
    const k0 = Math.round(n);
    for (let r = 0; r < 10000; r++) {
      for (const k of r === 0 ? [k0] : [k0 + r, k0 - r]) {
        if (isPresent(dir, lane, k, s) !== ghost) return k;
      }
    }
    return k0;
  }
  /** One slot's path: { sAt(simMs), timeAt(s), speedAt(simMs) }. */
  function levelSet(dir, lane, k) {
    return {
      dir, lane, k,
      sAt: (simMs) => slotPosition(dir, lane, k, simMs),
      timeAt: (s) => slotTime(dir, lane, k, s),
      speedAt: (simMs) => slotSpeedAt(dir, lane, k, simMs),
    };
  }

  /**
   * Every vehicle crossing route chainage s in [ms0, ms1): calls fn(id, lane, k, simMs, truck).
   * For tests and calibration; jitter included (crossing time solved to 1e-6 s).
   */
  function crossings(dir, s, ms0, ms1, fn) {
    const d = dirOf(dir);
    const x = clamp(toX(d, s), 0, d.L);
    const j = segIndex(d.x0, d.J, x);
    let count = 0;
    for (const lane of d.lanes) {
      if (!lane || !(lane.share[j] > 0)) continue;
      const n0 = slotAt(dir, lane.l + 1, s, ms0), n1 = slotAt(dir, lane.l + 1, s, ms1);
      for (let k = Math.floor(n0 - o.jitter); k <= Math.ceil(n1 + o.jitter); k++) {
        let tc = slotTime(dir, lane.l + 1, k, s);
        for (let it = 0; it < 8; it++) tc = slotTime(dir, lane.l + 1, k + jitter(lane, k, tc / 1000, jit)[0], s);
        if (tc < ms0 || tc >= ms1) continue;
        const win = windowAt(d, tc / 1000);
        if (!present(d, win, lane, j, k)) continue;
        count++;
        if (fn) fn(k * 32 + lane.salt, lane.l + 1, k, tc, classV(k, lane.salt) < lane.P);
      }
    }
    return count;
  }

  return {
    file, options: o, directions: DIRECTIONS.slice(),
    /** Route chainage range [S0, S1] the traffic covers. */
    range: file.range.slice(),
    /** Lanes per direction that carry slots: [{ lane, slotVph, truckSlots, saturated }]. */
    lanes: (dir) => dirOf(dir).lanes.filter(Boolean).map((L) => ({ lane: L.l + 1, slotVph: L.A * 3600, truckSlots: L.P, saturated: L.saturated })),
    segments: (dir) => dirOf(dir).segs.map((g) => g.src),
    vehiclesIn, stateAt, demandAt,
    slotAt, slotPosition, slotSpeed: slotSpeedAt, slotTime, isPresent, nearestSlot, levelSet, crossings,
    /** The window (internal) serving a time: for tests and the debug overlay. */
    windowAt: (dir, simMs) => windowAt(dirOf(dir), simMs / 1000),
    /** Drop cached windows (tests use it to prove a rebuild gives the same surface). */
    clear: () => cache.clear(),
    stats: () => ({ ...stats, windows: cache.size }),
  };
}

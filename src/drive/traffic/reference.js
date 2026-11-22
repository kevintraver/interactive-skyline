// The visitor's car as one of the traffic (plan 02, D6.5, in the form this build takes). Pure: no three.js.
//
// The counts show no recurring queue on these routes, so the journey keeps driving at the posted speed
// (journey.js) and the traffic is made to agree with it, instead of the journey following a slot's level set:
//
// 1. Lane speeds referenced to the journey's lane. Along the route the car is in one traffic lane at a time:
//    refLane(s), the stream (lanemap.js) whose centre line is nearest the car's lateral offset there (so it
//    follows the lane plan's changes and the streams' own shifts where lanes are added on the left). The
//    file's lanes run at freeFlowMps + offset_l (offsets from the right: 0, +1.34, +2.68 m/s); here, on the
//    "with" carriageway, lane l runs at
//        v_l(s) = v_J(s) + offset_l(s) - offset_ref(s)
//    with v_J the journey's own speed at s (posted limits with its raised-cosine changes). The car's lane
//    carries exactly the car's speed, lanes to its left are faster and to its right slower by the plan's lane
//    offsets. Where refLane changes (a planned lane change, a stream shift) offset_ref jumps; the jump is eased
//    over SMOOTH_M centred on the change, so the traffic around never brakes for it (peak deceleration
//    v * dv * 1.875 / SMOOTH_M, about 0.3 m/s^2 for a 1.34 m/s step at 75 mph; brake lamps light at 0.4).
//    The other steps of a lane's speed, where a segment's lane count (and so the lanes' offsets) changes, are
//    eased too, by averaging over SEGMENT_EASE_M (the car's own lane has none: its offset is the reference).
//    Each lane's free travel time is then tabulated every STEP_M (demand.js options.lanePace): in the car's
//    lane the table's differences are the journey's own travel times, so the car's continuous slot number
//    n = A (t_car(s) - tau(s) - shift) is constant along a stretch in one lane.
// 2. The car on a slot. That constant is made an integer: for the first stretch the car spends in each lane
//    the lane's slot grid is slid by a constant (demand.js setLaneShift: shifts(), redone whenever the journey
//    is re-timed; it prefers an integer that is not a vehicle there, a gap); before each later stretch in a
//    lane its travel times get a small smooth bump (under half a slot, spread over up to BUMP_M before the
//    change) that lands the car on an integer again. In free flow the car then rides slot K of its lane:
//    the vehicles ahead and behind are slots K -/+ 1 or farther, at their natural headways (at least one
//    slot, a second at most 3600 slots an hour, less the 0.08-slot jitter), and slot K itself, a vehicle or a
//    gap, is the car's place and never drawn (fleet.js). Nothing has to dissolve near the car in free flow.
//
// Not built of D6.5 as written: the journey following its lane's level set through a queue (and so the
// journey time growing on a Friday as the surface predicts). The counts show no recurring queue on the three
// routes (demand.js raises capacities to the counted peaks), the journey's timing is exactly invertible and
// shared by the rig, the UI, the moment links and the reveal (journey.js), and the plan says the journey
// keeps the posted speed for this build. Where a queue does form (a synthetic file, a future incident) the
// car leaves its slot; fleet.js's gap rule is kept as the guard for that case.

const STEP_M = 10;
/** Distance over which a step of a lane's free speed at a segment boundary is eased (a box average), m. */
export const SEGMENT_EASE_M = 200;
/** Distance over which a jump of the reference offset is eased, m. */
export const SMOOTH_M = 300;
/** Longest stretch before a lane change over which a lane's phase is corrected, m. */
export const BUMP_M = 1000;
/** A stretch in one lane shorter than this is folded into its neighbours (a flicker of the nearest stream), m. */
const MIN_RUN_M = 60;

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (u * 6 - 15) + 10));

/**
 * @param {{ traffic: object, laneMap: object, journey: object, step?: number }} opts
 *   traffic: a createTraffic of the route's file (only its range, segments and slot rates are read);
 *   laneMap: createLaneMap of it; journey: the visitor's journey on the same route (journey.js).
 * @returns {{ lanePace, refLaneAt(s), runs, shifts(traffic, journey), slotRates, step }}
 */
export function createReference({ traffic, laneMap, journey, step = STEP_M }) {
  const [S0, S1] = traffic.range;
  const L = S1 - S0;
  const m = Math.ceil(L / step - 1e-9);
  const n = m + 1;
  const sAt = (i) => S0 + Math.min(i * step, L);
  const segs = traffic.segments('with');
  const lanesInfo = traffic.lanes('with');
  const A = new Float64Array(9);
  for (const l of lanesInfo) A[l.lane] = l.slotVph / 3600;
  const Lmax = Math.max(...segs.map((g) => g.lanes));
  const segAt = (() => { let j = 0; return (s) => { if (s < segs[j].s0) j = 0; while (j + 1 < segs.length && segs[j + 1].s0 <= s) j++; return segs[j]; }; })();
  /** Speed offset (m/s) of lane l (1-based) on the segment at s, as demand.js reads it. */
  const offsetOf = (s, l) => { const g = segAt(s); return g.laneSpeedOffsetsMps[Math.min(l - 1, g.lanes - 1)]; };
  const sJ0 = journey.s0 ?? S0, sJ1 = journey.s1 ?? S1;
  const clampJ = (s) => (s < sJ0 ? sJ0 : s > sJ1 ? sJ1 : s);
  const tJ = (s) => journey.profile.timeOf(clampJ(s)); // s from the route's start
  const vJ = (s) => journey.speedAt(clampJ(s));

  // ---- the car's traffic lane at each grid point
  const lm = { sRoad: 0, d: 0, dds: 0, w: 0 };
  const ref = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = sAt(i);
    const dCar = journey.offsetAt(clampJ(s));
    const lanes = segAt(s).lanes;
    let best = 1, bestD = Infinity;
    for (let l = 1; l <= lanes; l++) {
      if (!(A[l] > 0)) continue;
      laneMap.at('with', l, s, lm);
      const dd = Math.abs(lm.d - dCar) + (lm.w < 0.2 ? 5 : 0);
      if (dd < bestD) { bestD = dd; best = l; }
    }
    ref[i] = best;
  }
  // fold short flickers into the lane around them
  const minRun = Math.max(1, Math.round(MIN_RUN_M / step));
  for (let i = 1; i < n;) {
    if (ref[i] === ref[i - 1]) { i++; continue; }
    let j = i;
    while (j < n && ref[j] === ref[i]) j++;
    if (j - i < minRun && j < n && ref[j] === ref[i - 1]) ref.fill(ref[i - 1], i, j);
    i = j;
  }
  // switches: where the reference lane changes, with the jump of the reference offset there
  const switches = [];
  for (let i = 1; i < n; i++) {
    if (ref[i] === ref[i - 1]) continue;
    const s = (sAt(i - 1) + sAt(i)) / 2;
    switches.push({ s, from: ref[i - 1], to: ref[i], jump: offsetOf(s, ref[i - 1]) - offsetOf(s, ref[i]) });
  }
  // the eased correction C(s) = sum_k J_k (ease((s - m_k + W/2) / W) - H(s - m_k))
  const W = SMOOTH_M;
  const corr = (s) => {
    let c = 0;
    for (const w of switches) {
      if (s < w.s - W / 2 || s > w.s + W / 2 || !w.jump) continue;
      c += w.jump * (ease((s - w.s + W / 2) / W) - (s >= w.s ? 1 : 0));
    }
    return c;
  };

  // ---- the lanes' travel-time tables
  // v_l = v_J + avg(Q_l) + sum_k J_k ease_k, with Q_l = offset_l - offset_ref - sum_k J_k H(s - m_k): Q_l has no
  // jump at a change of reference lane (those are eased by the ease terms) and is constant along the car's own
  // lane, so averaging it eases only the steps at segment boundaries and leaves the car's lane at v_J
  const taus = [];
  for (let l = 1; l <= Lmax; l++) taus.push(A[l] > 0 ? new Float64Array(n) : null);
  const Q = [];
  for (let l = 1; l <= Lmax; l++) Q.push(A[l] > 0 ? new Float64Array(m) : null);
  const easeSum = new Float64Array(m);
  for (let i = 0, k = 0, held = 0; i < m; i++) {
    const sm = (sAt(i) + sAt(i + 1)) / 2;
    // a switch between two grid points sits at their middle, sm (H(0) = 1)
    while (k < switches.length && switches[k].s <= sm) held += switches[k++].jump;
    const offRef = offsetOf(sm, ref[i + 1]);
    for (let l = 1; l <= Lmax; l++) if (Q[l - 1]) Q[l - 1][i] = offsetOf(sm, l) - offRef - held;
    easeSum[i] = corr(sm) + held;
  }
  const half = Math.max(0, Math.round(SEGMENT_EASE_M / step / 2));
  const avg = (q) => {
    const pre = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) pre[i + 1] = pre[i] + q[i];
    const o = new Float64Array(m);
    for (let i = 0; i < m; i++) { const a = Math.max(0, i - half), b = Math.min(m, i + half + 1); o[i] = (pre[b] - pre[a]) / (b - a); }
    return o;
  };
  const Qa = Q.map((q) => (q ? avg(q) : null));
  for (let i = 0; i < m; i++) {
    const sa = sAt(i), sb = sAt(i + 1), sm = (sa + sb) / 2;
    const v = vJ(sm);
    const dt = tJ(sb) - tJ(sa);
    for (let l = 1; l <= Lmax; l++) {
      const tau = taus[l - 1];
      if (!tau) continue;
      const vl = Math.max(1, v + Qa[l - 1][i] + easeSum[i]);
      const d = dt > 0 ? dt * (v / vl) : (sb - sa) / vl;
      tau[i + 1] = tau[i] + d;
    }
  }

  // ---- stretches per lane and the phase bumps before every stretch after the first
  const runs = []; // { lane, s0 (eased in), s1 (the next change, eased out), anchor }
  {
    let a = S0, lane = ref[0];
    for (const w of switches) {
      runs.push({ lane, s0: a === S0 ? S0 : a + W / 2, s1: w.s - W / 2 });
      a = w.s; lane = w.to;
    }
    runs.push({ lane, s0: a === S0 ? S0 : a + W / 2, s1: S1 });
    for (const r of runs) { r.s1 = Math.max(r.s1, r.s0); r.anchor = Math.min(r.s1, r.s0 + 1); }
  }
  const tauAtGrid = (tau, s) => {
    const f = Math.min(Math.max((s - S0) / step, 0), m), i = Math.min(Math.floor(f), m - 1), u = f - i;
    return tau[i] + (tau[i + 1] - tau[i]) * u;
  };
  const firstRun = new Map();
  const lastEnd = new Map();
  for (const r of runs) {
    const tau = taus[r.lane - 1];
    if (!tau) continue;
    if (!firstRun.has(r.lane)) { firstRun.set(r.lane, r); lastEnd.set(r.lane, r.s1); continue; }
    const r1 = firstRun.get(r.lane);
    const Al = A[r.lane];
    const nOf = (s) => Al * (tJ(s) - tauAtGrid(tau, s));
    const delta = nOf(r.s0) - nOf(r1.anchor);
    const fix = Math.round(delta) - delta; // slots to add
    const wb = r.s0 - W; // the bump ends before the eased change begins
    let wa = Math.max(lastEnd.get(r.lane) + W / 2, wb - BUMP_M);
    if (wb - wa < 50) wa = wb - 50;
    // n = A (t - tau): adding fix slots means tau lower by fix / A
    const dTau = -fix / Al;
    // keep the pace positive: at most a fifth of the travel time over the window
    const window = tauAtGrid(tau, wb) - tauAtGrid(tau, wa);
    if (Math.abs(dTau) > 0.2 * window) { r.unaligned = true; lastEnd.set(r.lane, r.s1); continue; }
    for (let i = 0; i < n; i++) {
      const s = sAt(i);
      if (s <= wa) continue;
      tau[i] += dTau * ease((s - wa) / (wb - wa));
    }
    r.bump = { s0: wa, s1: wb, slots: fix };
    lastEnd.set(r.lane, r.s1);
  }

  const spec = taus.map((tau) => (tau ? { h: step, tau } : null));
  const refAt = (s) => ref[Math.min(n - 1, Math.max(0, Math.round((s - S0) / step)))];

  return {
    step, switches, runs, slotRates: A,
    /** demand.js options.lanePace */
    lanePace: { with: spec },
    /** The traffic lane (1 = leftmost of the route's direction) the car counts as in at route chainage s. */
    refLaneAt: refAt,
    /** The eased part of the reference offset's changes at s, sum_k J_k ease(..) (m/s), for tests: its slope
     * times the speed is the deceleration the change asks of the traffic. */
    easedJumpAt: (s) => {
      let c = 0;
      for (const w of switches) if (w.jump) c += w.jump * ease((s - w.s + W / 2) / W);
      return c;
    },
    /**
     * Slide each lane the car uses so that the car rides an integer slot in its first stretch there, for this
     * journey's timing (call again after journey.rebase). Prefers a slot that is not a vehicle (a gap).
     * @returns {Array<{ lane, shift, k }>}
     */
    shifts(trafficModel, jny = journey) {
      const out = [];
      for (const [lane, r] of firstRun) {
        const Al = A[lane];
        trafficModel.setLaneShift('with', lane, 0);
        const n0 = Al * (jny.timeAt(r.anchor) / 1000 - trafficModel.freeTau('with', lane, r.anchor));
        const k0 = Math.round(n0);
        let k = k0;
        for (const cand of [k0, k0 - 1, k0 + 1]) {
          trafficModel.setLaneShift('with', lane, (n0 - cand) / Al);
          if (!trafficModel.isPresent('with', lane, cand, r.anchor)) { k = cand; break; }
        }
        const shift = (n0 - k) / Al;
        trafficModel.setLaneShift('with', lane, shift);
        out.push({ lane, shift, k });
      }
      return out;
    },
  };
}

/**
 * Lanes of a direction with their free speeds eased at segment boundaries (a box average over SEGMENT_EASE_M of
 * freeFlowMps + offset), as demand.js options.lanePace for that direction: no lane then steps its speed (and
 * brakes) where the posted limit or the lane count changes. Used for the oncoming carriageway (the car's own is
 * referenced by createReference).
 * @param {{ traffic: object, dir: string, step?: number }} opts
 */
export function createEasedPace({ traffic, dir, step = STEP_M }) {
  const [S0, S1] = traffic.range;
  const L = S1 - S0;
  const m = Math.ceil(L / step - 1e-9);
  const segs = traffic.segments(dir).slice().sort((p, q) => p.s0 - q.s0);
  const lanes = traffic.lanes(dir).map((x) => x.lane);
  const Lmax = Math.max(...segs.map((g) => g.lanes));
  // travel coordinate x from the direction's entry: "against" runs from S1 to S0
  const sOfX = (x) => (dir === 'with' ? S0 + x : S1 - x);
  const segAt = (s) => segs.find((g) => g.s0 <= s && s < g.s1) || (s < segs[0].s0 ? segs[0] : segs[segs.length - 1]);
  const half = Math.max(0, Math.round(SEGMENT_EASE_M / step / 2));
  const spec = [];
  for (let l = 1; l <= Lmax; l++) {
    if (!lanes.includes(l)) { spec.push(null); continue; }
    const v = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const g = segAt(sOfX(Math.min(L, (i + 0.5) * step)));
      v[i] = g.freeFlowMps + g.laneSpeedOffsetsMps[Math.min(l - 1, g.lanes - 1)];
    }
    const pre = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) pre[i + 1] = pre[i] + v[i];
    const tau = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - half), b = Math.min(m, i + half + 1);
      const va = Math.max(1, (pre[b] - pre[a]) / (b - a));
      tau[i + 1] = tau[i] + (Math.min(L, (i + 1) * step) - i * step) / va;
    }
    spec.push({ h: step, tau });
  }
  return spec;
}

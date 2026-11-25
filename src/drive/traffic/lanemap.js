// Where traffic's lanes are on the road (plan 02, D6.4): for each direction of a route, a table along
// the ROUTE's chainage s (the traffic model's s for both directions) of
//   - the chainage on that direction's own road (the route's road itself for "with"; for "against" the
//     other carriageway, whose chainage runs the other way: the foot of the perpendicular from the
//     route's reference line onto it, found once by Newton steps and kept monotonic);
//   - for each traffic lane i (1 = leftmost of its direction), the lateral offset of its centre line on
//     that road (positive to the left of that road's direction), and a weight 0..1 that fades vehicles
//     where the road has no lane for them.
// Built once per route (tens of milliseconds); per vehicle a lookup is two linear interpolations with no
// allocation, so the fleet can place hundreds of vehicles a frame.
//
// Which road lane a traffic lane uses. The counts give lanes per segment (segment ends are ramps); OSM
// gives lanes per section (section ends are tapers); they disagree in places (auxiliary lanes, a
// left lane added a few hundred metres before the count segment changes). Traffic lanes are counted
// from the left, so where the road has as many lanes as traffic they match one to one. Where the road
// has more, traffic takes the lanes that run farthest (by RoadNet lane id, over consecutive sections):
// short auxiliary and weaving lanes stay empty, as they mostly are between ramps. Where the road has
// fewer, the lanes left over weigh 0 (their vehicles fade out). Only full-width lanes (3 m or more)
// count, so a stream takes an opening lane near the end of its taper and leaves a closing one at its
// start; and a vehicle whose body would overhang the outer edge lines weighs less as it does, so nobody
// drives onto a shoulder or a gore.
// Where the lane a traffic lane uses changes (a section or segment boundary), its centre line moves
// over BLEND metres with a quintic, like a lane change of the whole stream, never a jump.

import { createRefline } from '../roadnet/refline.js';
import { edgesAt, sectionIndexAt } from '../roadnet/crosssection.js';

export const MAX_TRAFFIC_LANES = 8;
const STEP = 4; // m between samples
const BLEND = 120; // m over which a lane assignment change is eased
const JUMP = 1.0; // m: an offset step between samples larger than this is an assignment change
const FULL = 3.0; // m: a lane at least this wide carries traffic
const HALF_BODY = 1.3; // m: half the widest body (2.59 m)

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (u * 6 - 15) + 10));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * Chainage on `other` of the foot of the perpendicular from each sample of `road` at s = s0 + i * step.
 * Monotonic (decreasing when the two run opposite ways) by construction: a sample that would go back is
 * held at its neighbour's value (counted in `held`).
 */
export function mapChainage(road, other, s0, s1, step = STEP) {
  const ra = createRefline(road), rb = createRefline(other);
  const n = Math.floor((s1 - s0) / step) + 1;
  const out = new Float64Array(n);
  const p = {}, q = {};
  // first guess: nearest station by brute force
  ra.at(s0, p);
  let best = Infinity, sb = 0;
  for (let i = 0; i < other.x.length; i++) {
    const d = (other.x[i] - p.x) ** 2 + (other.y[i] - p.y) ** 2;
    if (d < best) { best = d; sb = i * other.spacing; }
  }
  // which way the other road runs relative to this one
  rb.at(sb, q);
  const dir = Math.cos(q.heading - p.heading) >= 0 ? 1 : -1;
  let held = 0, maxDist = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(s1, s0 + i * step);
    ra.at(s, p);
    for (let it = 0; it < 6; it++) {
      rb.at(sb, q);
      const ds = (p.x - q.x) * Math.cos(q.heading) + (p.y - q.y) * Math.sin(q.heading);
      sb = clamp(sb + ds, 0, rb.length);
      if (Math.abs(ds) < 1e-4) break;
    }
    if (i > 0 && (sb - out[i - 1]) * dir < 0) { sb = out[i - 1]; held++; }
    out[i] = sb;
    rb.at(sb, q);
    maxDist = Math.max(maxDist, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return { s: out, step, s0, n, dir, held, maxDist };
}

/** For each section of a road, how far (m) each lane id runs over consecutive sections containing it. */
function laneRuns(road) {
  const secs = road.sections;
  const runs = secs.map(() => new Map());
  const ids = new Set();
  for (const sec of secs) for (const l of sec.lanes) ids.add(l.id);
  for (const id of ids) {
    let a = -1;
    for (let i = 0; i <= secs.length; i++) {
      const has = i < secs.length && secs[i].lanes.some((l) => l.id === id);
      if (has && a < 0) a = i;
      if (!has && a >= 0) {
        const len = secs[i - 1].s1 - secs[a].s0;
        for (let k = a; k < i; k++) runs[k].set(id, len);
        a = -1;
      }
    }
  }
  return runs;
}

/**
 * Lane ids traffic uses with n traffic lanes, left to right, from the lanes of a cross-section that are
 * full width (an opening lane joins once it is, a closing one leaves as soon as it is not), keeping the
 * n that run farthest; null where the road has too few.
 */
function assignment(strips, runOf, n) {
  const lanes = strips.filter((x) => x.kind === 'lane' && x.left - x.right >= FULL);
  if (n >= lanes.length) return Array.from({ length: n }, (_, k) => (k < lanes.length ? lanes[k].id : null));
  const order = lanes.map((l, k) => ({ id: l.id, k, run: runOf(l.id) }));
  order.sort((a, b) => b.run - a.run || a.k - b.k);
  const keep = new Set(order.slice(0, n).map((o) => o.id));
  return lanes.filter((l) => keep.has(l.id)).map((l) => l.id);
}

/**
 * Ease every jump of the sampled offsets, all lanes together: at a sample where any lane's offset steps,
 * every lane that steps there moves from its old line (extended) to its new one with the same quintic
 * over the same stretch. Both configurations keep consecutive lanes a lane width apart, and a blend of
 * the two with one weight keeps that too, so streams never meet while they move.
 */
function smoothJumps(raws, n, step) {
  const outs = raws.map((r) => Float32Array.from(r));
  const jumps = [];
  for (let m = 1; m < n; m++) if (raws.some((r) => Math.abs(r[m] - r[m - 1]) > JUMP)) jumps.push(m);
  const K0 = Math.round(BLEND / 2 / step);
  jumps.forEach((m, q) => {
    const prev = q > 0 ? jumps[q - 1] : -Infinity, next = q + 1 < jumps.length ? jumps[q + 1] : Infinity;
    const K = Math.max(1, Math.min(K0, Math.floor((m - prev) / 2), Math.floor((next - m) / 2)));
    for (let l = 0; l < raws.length; l++) {
      const raw = raws[l], out = outs[l];
      if (Math.abs(raw[m] - raw[m - 1]) <= JUMP) continue;
      const so = m >= 2 ? raw[m - 1] - raw[m - 2] : 0;
      const sn = m + 1 < n ? raw[m + 1] - raw[m] : 0;
      const slopeOld = Math.abs(so) < JUMP ? so : 0, slopeNew = Math.abs(sn) < JUMP ? sn : 0;
      for (let r = Math.max(0, m - K); r < Math.min(n, m + K); r++) {
        const oldV = raw[m - 1] + slopeOld * (r - (m - 1));
        const newV = raw[m] + slopeNew * (r - m);
        const e = ease((r - (m - K) + 0.5) / (2 * K));
        out[r] = oldV * (1 - e) + newV * e;
      }
    }
  });
  return outs;
}

/**
 * @param {{ traffic: object, roads: { with: object, against: object }, step?: number }} opts
 *   traffic from createTraffic; roads the decoded RoadNet roads its directions name.
 */
export function createLaneMap({ traffic, roads, step = STEP }) {
  const [S0, S1] = traffic.range;
  const n = Math.floor((S1 - S0) / step) + 1;
  const dirs = {};
  for (const dir of ['with', 'against']) {
    const road = roads[dir];
    const segs = traffic.segments(dir).slice().sort((p, q) => p.s0 - q.s0); // "against" lists them in travel order
    let sRoad, chain = null;
    if (dir === 'with') {
      sRoad = new Float64Array(n);
      for (let i = 0; i < n; i++) sRoad[i] = Math.min(S1, S0 + i * step);
    } else {
      chain = mapChainage(roads.with, road, S0, S1, step);
      sRoad = chain.s;
    }
    const runs = laneRuns(road);
    const off = [], wt = [], has = [];
    for (let l = 0; l < MAX_TRAFFIC_LANES; l++) { off.push(new Float32Array(n)); wt.push(new Float32Array(n)); has.push(new Uint8Array(n)); }
    const lanesT = new Uint8Array(n);
    const edgeL = new Float32Array(n), edgeR = new Float32Array(n);
    let g = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.min(S1, S0 + i * step);
      while (g + 1 < segs.length && segs[g + 1].s0 <= s) g++;
      const nt = segs[g].lanes;
      lanesT[i] = nt;
      const sr = sRoad[i];
      const si = sectionIndexAt(road, sr);
      const cs = edgesAt(road, sr);
      const laneStrips = cs.strips.filter((x) => x.kind === 'lane');
      edgeL[i] = laneStrips[0].left;
      edgeR[i] = laneStrips[laneStrips.length - 1].right;
      const runOf = (id) => runs[si].get(id) ?? (si > 0 ? runs[si - 1].get(id) : 0) ?? 0;
      const ids = assignment(cs.strips, runOf, nt);
      let last = null;
      for (let l = 0; l < MAX_TRAFFIC_LANES; l++) {
        const id = l < ids.length ? ids[l] : null;
        const st = id === null ? null : laneStrips.find((x) => x.id === id);
        if (st) {
          off[l][i] = (st.left + st.right) / 2;
          has[l][i] = 1;
          last = st;
        } else {
          // no lane: keep the line beside the last one (it is never seen: weight 0)
          off[l][i] = last ? last.right - 1.83 : (l > 0 ? off[l - 1][i] - 3.66 : 0);
        }
      }
    }
    // where a traffic lane carries no vehicles (beyond the segment's lane count) its line is a lane width
    // right of the lane before it: so where a segment adds a lane on the right, the new stream starts off
    // the pavement (weight 0) and eases in beside the others as they make room, all in one blend
    for (let l = 1; l < MAX_TRAFFIC_LANES; l++) {
      const o = off[l], prev = off[l - 1], h = has[l];
      for (let i = 0; i < n; i++) if (l >= lanesT[i]) { o[i] = prev[i] - 3.66; h[i] = 1; }
    }
    // offsets eased across every change of lane; then the weight: 0 where traffic lane l has no road lane
    // (within 40 m), else by how far the body keeps inside the outer lane edges (a stream easing onto a
    // lane that is still opening dissolves at the edge line instead of overhanging the shoulder)
    const ramp = Math.max(1, Math.round(40 / step));
    const eased = smoothJumps(off, n, step);
    for (let l = 0; l < MAX_TRAFFIC_LANES; l++) {
      off[l] = eased[l];
      const o = off[l], w = wt[l], h = has[l];
      for (let i = 0; i < n; i++) {
        const margin = Math.min(edgeL[i] - o[i], o[i] - edgeR[i]) - HALF_BODY;
        w[i] = h[i] ? clamp((margin + 0.15) / 0.4, 0, 1) : 0;
      }
      for (let i = 1; i < n; i++) w[i] = Math.min(w[i], w[i - 1] + 1 / ramp);
      for (let i = n - 2; i >= 0; i--) w[i] = Math.min(w[i], w[i + 1] + 1 / ramp);
    }
    dirs[dir] = { road, refline: createRefline(road), sRoad, off, wt, lanesT, chain };
  }

  const tmp = { i: 0, u: 0 };
  const locate = (s) => {
    const f = clamp((s - S0) / step, 0, n - 1);
    let i = Math.floor(f);
    if (i >= n - 1) i = n - 2;
    tmp.i = i; tmp.u = f - i;
    return tmp;
  };

  return {
    S0, S1, step, n,
    dirs,
    /** Chainage on the direction's own road at route chainage s. */
    roadS(dir, s) {
      const d = dirs[dir], { i, u } = locate(s);
      return d.sRoad[i] + (d.sRoad[i + 1] - d.sRoad[i]) * u;
    },
    /**
     * Lane `lane` (1 = leftmost) of `dir` at route chainage s, into out = { sRoad, d, dds, w }: the road's
     * own chainage, the lateral offset on that road (positive left of ITS direction), the offset's rate
     * per metre of that road's chainage, and the weight 0..1. No allocation.
     */
    at(dir, lane, s, out) { return this.atDir(dirs[dir], lane, s, out); },
    /** at() with the direction's entry of `dirs` (saves the lookup in a hot loop). */
    atDir(d, lane, s, out) {
      const { i, u } = locate(s);
      const o = d.off[clamp(lane - 1, 0, MAX_TRAFFIC_LANES - 1)], w = d.wt[clamp(lane - 1, 0, MAX_TRAFFIC_LANES - 1)];
      const r0 = d.sRoad[i], r1 = d.sRoad[i + 1];
      out.sRoad = r0 + (r1 - r0) * u;
      out.d = o[i] + (o[i + 1] - o[i]) * u;
      out.dds = r1 !== r0 ? (o[i + 1] - o[i]) / (r1 - r0) : 0;
      out.w = w[i] + (w[i + 1] - w[i]) * u;
      return out;
    },
    /** How the opposing carriageway's chainage was mapped: { held, maxDist } (held samples, largest distance m). */
    chainStats: () => (dirs.against.chain ? { held: dirs.against.chain.held, maxDist: dirs.against.chain.maxDist } : null),
  };
}

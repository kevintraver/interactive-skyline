// A journey: where the car is at any simulation time on one route (plan 02, section 5.7).
// Everything is a pure function of time or of s; nothing integrates frame by frame, so
// scrubbing backwards gives the same pose as arriving there forwards.
//
// s is metres along the ROAD the route drives (route.s0 is not subtracted), the same s that
// routes.json uses for markers, starts and the reveal.
//
// Sideways the car follows the route's lane plan (routes.json "lanePlan", written by
// scripts/lib/laneplan.py): the centre line of one lane (a RoadNet lane id, so the same strip of
// pavement across sections) taken from the tapered cross-section, and each planned change a
// quintic blend from one lane's centre to the next over the change's [s0, s1]. Both are functions
// of s alone, so the path is the same in either direction. A route without a plan stays in the
// lane with id route.lane.

import { Vector3 } from 'three';
import { createRefline } from './roadnet/refline.js';
import { edgesAt } from './roadnet/crosssection.js';

export const MPH = 0.44704;
/** Peak acceleration of a speed change, m/s^2. */
export const ACCEL = 1.0;
/** Seconds of travel a planned lane change takes at least (the plan sets each change's span). */
export const LANE_EASE_SECONDS = 4;
/** Used when a road has no speed zones. */
export const DEFAULT_MPH = 65;

/** Distance a raised-cosine change from v1 to v2 takes, with peak acceleration ACCEL. */
const changeDistance = (v1, v2) => ((v1 + v2) / 2) * (Math.PI * Math.abs(v2 - v1)) / (2 * ACCEL);

/** Speed zones clipped to [s0, s1], equal neighbours merged: [{ a, b, v }]. */
function clipZones(road, s0, s1) {
  const raw = (road.speed || [])
    .filter((z) => Number.isFinite(z?.s0) && Number.isFinite(z?.mph) && z.mph > 0)
    .sort((p, q) => p.s0 - q.s0);
  if (!raw.length) raw.push({ s0: 0, mph: DEFAULT_MPH });
  const zones = [];
  for (let i = 0; i < raw.length; i++) {
    const a = Math.max(s0, i === 0 ? -Infinity : raw[i].s0);
    const b = Math.min(s1, i + 1 < raw.length ? raw[i + 1].s0 : Infinity);
    if (b > a) zones.push({ a, b, v: raw[i].mph * MPH });
  }
  return mergeZones(zones);
}

function mergeZones(zones) {
  const out = [];
  for (const z of zones) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.v - z.v) < 1e-9) last.b = z.b; else out.push({ ...z });
  }
  return out;
}

/**
 * Every speed change happens inside the faster of its two zones (slow down before a lower limit,
 * speed up after a higher one), so the car never exceeds a limit. A zone too short to hold its
 * changes has its speed lowered until they fit.
 */
function fitZones(zones) {
  for (let pass = 0; pass < 1000; pass++) {
    let changed = false;
    for (let k = 0; k < zones.length; k++) {
      const z = zones[k];
      const lows = [zones[k - 1], zones[k + 1]].filter((n) => n && n.v < z.v).map((n) => n.v);
      const need = (v) => lows.reduce((sum, n) => sum + (n < v ? changeDistance(n, v) : 0), 0);
      const len = z.b - z.a;
      if (need(z.v) <= len + 1e-9) continue;
      const lo = Math.max(...lows);
      if (need(lo) > len) z.v = lo;
      else {
        let a = lo, b = z.v;
        for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (need(m) <= len) a = m; else b = m; }
        z.v = a;
      }
      changed = true;
    }
    if (!changed) break;
    zones = mergeZones(zones);
  }
  return zones;
}

/**
 * Time-distance profile: cruise segments and raised-cosine speed changes (acceleration is
 * continuous and smooth, peak ACCEL), each analytic, so s(t) and t(s) are exact inverses.
 * Times are seconds from the route's start.
 */
export function createSpeedProfile(road, s0, s1) {
  const zones = fitZones(clipZones(road, s0, s1));
  const segs = [];
  let t = 0;
  const push = (sa, sb, v1, v2) => {
    if (!(sb > sa)) return;
    const T = v1 === v2 ? (sb - sa) / v1 : (Math.PI * Math.abs(v2 - v1)) / (2 * ACCEL);
    segs.push({ sa, sb, ta: t, tb: t + T, T, v1, v2 });
    t += T;
  };
  zones.forEach((z, k) => {
    const prev = zones[k - 1], next = zones[k + 1];
    const start = prev && prev.v < z.v ? z.a + changeDistance(prev.v, z.v) : z.a;
    const end = next && next.v < z.v ? z.b - changeDistance(z.v, next.v) : z.b;
    if (start > z.a) push(z.a, start, prev.v, z.v);
    push(start, end, z.v, z.v);
    if (end < z.b) push(end, z.b, z.v, next.v);
  });
  const total = t;

  const find = (key, value) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid][key] <= value) lo = mid; else hi = mid - 1; }
    return segs[lo];
  };
  // within a segment, tau in [0, T]
  const sIn = (g, tau) => {
    if (g.v1 === g.v2) return g.sa + g.v1 * tau;
    const w = Math.PI / g.T;
    return g.sa + g.v1 * tau + ((g.v2 - g.v1) / 2) * (tau - Math.sin(w * tau) / w);
  };
  const vIn = (g, tau) => (g.v1 === g.v2 ? g.v1 : g.v1 + (g.v2 - g.v1) * (1 - Math.cos((Math.PI * tau) / g.T)) / 2);
  const aIn = (g, tau) => (g.v1 === g.v2 ? 0 : ((g.v2 - g.v1) * Math.PI) / (2 * g.T) * Math.sin((Math.PI * tau) / g.T));
  const tauOf = (g, s) => {
    if (g.v1 === g.v2) return (s - g.sa) / g.v1;
    // Newton on a monotonic function, kept inside a bracket
    let a = 0, b = g.T, tau = ((s - g.sa) / (g.sb - g.sa)) * g.T;
    for (let i = 0; i < 60; i++) {
      const f = sIn(g, tau) - s;
      if (Math.abs(f) < 1e-10) break;
      if (f > 0) b = tau; else a = tau;
      const next = tau - f / vIn(g, tau);
      tau = next > a && next < b ? next : (a + b) / 2;
    }
    return tau;
  };
  const clampS = (s) => (s < s0 ? s0 : s > s1 ? s1 : s);
  const clampT = (x) => (x < 0 ? 0 : x > total ? total : x);

  return {
    zones, segments: segs, total, s0, s1,
    /** Seconds from the route start to reach s. */
    timeOf(s) { s = clampS(s); const g = find('sa', s); return g.ta + tauOf(g, s); },
    /** s reached after tau seconds. */
    sOf(tau) { tau = clampT(tau); const g = find('ta', tau); return Math.min(g.sb, sIn(g, tau - g.ta)); },
    speedOf(s) { s = clampS(s); const g = find('sa', s); return vIn(g, tauOf(g, s)); },
    accelOf(s) { s = clampS(s); const g = find('sa', s); return aIn(g, tauOf(g, s)); },
  };
}

/** Smootherstep (the quintic of a lane change): continuous to the second derivative. */
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (u * (u * 6 - 15) + 10));

/** Centre offset of the lane with this id at s; where there is none, the nearest lane by number. */
function laneCentre(road, id, s) {
  const lanes = edgesAt(road, s).strips.filter((st) => st.kind === 'lane');
  const st = lanes.find((x) => x.id === id) || lanes[Math.min(Math.max(1, id), lanes.length) - 1];
  return (st.left + st.right) / 2;
}

/** The route's lane plan, checked: [{ s0, lane }, { s0, s1, lane }, ...], or one entry from route.lane. */
export function lanePlanOf(route) {
  const plan = Array.isArray(route.lanePlan) && route.lanePlan.length ? route.lanePlan : [{ s0: route.s0 ?? 0, lane: route.lane ?? 1 }];
  let last = -Infinity;
  return plan.map((e, i) => {
    if (!Number.isInteger(e?.lane) || e.lane < 1) throw new Error(`lane plan entry ${i} has no lane`);
    if (i > 0 && !(Number.isFinite(e.s0) && Number.isFinite(e.s1) && e.s1 > e.s0 && e.s0 >= last)) throw new Error(`lane plan entry ${i} needs s0 < s1, after the previous change`);
    last = i > 0 ? e.s1 : -Infinity;
    return { s0: e.s0, s1: i > 0 ? e.s1 : e.s0, lane: e.lane };
  });
}

/**
 * @param {{ route: object, road: object, frame: object, departMs: number, startS?: number, city?: string }} opts
 *   route is one entry of routes.json; road is the decoded road it names; frame from createFrame(city).
 */
export function createJourney({ route, road, frame, departMs, startS, city }) {
  const s0 = route.s0 ?? 0;
  const s1 = route.s1 ?? road.length;
  const refline = createRefline(road);
  const profile = createSpeedProfile(road, s0, s1);
  const clampS = (s) => (s < s0 ? s0 : s > s1 ? s1 : s);
  const start = clampS(Number.isFinite(startS) ? startS : s0);
  let depart = departMs;

  const plan = lanePlanOf(route);
  /** Index of the plan entry in force at s (a change counts from its s0). */
  const entryAt = (s) => {
    let k = 0;
    while (k + 1 < plan.length && s >= plan[k + 1].s0) k++;
    return k;
  };
  /** Lateral offset of the car at s, and the lane it counts as in. */
  const placeAt = (s) => {
    const k = entryAt(s);
    const e = plan[k];
    const to = laneCentre(road, e.lane, s);
    if (k === 0 || s >= e.s1) return { d: to, lane: e.lane };
    const from = laneCentre(road, plan[k - 1].lane, s);
    const u = (s - e.s0) / (e.s1 - e.s0);
    return { d: from + (to - from) * ease(u), lane: u < 0.5 ? plan[k - 1].lane : e.lane };
  };
  const offsetAt = (s) => placeAt(s).d;
  const offsetSlope = (s) => (offsetAt(s + 0.01) - offsetAt(s - 0.01)) / 0.02;
  /** Lane number from the left (1-based) of lane id at s, among the lanes of the section there. */
  const laneNumber = (id, s) => {
    const cs = edgesAt(road, s);
    const k = cs.section.lanes.findIndex((l) => l.id === id);
    if (k >= 0) return k + 1;
    return Math.min(Math.max(1, id), cs.section.lanes.length);
  };

  const r = {};
  /** Road surface at s and lateral offset d (positive left), scene axes. */
  function surface(s, d, out) {
    refline.at(s, r);
    const c = Math.cos(r.heading), sn = Math.sin(r.heading);
    const x = r.x - sn * d, y = r.y + c * d;
    return out.set(x, frame.sceneY(r.h + r.crossfall * d, x, y), -y);
  }

  const tStart = () => profile.timeOf(start);
  const timeAt = (s) => depart + (profile.timeOf(s) - tStart()) * 1000;
  const tauAt = (simMs) => (simMs - depart) / 1000 + tStart();
  const sAt = (simMs) => profile.sOf(tauAt(simMs));

  const pa = new Vector3(), pb = new Vector3();
  /** Pose at s, with speed and acceleration given. */
  function pose(s, speed, accel) {
    s = clampS(s);
    const place = placeAt(s);
    const d = place.d;
    const position = surface(s, d, new Vector3());
    const { curvature, grade, crossfall } = refline.at(s, r);
    // tangent of the car's actual path: grade, lateral easing and earth curvature included
    const e = 0.25;
    const sa = Math.max(0, s - e), sb = Math.min(road.length, s + e);
    surface(sa, offsetAt(sa), pa);
    surface(sb, offsetAt(sb), pb);
    const forward = new Vector3().subVectors(pb, pa).normalize();
    surface(s, d + e, pb);
    surface(s, d - e, pa);
    const left = pb.sub(pa); // P(d + e) - P(d - e)
    const up = new Vector3().crossVectors(forward, left).normalize();
    const right = new Vector3().crossVectors(forward, up).normalize();
    return {
      s, lane: laneNumber(place.lane, s), laneId: place.lane, lateral: d - laneCentre(road, place.lane, s), position, forward, up, right,
      speed, accel, curvature, grade, crossfall,
      /** Rate of lateral drift, metres per metre; the body layer will want it. */
      lateralSlope: offsetSlope(s),
    };
  }

  const journey = {
    id: city ? `${city}/${route.id}` : route.id,
    route,
    road,
    profile,
    s0, s1, startS: start,
    length: route.length ?? s1 - s0,
    /** Travel time over the whole route, ms. */
    duration: profile.total * 1000,
    reveal: route.reveal ?? null,
    starts: route.starts ?? {},
    markers: (route.markers || []).map((m) => ({ ...m })).sort((p, q) => p.s - q.s),
    /** The lane plan the car follows: [{ s0, lane }, { s0, s1, lane }, ...], lanes by RoadNet id. */
    lanePlan: plan.map((e) => ({ ...e })),
    /** Lateral offset of the car from the reference line at s (positive left), metres. */
    offsetAt,
    /** Simulation time (UTC ms) at startS. */
    get departMs() { return depart; },
    sAt,
    timeAt,
    speedAt: (s) => profile.speedOf(s),
    /**
     * Pose at a simulation time. The route starts in a live lane, so at and before departure the car
     * is already at the posted speed at s0 (no standing start: epoch-ms rounding puts the start chip
     * a hair either side of departure). After arrival it holds at s1, speed 0.
     */
    poseAt(simMs) {
      const tau = tauAt(simMs);
      const moving = tau <= profile.total;
      const s = profile.sOf(tau);
      return pose(s, moving ? profile.speedOf(s) : 0, moving ? profile.accelOf(s) : 0);
    },
    poseAtS: (s) => pose(s, profile.speedOf(s), profile.accelOf(s)),
    /** Re-time the journey so that s falls at simMs (the hold-position lock). */
    rebase(s, simMs) { depart = simMs - (profile.timeOf(s) - tStart()) * 1000; },
  };
  return journey;
}

// Flow as a continuous function of simulation time (plan 02, section 5.8; D6.2).
//
// The traffic file gives, per segment, 168 hour-of-week means per season in the city's local time.
// Simulation time is UTC milliseconds. This module turns the table into:
//
//   flow(t)        vehicles per hour, continuous (no step at the hour), never negative, and with the
//                  mean over every UTC hour equal to the table value of the local hour it falls in;
//   cumulative(t)  vehicles counted since a fixed reference (local midnight, 1 January of a given
//                  year; the demand surface uses the file's year), so the
//                  count is the same number however it is reached (no window, no integration order).
//
// Hours: each UTC hour H takes the local hour that contains its midpoint, so with whole-hour offsets
// (Las Vegas) a UTC hour is exactly one local hour. Across a daylight-saving change the sequence of
// UTC hours simply reads the local hours as they happen: in spring local 02:00 never occurs (its
// table value is skipped), in autumn local 01:00 occurs twice (its value is used for both hours).
// The season is that of the local month (seasonOfMonth).
//
// Within an hour the flow is piecewise linear through three points: b(H) at the hour's start,
// m(H) at its middle and b(H+1) at its end, with b(H) between the two hours' values and m(H) chosen
// so that the hour's mean is the table value: (b(H) + 2 m(H) + b(H+1)) / 4 = q(H). b(H) is the
// average of q(H-1) and q(H), limited to 2·min(q(H-1), q(H)), which keeps m(H) >= 0.
//
// Pure: no DOM, no three.js. Intl.DateTimeFormat is the only clock.

export const HOUR_MS = 3600000;
export const HOURS_PER_WEEK = 168;
/** Default reference: cumulative counts start at the first hour of January 2020 (local). */
const REF_MONTH = 2020 * 12;

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of local time from UTC at this instant, ms (Las Vegas: -8 h in winter, -7 h in summer). */
export function tzOffsetMs(utcMs, tz) {
  const v = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) v[p.type] = p.value;
  const asUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Is tz a time zone Intl knows? */
export function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

const mod = (a, n) => ((a % n) + n) % n;

/** Local fields of an instant: day 0 = Monday. */
function localFields(utcMs, offMs) {
  const L = utcMs + offMs;
  const days = Math.floor(L / 86400000);
  const d = new Date(L);
  return {
    day: mod(days + 3, 7), // 1970-01-01 was a Thursday
    hour: Math.floor(mod(L, 86400000) / HOUR_MS),
    month: d.getUTCMonth(),
    monthIndex: d.getUTCFullYear() * 12 + d.getUTCMonth(),
  };
}

/**
 * Hour of week of an instant in a time zone: 24 * day + hour, day 0 = Monday, local time.
 * @param {number} utcMs  @param {string} tz
 */
export function hourOfWeek(utcMs, tz) {
  const f = localFields(utcMs, tzOffsetMs(utcMs, tz));
  return 24 * f.day + f.hour;
}

/**
 * A clock for one time zone and season map: what local hour (and season) each UTC hour is, and the
 * runs of UTC hours inside one local month over which the hour of week simply counts up.
 * Results are cached; one clock serves every segment of a file.
 */
export function createClock(tz, seasonOfMonth) {
  if (!isTimeZone(tz)) throw new Error(`traffic: unknown time zone ${tz}`);
  const hours = new Map();
  const runsCache = new Map();
  const startCache = new Map();

  /** Facts of UTC hour H (H = floor(utcMs / HOUR_MS)), taken at its midpoint. */
  function hour(H) {
    let h = hours.get(H);
    if (!h) {
      if (hours.size > 200000) hours.clear();
      const mid = H * HOUR_MS + HOUR_MS / 2;
      const off = tzOffsetMs(mid, tz);
      const f = localFields(mid, off);
      h = { off, how: 24 * f.day + f.hour, month: f.month, monthIndex: f.monthIndex, season: seasonOfMonth[f.month] };
      hours.set(H, h);
    }
    return h;
  }

  /** First UTC hour of local month mi (its midpoint is in the month). */
  function monthStart(mi) {
    let H = startCache.get(mi);
    if (H !== undefined) return H;
    const L = Date.UTC(Math.floor(mi / 12), mod(mi, 12), 1);
    H = Math.floor((L - tzOffsetMs(L, tz)) / HOUR_MS);
    while (hour(H - 1).monthIndex >= mi) H--;
    while (hour(H).monthIndex < mi) H++;
    startCache.set(mi, H);
    return H;
  }

  /** Runs [h0, h1) of constant offset within local month mi: { h0, h1, how0, season }. */
  function runs(mi) {
    let r = runsCache.get(mi);
    if (r) return r;
    const a = monthStart(mi), b = monthStart(mi + 1);
    const cuts = [];
    const split = (lo, hi) => { // [lo, hi), hi > lo
      if (hi - lo > 192) { const m = (lo + hi) >> 1; split(lo, m); split(m, hi); return; }
      if (hour(lo).off === hour(hi - 1).off) return;
      let x = lo, y = hi - 1; // off(x) != off(y): first hour with off(y)
      while (y - x > 1) { const m = (x + y) >> 1; if (hour(m).off === hour(lo).off) x = m; else y = m; }
      cuts.push(y);
      split(y, hi);
    };
    split(a, b);
    const bounds = [a, ...[...new Set(cuts)].sort((p, q) => p - q), b];
    r = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const h = hour(bounds[i]);
      r.push({ h0: bounds[i], h1: bounds[i + 1], how0: h.how, season: h.season });
    }
    runsCache.set(mi, r);
    return r;
  }

  return { tz, seasonOfMonth, hour, monthStart, runs };
}

/**
 * The flow of one segment: table[season][hourOfWeek] in vehicles per hour.
 * @param {number[][]} table 4 x 168
 * @param {ReturnType<typeof createClock>} clock
 */
export function createSegmentFlow(table, clock, refMonth = REF_MONTH) {
  const seasons = table.length;
  const prefix = [];
  const total = [];
  for (let s = 0; s < seasons; s++) {
    const p = new Float64Array(HOURS_PER_WEEK + 1);
    for (let h = 0; h < HOURS_PER_WEEK; h++) p[h + 1] = p[h] + table[s][h];
    prefix.push(p);
    total.push(p[HOURS_PER_WEEK]);
  }
  /** Sum of n consecutive hours of week starting at how0 in season s (wrapping). */
  function runSum(s, how0, n) {
    const p = prefix[s];
    const full = Math.floor(n / HOURS_PER_WEEK);
    let rest = n - full * HOURS_PER_WEEK;
    let sum = full * total[s];
    if (how0 + rest <= HOURS_PER_WEEK) sum += p[how0 + rest] - p[how0];
    else sum += p[HOURS_PER_WEEK] - p[how0] + p[how0 + rest - HOURS_PER_WEEK];
    return sum;
  }
  const monthTotal = (mi) => clock.runs(mi).reduce((a, r) => a + runSum(r.season, r.how0, r.h1 - r.h0), 0);

  // cumulative count at the first hour of each local month, chained from refMonth in a fixed order
  const fwd = [0]; // fwd[i] = S at month refMonth + i
  const back = [0]; // back[i] = S at month refMonth - i
  function monthBase(mi) {
    const i = mi - refMonth;
    if (i >= 0) { while (fwd.length <= i) fwd.push(fwd[fwd.length - 1] + monthTotal(refMonth + fwd.length - 1)); return fwd[i]; }
    while (back.length <= -i) back.push(back[back.length - 1] - monthTotal(refMonth - back.length));
    return back[-i];
  }

  /** Vehicles counted from the reference to the start of UTC hour H (the sum of whole hours). */
  function countTo(H) {
    const mi = clock.hour(H).monthIndex;
    let S = monthBase(mi);
    for (const r of clock.runs(mi)) {
      if (H >= r.h1) S += runSum(r.season, r.how0, r.h1 - r.h0);
      else { S += runSum(r.season, r.how0, H - r.h0); break; }
    }
    return S;
  }
  /** Table value of UTC hour H, vehicles per hour. */
  const q = (H) => { const h = clock.hour(H); return table[h.season][h.how]; };
  /** Flow at the start of hour H. */
  const edge = (H) => { const a = q(H - 1), b = q(H); return Math.min((a + b) / 2, 2 * Math.min(a, b)); };

  return {
    q, edge, countTo, runSum,
    /** Largest flow the continuous curve reaches over any hour with in-season neighbours (vph). */
    peak() {
      let best = 0;
      for (let s = 0; s < seasons; s++) {
        const t = table[s];
        for (let h = 0; h < HOURS_PER_WEEK; h++) {
          const p = t[mod(h - 1, 168)], c = t[h], n = t[mod(h + 1, 168)];
          const b0 = Math.min((p + c) / 2, 2 * Math.min(p, c)), b1 = Math.min((c + n) / 2, 2 * Math.min(c, n));
          best = Math.max(best, b0, 2 * c - (b0 + b1) / 2);
        }
      }
      return best;
    },
    /**
     * Hourly arrays for UTC hours [H0, H1]: a function pair flowAt(tSec) (vph) and countAt(tSec)
     * (vehicles), valid for tSec in [H0, H1 + 1) hours. Allocation happens here, not per call.
     */
    span(H0, H1) {
      const n = H1 - H0 + 1;
      const S = new Float64Array(n), b = new Float64Array(n + 1), m = new Float64Array(n);
      for (let i = 0; i <= n; i++) b[i] = edge(H0 + i);
      for (let i = 0; i < n; i++) {
        S[i] = countTo(H0 + i);
        m[i] = 2 * q(H0 + i) - (b[i] + b[i + 1]) / 2;
      }
      const locate = (tSec) => {
        const x = tSec / 3600 - H0;
        let i = Math.floor(x);
        if (i < 0) i = 0; else if (i >= n) i = n - 1;
        return i;
      };
      return {
        H0, H1,
        flowAt(tSec) {
          const i = locate(tSec);
          const u = tSec / 3600 - H0 - i;
          return u < 0.5 ? b[i] + (m[i] - b[i]) * 2 * u : m[i] + (b[i + 1] - m[i]) * 2 * (u - 0.5);
        },
        countAt(tSec) {
          const i = locate(tSec);
          const u = tSec / 3600 - H0 - i;
          if (u < 0.5) return S[i] + b[i] * u + (m[i] - b[i]) * u * u;
          const v = u - 0.5;
          return S[i] + (b[i] + m[i]) / 4 + m[i] * v + (b[i + 1] - m[i]) * v * v;
        },
      };
    },
  };
}

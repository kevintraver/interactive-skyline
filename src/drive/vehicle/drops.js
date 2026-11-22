// Drops on the windshield (plan 02, D8.2): the rules, in JavaScript, as closed-form functions of simulation time and a
// hash. No three.js, no state carried from frame to frame but caches of pure values. glassRain.glsl.js evaluates the
// same rules per drop on the GPU (its vertex shader is evalSite below, line for line); this file is what the unit tests
// check and what dropCount counts.
//
// Why closed form, not the plan's ping-pong simulation re-warmed after a seek: the drive holds every frame to be a pure
// function of simulation time (pause, scrub both ways, 0.25x to 16x). A simulation re-warmed from a fixed time before
// "now" on every jump would have to re-run several seconds of steps whenever the clock moves backward or by more than
// a frame, which is every frame while scrubbing, and a playing 16x clock would step 0.27 s at a time. Here the glass at
// time t is computed from t alone, so seeking away and back gives the same glass by construction, and the cost does not
// depend on how time moved.
//
// The model: the glass (glass metres: x from the left along the bottom, y up the glass) is divided into sites, a grid of
// cells SITE_M across (glassPresets.js). Time is cut into bins of BIN_S on an absolute grid (bin k spans [k, k+1) x
// BIN_S seconds since the epoch). In each bin, each site receives 0, 1 or 2 arrivals: two Bernoulli trials with
// probability lambda / 2 each, lambda the expected arrivals per site in that bin, decided by a hash of (site, k), at a
// hashed time inside the bin. An arrival is a unit of water, a 2 mm drop's volume (UNIT_M3).
//   Arrival rate (drops per second on the whole glass):
//       rate = (R / 3.6e6) / v_fall x A x max(0, -n . v_rel) / UNIT_M3
//   R the rain rate (mm/h; R / 3.6e6 is the water's volume flux through a still horizontal surface, m/s), v_fall the
//   drops' fall speed (rainMirror.js, the 1.8 mm class: 6.2 m/s), A the glass's area, n its outward normal and v_rel the
//   rain's velocity relative to the car (rainMirror.js relativeRain). A |n . v_rel^| is the glass's projected area along
//   the relative wind; times |v_rel| / v_fall it is the volume of falling rain the glass sweeps per second. So the rate
//   is proportional to the rain rate times the projected area along the relative wind (and the relative speed): more at
//   speed (about 4.5 times at 108 km/h than standing, for this glass raked 36 degrees from the horizontal).
//   lambda for bin k = rate(t_k) x BIN_S / sites, from the car's pose and the weather at the bin's start (glassRain.js),
//   so a bin's arrivals never change once it is past.
// Each site holds one sitting drop: the arrivals since its epoch merge into it (radius R0_M x SIZE_GAIN x n^(1/3) for n
// units; merging by accretion: ASSUMED in place of drops meeting by chance). Its epoch begins at the later of the last
// wiper pass over the site and the site's last renewal (every RENEW_S at a hashed phase, a bound on how long a drop
// outside the wiped area can sit; it fades over its last RENEW_FADE_S). It appears where its first arrival landed
// (a hash of the site and that arrival's bin).
// Running: once a sitting drop holds nRun units it runs. nRun is N_RUN_MIN..N_RUN_MIN+N_RUN_SPAN-1 per site at low speed
// (ASSUMED; 4 to 10 units, 1.6 to 2.2 mm in radius before the size gain) and falls with the airflow:
//       nRun(v) = max(1, round(nRun0 / (1 + RUN_SPEED_K x max(0, (v / V_CRIT)^2 - 1))))
// A runner moves along the glass at
//       vy = V_RUN x clamp((v / V_CRIT)^2 - 1, -1, 3)   (down at rest, up above V_CRIT),  vx = SIDE x s x |vy|
// v the car's speed, V_CRIT 60 km/h (the plan's "upward above about 60 km/h": the air's drag on a drop grows with the
// square of the speed and balances the weight's component down the glass there), V_RUN 0.12 m/s (ASSUMED: a running
// drop on glass), s = the drop's offset from the glass's middle over half its width (outward: the airflow spreads toward
// the pillars, and drops run down and out at rest; ASSUMED). The path is integrated analytically: glassRain.js keeps the
// running integral D(t) = integral of vy dt per bin, so a runner born at t0 is at start + (SIDE s (Da(t) - Da(t0)),
// Dy(t) - Dy(t0)). A runner lives RUN_LIFE_S at most (it runs out of water; fades over its last 0.6 s), until it leaves
// the glass, or until the next blade pass over where it is. Each site shows its latest two runners.
// Lifetime: every drop ends at the next wiper pass that reaches its place (wipers.js passAgoAt): a drop born before the
// last pass over its place is gone.

import { passAgoAt } from './wipers.js';

export const DROP = Object.freeze({
  /** One arrival's water: a 2 mm drop, m^3. */
  UNIT_M3: (4 / 3) * Math.PI * 1e-9,
  BIN_S: 0.5,
  /** Bins in the window the GPU sees (the newest is the current one): 32 s. */
  BINS: 64,
  RENEW_S: 20,
  RENEW_FADE_S: 1.5,
  N_RUN_MIN: 4,
  N_RUN_SPAN: 7,
  V_CRIT: 60 / 3.6,
  RUN_SPEED_K: 1.5,
  V_RUN: 0.12,
  SIDE: 0.3,
  RUN_LIFE_S: 3,
  /** A unit's radius (m) and how much larger drops are drawn than they are (ASSUMED: at 1280 pixels across, the glass is
   * drawn at about 1.5 mm a pixel, so a real 2 mm drop would be one or two pixels and its lens unreadable; drawn 2.4
   * times larger, a unit is three pixels and a merged drop six to ten). */
  R0_M: 0.001,
  SIZE_GAIN: 2.4,
  /** A sitting drop's place is jittered over this share of its cell. */
  JITTER: 0.8,
});


/**
 * The glass from the windshield's corners (cabin coordinates, as cabin.json gives them: x right, y up, -z forward).
 * @returns {{ W: number, H: number, area: number, normalCar: number[] }} normalCar: the outward normal in the car's
 *   frame (x right, y up, z forward), as relativeRain gives velocities
 */
export function glassOf(corners) {
  const p = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
  const BL = p(corners.bottomLeft), BR = p(corners.bottomRight), TR = p(corners.topRight), TL = p(corners.topLeft);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const W = len(sub(BR, BL)), H = len(sub(TL, BL));
  // the area of the (planar) quadrilateral: half the cross product of its diagonals
  const area = len(cross(sub(TR, BL), sub(TL, BR))) / 2;
  let n = cross(sub(BR, BL), sub(TL, BL));
  const l = len(n); n = n.map((x) => x / l);
  if (n[1] < 0) n = n.map((x) => -x); // outward: up and forward
  return { W, H, area, normalCar: [n[0], n[1], -n[2]] };
}

/** The glass's projected area along a velocity (m^2): A |n . v^|. */
export function projectedArea(glass, v) {
  const s = Math.hypot(v[0], v[1], v[2]);
  if (!(s > 0)) return 0;
  const n = glass.normalCar;
  return (glass.area * Math.abs(n[0] * v[0] + n[1] * v[1] + n[2] * v[2])) / s;
}

/**
 * Drops arriving on the glass per second (units of UNIT_M3) at rain rate R (mm/h) for the rain's velocity relative to
 * the car (car frame, m/s) and its fall speed. Zero when the rain meets the glass from behind.
 */
export function arrivalRate(R, velocityCar, glass, fallMps) {
  if (!(R > 0) || !(fallMps > 0)) return 0;
  const n = glass.normalCar, v = velocityCar;
  const into = -(n[0] * v[0] + n[1] * v[1] + n[2] * v[2]);
  if (!(into > 0)) return 0;
  return ((R / 3.6e6 / fallMps) * glass.area * into) / DROP.UNIT_M3;
}

/** A runner's speed up the glass (m/s; negative down) at car speed v (m/s). */
export function runSpeed(v) {
  const x = (v / DROP.V_CRIT) ** 2 - 1;
  return DROP.V_RUN * Math.min(3, Math.max(-1, x));
}

/** The sites: a grid of cells about siteM across. */
export function siteLayout(glass, siteM) {
  const nx = Math.max(1, Math.round(glass.W / siteM)), ny = Math.max(1, Math.round(glass.H / siteM));
  return { nx, ny, count: nx * ny, W: glass.W, H: glass.H, cw: glass.W / nx, ch: glass.H / ny };
}

/** The hash both sides use: three integers to [0, 1), 24 bits (exact in a float32). */
export function hash3(a, b, c) {
  let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

/** Site i's arrivals in absolute bin k for lambda expected arrivals: { n: 0..2, f: the time in the bin, 0..1 }. */
export function siteArrivals(i, k, lambda) {
  const p = Math.min(1, lambda / 2);
  const n = (hash3(i, k, 1) < p ? 1 : 0) + (hash3(i, k, 2) < p ? 1 : 0);
  return { n, f: hash3(i, k, 3) };
}

// ---------------------------------------------------------------- the window of bins
/**
 * The bins the GPU sees for simulation time tSec: per bin [lambda, Dy at its start, Da at its start, vy], the newest bin
 * the one holding tSec. `source(k)` gives { lambda, vy } for absolute bin k; it must be a pure function of k (and of
 * whatever the cache key names). Values are cached per k; a new key empties the cache.
 */
export function createBinWindow(source, bins = DROP.BINS) {
  const cache = new Map();
  let key = null;
  const data = new Float32Array(4 * bins);
  return {
    data,
    /** @returns {{ k0: number, tw: number, renewOffset: number, data: Float32Array }} tw: seconds since bin k0's start */
    at(tSec, k = key) {
      if (k !== key) { cache.clear(); key = k; }
      const kNow = Math.floor(tSec / DROP.BIN_S);
      const k0 = kNow - (bins - 1);
      let dy = 0, da = 0;
      for (let j = 0; j < bins; j++) {
        const kk = k0 + j;
        let v = cache.get(kk);
        if (!v) { v = source(kk); cache.set(kk, v); }
        data[4 * j] = v.lambda; data[4 * j + 1] = dy; data[4 * j + 2] = da; data[4 * j + 3] = v.vy;
        dy += v.vy * DROP.BIN_S; da += Math.abs(v.vy) * DROP.BIN_S;
      }
      if (cache.size > 3 * bins) for (const kk of cache.keys()) if (kk < k0 - 4) cache.delete(kk);
      const tw = tSec - k0 * DROP.BIN_S;
      // where the sites' renewal clock stands at the window's start (exact: k0 x BIN_S is a multiple of 0.5)
      const renewOffset = (((k0 * DROP.BIN_S) % DROP.RENEW_S) + DROP.RENEW_S) % DROP.RENEW_S;
      return { k0, tw, renewOffset, data };
    },
    get size() { return cache.size; },
  };
}

/** The running drift at window time tw: [Dy, Da]. */
function drift(data, tw, bins) {
  const j = Math.min(bins - 1, Math.max(0, Math.floor(tw / DROP.BIN_S)));
  const dt = tw - j * DROP.BIN_S, vy = data[4 * j + 3];
  return [data[4 * j + 1] + dt * vy, data[4 * j + 2] + dt * Math.abs(vy)];
}

const anchorOf = (i, k, cx, cy, L) => [
  cx + (hash3(i, k, 4) - 0.5) * L.cw * DROP.JITTER,
  cy + (hash3(i, k, 5) - 0.5) * L.ch * DROP.JITTER,
];

/**
 * Site i's drops at the window's time: [{ kind: 'sit' | 'run', x, y, r, alpha, born, n, dir? }].
 * @param {number} i
 * @param {{ layout: object, win: { k0, tw, renewOffset, data }, wipe: { phase, sched }, wipers: readonly object[] }} S
 */
export function evalSite(i, S) {
  const { layout: L, win, wipe, wipers } = S;
  const bins = win.data.length / 4;
  const { tw, data } = win;
  const ix = i % L.nx, iy = Math.floor(i / L.nx);
  const cx = (ix + 0.5) * L.cw, cy = (iy + 0.5) * L.ch;
  const passAgo = (x, y) => passAgoAt(x, y, wipe.phase, wipe.sched, wipers);
  const Lc = passAgo(cx, cy);
  const since = (((win.renewOffset + tw - hash3(i, 81, 7) * DROP.RENEW_S) % DROP.RENEW_S) + DROP.RENEW_S) % DROP.RENEW_S;
  const e = Math.max(tw - Lc, tw - since, 0);
  const nRun0 = DROP.N_RUN_MIN + Math.floor(hash3(i, 82, 7) * DROP.N_RUN_SPAN);
  const j0 = Math.max(0, Math.floor(e / DROP.BIN_S)), j1 = Math.min(bins - 1, Math.floor(tw / DROP.BIN_S));
  let n = 0, firstK = 0, born = 0;
  const runs = []; // latest last
  for (let j = j0; j <= j1; j++) {
    const k = (win.k0 + j) >>> 0;
    const a = siteArrivals(i, k, data[4 * j]);
    if (!a.n) continue;
    const ta = (j + a.f) * DROP.BIN_S;
    if (ta <= e || ta > tw) continue;
    if (n === 0) { firstK = k; born = ta; }
    n += a.n;
    const x = data[4 * j + 3] / DROP.V_RUN;
    const nRun = Math.max(1, Math.round(nRun0 / (1 + DROP.RUN_SPEED_K * Math.max(0, x))));
    if (n >= nRun) { runs.push({ t: ta, k: firstK, n }); if (runs.length > 2) runs.shift(); n = 0; }
  }
  const out = [];
  const radius = (units) => DROP.R0_M * DROP.SIZE_GAIN * Math.cbrt(units);
  if (n > 0) {
    const [x, y] = anchorOf(i, firstK, cx, cy, L);
    const alive = !(passAgo(x, y) < tw - born);
    const alpha = Math.min(1, (DROP.RENEW_S - since) / DROP.RENEW_FADE_S);
    if (alive && alpha > 0) out.push({ kind: 'sit', x, y, r: radius(n), alpha, born, n });
  }
  if (runs.length) {
    const now = drift(data, tw, bins);
    const vyNow = data[4 * Math.min(bins - 1, Math.floor(tw / DROP.BIN_S)) + 3];
    for (const run of runs) {
      const age = tw - run.t;
      if (age > DROP.RUN_LIFE_S) continue;
      const [sx, sy] = anchorOf(i, run.k, cx, cy, L);
      const side = (sx - L.W / 2) / (L.W / 2);
      const then = drift(data, run.t, bins);
      const x = sx + DROP.SIDE * side * (now[1] - then[1]), y = sy + (now[0] - then[0]);
      if (x < 0 || x > L.W || y < 0 || y > L.H) continue;
      if (passAgo(x, y) < age) continue;
      const alpha = Math.min(1, (DROP.RUN_LIFE_S - age) / 0.6);
      out.push({ kind: 'run', x, y, r: 0.85 * radius(run.n), alpha, born: run.t, n: run.n, dir: [DROP.SIDE * side * Math.abs(vyNow), vyNow] });
    }
  }
  return out;
}

/** Every drop on the glass (the JavaScript mirror of the GPU's drops). */
export function glassDrops(S) {
  const out = [];
  for (let i = 0; i < S.layout.count; i++) for (const d of evalSite(i, S)) out.push({ site: i, ...d });
  return out;
}


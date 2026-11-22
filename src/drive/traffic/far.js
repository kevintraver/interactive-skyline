// Every vehicle out to the sprite range, at a flat per-frame cost (plan 02, D6.4). Pure: no three.js.
//
// The route is cut into tiles of TILE_M of chainage. A tile's vehicles (both directions) are placed exactly
// (fleet.place, no visitor's car) at a quantised time t_q, and kept; each frame moves every kept vehicle on from
// t_q to t: ds = v dt + a dt^2 / 2 of route chainage (a its acceleration at t_q, from demand.js; lane speeds change
// smoothly, reference.js eases every step, so the error is the jerk's: centimetres), and put on its lane's centre
// line at the new chainage as the fleet does (where bodies are drawn), or, far away where only lamps are, by the
// expansion p + F dr + N kappa dr^2 / 2 + N (d(s) - d_q - d'_q dr) (dr along its own road, N its left normal,
// kappa its curvature, the last term the lane's own offset: blends, tapers), which errs by half a metre at worst
// over a quantum (a vertical curve, a clothoid through an interchange): under a pixel beyond the bodies.
// t_q = Q floor((t - phase) / Q) + phase, with a phase per tile (PHASES of them), so a tile is re-placed every Q of
// simulation time and tiles take turns: a frame re-places about tiles x frame time / Q of them.
// Opacity is worked out again at the moved-on place: the lane map's weight there times the ramp fade from where
// the vehicle joined and where it will leave (demand.js vehiclesIn with lookaheadS); the vehicles that join by a
// ramp during the quantum are in the tile already, at opacity 0 until they cross the boundary.
// A tile's content is a pure function of (tile, t_q), so scrubbing either way and seeking give the same picture;
// the kept tiles are only a cache. Tiles are placed at different times (their phases), so which tile lists a
// vehicle is decided now, not then: a tile places its stretch with a margin of MARGIN_S of the fastest travel
// either side, and gives only the vehicles whose moved-on place is inside its own stretch. Every tile moves a
// vehicle to the same place (within centimetres), so the union has no gap and no double.

import { createFleet } from './fleet.js';

export const TILE_M = 500;
export const QUANTUM_MS = 2000;
const PHASES = 8;
/** Seconds of travel at MAX_SPEED placed beyond a tile's ends (a quantum and some). */
const MAX_SPEED = 45;
const OUT = {
  pos: [Float64Array, 3], fwd: [Float32Array, 3], up: [Float32Array, 3], s: [Float64Array, 1], speed: [Float32Array, 1],
  id: [Float64Array, 1], k: [Float64Array, 1], body: [Uint8Array, 1], colour: [Uint32Array, 1], brake: [Uint8Array, 1],
  alpha: [Float32Array, 1], dir: [Uint8Array, 1], lane: [Uint8Array, 1],
};

/**
 * @param {{ traffic: object, laneMap: object, frame: object, lengths: number[], earthR: number, tileM?: number, quantumMs?: number }} opts
 */
export function createFarField({ traffic, laneMap, frame, lengths, earthR, tileM = TILE_M, quantumMs = QUANTUM_MS }) {
  const fleet = createFleet({ traffic, laneMap, frame, lengths, earthR });
  const [S0, S1] = traffic.range;
  const tiles = new Map(); // tile index -> { q, tq, n, arrays }
  const r = {}, lm = { sRoad: 0, d: 0, dds: 0, w: 0 };
  const ldW = laneMap.dirs.with, ldA = laneMap.dirs.against;
  const out = { count: 0, capacity: 0, pos: null, fwd: null, up: null, s: null, speed: null, id: null, k: null, body: null, colour: null, brake: null, alpha: null, dir: null, lane: null };
  function grow(n) {
    for (const [k, [T, w]] of Object.entries(OUT)) {
      const a = new T(n * w);
      if (out.capacity) a.set(out[k].subarray(0, out.count * w));
      out[k] = a;
    }
    out.capacity = n;
  }
  grow(1024);
  const stats = { tiles: 0, built: 0, count: 0, buildMs: 0 };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function buildTile(i, q, tq) {
    const sA = S0 + i * tileM, sB = Math.min(S1, sA + tileM);
    const margin = MAX_SPEED * (quantumMs / 1000) * 1.1;
    const p = fleet.place(tq, sA - margin, sB + margin, null, { lookaheadS: (quantumMs / 1000) * 1.05 });
    const n = p.count;
    const c3 = (a) => a.slice(0, 3 * n), c1 = (a) => a.slice(0, n);
    // one literal, so every tile has the same shape (fast property reads in the per-frame loop)
    const t = {
      q, n, tq, sA, sB: sB >= S1 ? Infinity : sB, sLo: sA <= S0 ? -Infinity : sA,
      pos: c3(p.pos), fwd: c3(p.fwd), up: c3(p.up),
      s: c1(p.s), speed: c1(p.speed), id: c1(p.id), k: c1(p.k), body: c1(p.body), colour: c1(p.colour), brake: c1(p.brake),
      dir: c1(p.dir), lane: c1(p.lane), join: c1(p.join), leave: c1(p.leave), fadeM: c1(p.fadeM), acc: c1(p.acc),
      d: c1(p.d), dds: c1(p.dds), sRoad: c1(p.sRoad),
      // the road's left normal N (scene axes) and its curvature, per vehicle
      nrm: new Float32Array(3 * n), kap: new Float32Array(n),
    };
    for (let v = 0; v < n; v++) {
      const ld = t.dir[v] === 0 ? ldW : ldA;
      ld.refline.at(t.sRoad[v], r);
      t.nrm[3 * v] = -Math.sin(r.heading); t.nrm[3 * v + 1] = 0; t.nrm[3 * v + 2] = -Math.cos(r.heading);
      t.kap[v] = r.curvature || 0;
    }
    stats.built++;
    return t;
  }

  /**
   * The vehicles inside the route-chainage ranges [lo0, hi0], [lo1, hi1], ... (a flat array) at simMs, moved on to
   * that time: { count, pos[3n], fwd[3n], up[3n], s, speed, id, k, body, colour, brake, alpha, dir, lane }. The
   * arrays are reused: read them before the next call. exact = [lo, hi]: only there is a moved-on place put on the
   * road's geometry exactly (bodies); elsewhere it is the expansion (half a metre at worst: lamps far away).
   */
  let exactLo = Infinity, exactHi = -Infinity;
  function collect(simMs, ranges, exact = null) {
    exactLo = exact ? exact[0] : -Infinity; exactHi = exact ? exact[1] : Infinity;
    out.count = 0;
    stats.tiles = 0;
    let keepLo = Infinity, keepHi = -Infinity;
    for (let k = 0; k + 1 < ranges.length; k += 2) {
      const sLo = ranges[k], sHi = ranges[k + 1];
      if (!(sHi > sLo)) continue;
      const iLo = Math.max(0, Math.floor((sLo - S0) / tileM)), iHi = Math.min(Math.floor((S1 - S0 - 1e-6) / tileM), Math.floor((sHi - S0) / tileM));
      keepLo = Math.min(keepLo, iLo); keepHi = Math.max(keepHi, iHi);
      collectRange(simMs, sLo, sHi, iLo, iHi);
    }
    // forget tiles far from these windows
    if (tiles.size > (keepHi - keepLo + 1) + 16) for (const key of tiles.keys()) if (key < keepLo - 4 || key > keepHi + 4) tiles.delete(key);
    stats.count = out.count;
    return out;
  }

  function collectRange(simMs, sLo, sHi, iLo, iHi) {
    for (let i = iLo; i <= iHi; i++) {
      const phase = ((i % PHASES) / PHASES) * quantumMs;
      const q = Math.floor((simMs - phase) / quantumMs);
      let t = tiles.get(i);
      if (!t || t.q !== q) { const b0 = now(); t = buildTile(i, q, q * quantumMs + phase); tiles.set(i, t); stats.buildMs += now() - b0; }
      stats.tiles++;
      const dt = (simMs - t.tq) / 1000;
      if (out.count + t.n > out.capacity) grow(Math.max(out.capacity * 2, out.count + t.n));
      for (let v = 0; v < t.n; v++) {
        const ds = t.speed[v] * dt + 0.5 * t.acc[v] * dt * dt; // along its own road's +s
        const dirS = t.dir[v] === 0 ? 1 : -1;
        const sRoute = t.s[v] + dirS * ds;
        // the tile's own stretch [sA, sB) now, and the range asked for
        if (sRoute < t.sLo || sRoute >= t.sB || sRoute < sLo || sRoute > sHi) continue;
        // opacity at the moved-on place: lane weight x ramp fade; and the lane's own offset there
        laneMap.atDir(t.dir[v] === 0 ? ldW : ldA, t.lane[v], sRoute, lm);
        let fade = 1;
        const fm = t.fadeM[v];
        if (t.join[v] === t.join[v]) { const f = (dirS * (sRoute - t.join[v])) / fm; if (f < fade) fade = f; }
        if (t.leave[v] === t.leave[v]) { const f = (dirS * (t.leave[v] - sRoute)) / fm; if (f < fade) fade = f; }
        const alpha = (fade > 0 ? fade : 0) * lm.w;
        if (alpha <= 0.002) continue;
        const o = out.count++, o3 = 3 * o, v3 = 3 * v;
        // along its own road: the model's speeds are in route chainage, which the opposing carriageway's own
        // chainage follows only roughly (a separate alignment through an interchange is longer or shorter)
        const dr = lm.sRoad - t.sRoad[v]; // along its own road (route chainage follows it only roughly)
        if (sRoute > exactLo && sRoute < exactHi) {
          // the place itself as the fleet computes it: on the lane's centre line at the moved-on chainage
          (t.dir[v] === 0 ? ldW : ldA).refline.at(lm.sRoad, r);
          const ch = Math.cos(r.heading), sh = Math.sin(r.heading);
          const mx = r.x - sh * lm.d, my = r.y + ch * lm.d;
          out.pos[o3] = mx;
          out.pos[o3 + 1] = frame.sceneY(r.h + r.crossfall * lm.d, mx, my);
          out.pos[o3 + 2] = -my;
        } else {
          // far away (lamps only): the expansion along the road, its curvature and the lane's own offset
          const side = 0.5 * t.kap[v] * dr * dr + (lm.d - t.d[v] - t.dds[v] * dr);
          out.pos[o3] = t.pos[v3] + t.fwd[v3] * dr + t.nrm[v3] * side;
          out.pos[o3 + 1] = t.pos[v3 + 1] + t.fwd[v3 + 1] * dr;
          out.pos[o3 + 2] = t.pos[v3 + 2] + t.fwd[v3 + 2] * dr + t.nrm[v3 + 2] * side;
        }
        out.fwd[o3] = t.fwd[v3]; out.fwd[o3 + 1] = t.fwd[v3 + 1]; out.fwd[o3 + 2] = t.fwd[v3 + 2];
        out.up[o3] = t.up[v3]; out.up[o3 + 1] = t.up[v3 + 1]; out.up[o3 + 2] = t.up[v3 + 2];
        out.s[o] = sRoute; out.speed[o] = t.speed[v] + t.acc[v] * dt; out.id[o] = t.id[v]; out.k[o] = t.k[v];
        out.body[o] = t.body[v]; out.colour[o] = t.colour[v]; out.brake[o] = t.brake[v];
        out.alpha[o] = alpha; out.dir[o] = t.dir[v]; out.lane[o] = t.lane[v];
      }
    }
  }

  return {
    collect,
    /** Drop the kept tiles (a new traffic model, a lane shift). */
    clear: () => tiles.clear(),
    stats: () => ({ ...stats, kept: tiles.size }),
  };
}

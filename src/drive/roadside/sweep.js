/**
 * Barriers swept along the road (plan 02, D3.6): a concrete F-shape safety barrier, a W-beam
 * guardrail on posts, a plain wall and a cable barrier, as profiles swept through rows of a road
 * chunk. Pure, no three: the road mesher (src/drive/roadnet/mesher.js) hands in where a barrier
 * stands at a chainage and a sink to write vertices and triangles to, so barriers land in the road
 * chunk's own buffers and cost no draw call of their own.
 *
 * A run (barrierFormat.js) stands `o` metres outward of its side's shoulder edge, its base on the
 * embankment surface the mesher draws there (on the pavement when o <= 0), so it follows grade,
 * crossfall and tapers. Walls stand on the base heights the pipeline found (ground or embankment).
 *
 * Levels of detail, by the chunk's level: 0 (within 400 m) full profiles, guardrail and cable
 * posts, reflectors; 1 (to 2 km) full profiles, no posts or reflectors; 2 (the batches) concrete
 * and walls with simpler profiles, no guardrail or cable at all.
 *
 * Ends: a free concrete end slopes down to the ground over END.concrete metres; a free guardrail
 * end flares outward and turns down into the ground over END.guardrail metres (a buried terminal);
 * a wall end is capped. Every profile reaches below its base, so on a slope or a crossfall it never
 * floats.
 */

const FT = 0.3048;
/** Profiles: [a, z] points, a metres outward from the run's line, z metres above its base, ordered from the outer bottom over the top to the inner bottom. */
export const PROFILES = {
  // AASHTO F-shape, 32 in: 24 in base, 3 in toe, the 55 degree slope to 13 in, then nearly upright to a 6 in top
  concrete: [[0.305, -0.5], [0.305, 0.076], [0.127, 0.33], [0.075, 0.813], [-0.075, 0.813], [-0.127, 0.33], [-0.305, 0.076], [-0.305, -0.5]],
  concreteFar: [[0.305, -0.5], [0.305, 0.076], [0.075, 0.813], [-0.075, 0.813], [-0.305, 0.076], [-0.305, -0.5]],
  // W-beam, top at 31 in: the rail's face at a = 0 (road side), 0.08 m deep, its valley drawn as two slopes; closed
  guardrail: [[0.08, 0.49], [0.08, 0.78], [0.0, 0.787], [0.045, 0.635], [0.0, 0.48], [0.08, 0.49]],
  // three cables drawn as one thin band
  cable: [[0.02, 0.53], [0.02, 0.78], [0.0, 0.78], [0.0, 0.53], [0.02, 0.53]],
};
export const END = { concrete: 3.0, guardrail: 25 * FT, wall: 0, cable: 3.0 };
export const FLARE = 1.2; // m outward at the very end of a guardrail
export const POST = { guardrail: { every: 6.25 * FT, w: 0.15, a0: 0.08, a1: 0.23, z0: -0.6, z1: 0.74 }, cable: { every: 4.0, w: 0.08, a0: 0.0, a1: 0.08, z0: -0.5, z1: 0.82 } };
export const REFLECTOR = { every: 100 * FT, w: 0.1, h: 0.08 };
export const WALL = { t: 0.3, bury: 1.5 };
/** Sheeting codes of reflective elements (src/drive/roadside/sheeting.js). */
const RETRO_WHITE = 1, RETRO_YELLOW = 2;

/** Whether a run of `type` is drawn at chunk level `lod`. */
export const drawnAt = (type, lod) => lod < 2 || type === 'concrete' || type === 'wall';

/** The profile of a run at a level. */
export function profileOf(run, lod) {
  if (run.type === 'concrete') return lod < 2 ? PROFILES.concrete : PROFILES.concreteFar;
  if (run.type === 'wall') {
    const h = run.h || 3, t = WALL.t, b = -WALL.bury;
    return [[t, b], [t, h], [0, h], [0, b]];
  }
  return PROFILES[run.type];
}

/**
 * Chainages of the rows of a run over [a, b]: every `step` metres on the chunk's grid, plus a, b
 * and the inner ends of the end zones.
 */
export function barrierRows(run, a, b, step) {
  const cuts = new Set([a, b]);
  const e = END[run.type] || 0;
  if (run.open0 && e) { const s = run.s0 + e; if (s > a && s < b) cuts.add(s); }
  if (run.open1 && e) { const s = run.s1 - e; if (s > a && s < b) cuts.add(s); }
  for (let s = (Math.floor(a / step + 1e-9) + 1) * step; s < b - 1e-6; s += step) cuts.add(s);
  return [...cuts].sort((x, y) => x - y);
}

/** How a free end shapes the profile at s: { k: height factor, flare: extra outward metres }. */
export function endShape(run, s) {
  const e = END[run.type] || 0;
  let t = 1;
  if (e) {
    if (run.open0) t = Math.min(t, (s - run.s0) / e);
    if (run.open1) t = Math.min(t, (run.s1 - s) / e);
  }
  t = Math.max(0, Math.min(1, t));
  if (run.type === 'guardrail') return { k: 0.15 + 0.85 * t, flare: FLARE * (1 - t) * (1 - t) };
  return { k: t, flare: 0 };
}

/** The run's offset at s (linear between its ends). */
export const offsetAt = (run, s) => run.o0 + ((run.o1 - run.o0) * (s - run.s0)) / (run.s1 - run.s0);
/** A wall's base relative to the pavement edge at s. */
export const baseAt = (run, s) => run.z0 + ((run.z1 - run.z0) * (s - run.s0)) / (run.s1 - run.s0);

/**
 * Sweep the runs of one road over [s0, s1) ([s0, s1] when `last`) into a sink.
 * @param {object[]} runs decoded runs of this road (barrierFormat.js)
 * @param {{ lod: number, step: number,
 *   frameAt(s: number, side: 'left'|'right', o: number, wallZ: number|null): { x: number, y: number, h: number, ox: number, oy: number, fx: number, fy: number },
 *   put(mx: number, my: number, h: number, region: string, t: number, v: number, kind: string, retro: number): number,
 *   normal(nx: number, ny: number, nz: number): void, tri(a: number, b: number, c: number): void, vAt(s: number): number }} sink
 *   frameAt: the map point and base height of the barrier line, the outward and forward map unit
 *   vectors; put: one vertex (returns its index), normal: the normal of the vertex just put (scene
 *   axes), tri: a triangle. Regions are the road atlas's ('concrete', 'steel', 'reflector').
 * @returns {number} triangles written
 */
export function sweepBarriers(runs, s0, s1, last, sink) {
  let tris = 0;
  for (const run of runs) {
    if (!drawnAt(run.type, sink.lod)) continue;
    const a = Math.max(run.s0, s0), b = Math.min(run.s1, s1);
    if (!(b > a)) continue;
    tris += sweepRun(run, a, b, sink);
    if (sink.lod === 0) tris += posts(run, s0, s1, last, sink) + reflectors(run, s0, s1, last, sink);
    if (run.type === 'wall') {
      if (run.open0 && run.s0 >= s0 && run.s0 < s1) tris += wallCap(run, run.s0, -1, sink);
      if (run.open1 && run.s1 >= s0 && (run.s1 < s1 || (last && run.s1 <= s1))) tris += wallCap(run, run.s1, 1, sink);
    }
  }
  return tris;
}

function frameOf(run, s, sink) {
  const shape = endShape(run, s);
  const f = sink.frameAt(s, run.side, offsetAt(run, s) + shape.flare, run.type === 'wall' ? baseAt(run, s) : null);
  return { f, k: shape.k };
}

function sweepRun(run, a, b, sink) {
  const prof = profileOf(run, sink.lod);
  const nf = prof.length - 1;
  const region = run.type === 'guardrail' || run.type === 'cable' ? 'steel' : 'concrete';
  const rows = barrierRows(run, a, b, sink.step);
  let prev = null, tris = 0;
  for (const s of rows) {
    const { f, k } = frameOf(run, s, sink);
    const vv = sink.vAt(s);
    const idx = [];
    const pts = prof.map(([pa, pz]) => {
      const z = pz > 0 ? pz * k : pz;
      return [f.x + f.ox * pa, f.y + f.oy * pa, f.h + z];
    });
    for (let q = 0; q < nf; q++) {
      const [a0, z0] = prof[q], [a1, z1] = prof[q + 1];
      // face normal in the profile plane: (dz, -da) rotated into scene axes (outward = (ox, 0, -oy))
      const da = a1 - a0, dz = (z1 > 0 ? z1 * k : z1) - (z0 > 0 ? z0 * k : z0);
      const l = Math.hypot(da, dz) || 1;
      const na = dz / l, nz = -da / l;
      const nx = f.ox * na, ny = nz, nzS = -f.oy * na;
      const i0 = sink.put(pts[q][0], pts[q][1], pts[q][2], region, q / nf, vv, 'barrier', 0); sink.normal(nx, ny, nzS);
      sink.put(pts[q + 1][0], pts[q + 1][1], pts[q + 1][2], region, (q + 1) / nf, vv, 'barrier', 0); sink.normal(nx, ny, nzS);
      idx.push(i0);
    }
    if (prev) {
      for (let q = 0; q < nf; q++) {
        const A = prev.idx[q], B = A + 1, A2 = idx[q], B2 = A2 + 1;
        // wind so the face's normal points out of the solid: (B - A) x (A2 - A) . n > 0
        const pa = prev.pts[q], pb = prev.pts[q + 1], pa2 = pts[q];
        const flip = windSign(pa, pb, pa2, prof[q], prof[q + 1], f) < 0;
        if (flip) { sink.tri(A, A2, B); sink.tri(B, A2, B2); } else { sink.tri(A, B, A2); sink.tri(B, B2, A2); }
        tris += 2;
      }
    }
    prev = { idx, pts };
  }
  return tris;
}

/** Sign of ((B - A) x (A2 - A)) . n in scene axes, n the face's outward normal. Map (x, y, h) -> scene (x, h, -y). */
function windSign(A, B, A2, p0, p1, f) {
  const u = [B[0] - A[0], B[2] - A[2], -(B[1] - A[1])];
  const w = [A2[0] - A[0], A2[2] - A[2], -(A2[1] - A[1])];
  const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const da = p1[0] - p0[0], dz = p1[1] - p0[1];
  const n = [f.ox * dz, -da, -f.oy * dz];
  return c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
}

/** A box between two corners in the barrier's frame at s: along [-w/2, w/2], across [a0, a1], up [z0, z1]. */
function box(f, w, a0, a1, z0, z1, region, sink) {
  const P = (al, ac, z) => [f.x + f.fx * al + f.ox * ac, f.y + f.fy * al + f.oy * ac, f.h + z];
  const h = w / 2;
  // faces: outer (+a), inner (-a), ahead (+along), behind (-along), top
  const faces = [
    [[[-h, a1, z0], [h, a1, z0], [h, a1, z1], [-h, a1, z1]], [f.ox, 0, -f.oy]],
    [[[h, a0, z0], [-h, a0, z0], [-h, a0, z1], [h, a0, z1]], [-f.ox, 0, f.oy]],
    [[[h, a1, z0], [h, a0, z0], [h, a0, z1], [h, a1, z1]], [f.fx, 0, -f.fy]],
    [[[-h, a0, z0], [-h, a1, z0], [-h, a1, z1], [-h, a0, z1]], [-f.fx, 0, f.fy]],
    [[[-h, a0, z1], [-h, a1, z1], [h, a1, z1], [h, a0, z1]], [0, 1, 0]],
  ];
  for (const [corners, n] of faces) quad(corners.map(([al, ac, z]) => P(al, ac, z)), n, region, 'barrier', 0, sink);
  return 10;
}

/** A quad from four map points, wound to face n (scene axes). */
function quad(pts, n, region, kind, retro, sink, t = [0, 1, 1, 0]) {
  const i = pts.map((p, j) => { const k = sink.put(p[0], p[1], p[2], region, t[j], 0, kind, retro); sink.normal(n[0], n[1], n[2]); return k; });
  const A = pts[0], B = pts[1], C = pts[2];
  const u = [B[0] - A[0], B[2] - A[2], -(B[1] - A[1])], w = [C[0] - A[0], C[2] - A[2], -(C[1] - A[1])];
  const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] >= 0) { sink.tri(i[0], i[1], i[2]); sink.tri(i[0], i[2], i[3]); } else { sink.tri(i[0], i[2], i[1]); sink.tri(i[0], i[3], i[2]); }
}

/** Positions k * every from the run's start that fall in [s0, s1) and outside its end zones. */
function stations(run, every, s0, s1, last, margin) {
  const out = [];
  const lo = run.open0 ? run.s0 + margin : run.s0, hi = run.open1 ? run.s1 - margin : run.s1;
  for (let k = Math.max(0, Math.ceil((Math.max(lo, s0) - run.s0) / every - 1e-9)); ; k++) {
    const s = run.s0 + k * every;
    if (s > hi + 1e-9 || s > s1 || (s === s1 && !last)) break;
    if (s >= s0 && s >= lo - 1e-9) out.push(s);
  }
  return out;
}

function posts(run, s0, s1, last, sink) {
  const p = POST[run.type];
  if (!p) return 0;
  let tris = 0;
  for (const s of stations(run, p.every, s0, s1, last, END[run.type] * 0.5)) {
    const { f, k } = frameOf(run, s, sink);
    tris += box(f, p.w, p.a0, p.a1, p.z0, p.z1 * k, 'steel', sink);
  }
  return tris;
}

function reflectors(run, s0, s1, last, sink) {
  if (run.type !== 'guardrail' && run.type !== 'concrete' && run.type !== 'cable') return 0;
  const retro = run.side === 'right' ? RETRO_WHITE : RETRO_YELLOW;
  const t = retro === RETRO_WHITE ? [0.1, 0.4, 0.4, 0.1] : [0.6, 0.9, 0.9, 0.6];
  let tris = 0;
  for (const s of stations(run, REFLECTOR.every, s0, s1, last, END[run.type] + 1)) {
    const { f } = frameOf(run, s, sink);
    // on the road face near the top, facing oncoming traffic
    const a = run.type === 'concrete' ? -0.08 : -0.012;
    const z = run.type === 'concrete' ? 0.7 : 0.66;
    const { w, h } = REFLECTOR;
    const P = (ac, zz) => [f.x + f.ox * ac - f.fx * 0.01, f.y + f.oy * ac - f.fy * 0.01, f.h + zz];
    quad([P(a - w / 2, z), P(a + w / 2, z), P(a + w / 2, z + h), P(a - w / 2, z + h)], [-f.fx, 0, f.fy], 'reflector', 'reflector', retro, sink, t);
    tris += 2;
  }
  return tris;
}

function wallCap(run, s, dir, sink) {
  const { f } = frameOf(run, s, sink);
  const h = run.h || 3, t = WALL.t, b = -WALL.bury;
  const P = (ac, z) => [f.x + f.ox * ac, f.y + f.oy * ac, f.h + z];
  quad([P(0, b), P(t, b), P(t, h), P(0, h)], [f.fx * dir, 0, -f.fy * dir], 'concrete', 'barrier', 0, sink);
  return 2;
}

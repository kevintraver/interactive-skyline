// Barriers swept into the road chunks (src/drive/roadside/sweep.js through the road mesher): they
// stand outside the pavement on the surface the mesher draws, follow tapers, end cleanly, drop
// posts and then rails with distance, face outwards, mark their reflectors, and meet at chunk ends.
import { describe, it, expect } from 'vitest';
import { meshChunk, reflineOf, EMBANKMENT } from '../../../src/drive/roadnet/mesher.js';
import { edgesAt } from '../../../src/drive/roadnet/crosssection.js';
import { KIND } from '../../../src/drive/roadnet/atlas.js';
import { PROFILES, END, POST, barrierRows, endShape, profileOf, drawnAt } from '../../../src/drive/roadside/sweep.js';
import { fixture, BASE, EARTH_R } from '../roadnet/helpers.js';

const [main] = fixture().roads;
// the fixture's main road widens from 3 to 4 lanes at 1600 m with a change of placement: a taper on the left
const runs = [
  { s0: 1300, s1: 2100, side: 'left', type: 'concrete', o0: 0.6, o1: 0.6, prov: 'rule', open0: true, open1: true, h: 0, z0: 0, z1: 0 },
  { s0: 300, s1: 700, side: 'right', type: 'guardrail', o0: 0.3, o1: 0.3, prov: 'mapped', open0: true, open1: true, h: 0, z0: 0, z1: 0 },
  { s0: 900, s1: 1100, side: 'right', type: 'wall', o0: 8, o1: 9, prov: 'mapped', open0: true, open1: true, h: 4, z0: -1, z1: -0.5 },
];
const road = { ...main, barriers: runs };
const mesh = (s0, s1, lod, r = road) => meshChunk({ road: r, s0, s1, lod, base: BASE, earthR: EARTH_R });
const world = (m, i) => [m.origin[0] + m.positions[3 * i], m.origin[1] + m.positions[3 * i + 1], m.origin[2] + m.positions[3 * i + 2]];
const height = ([x, y, z]) => y + BASE + (x * x + z * z) / (2 * EARTH_R);
/** (s, lateral offset positive left) of a scene point against the fixture road, by a local search. */
function locate(p, sGuess) {
  const ref = reflineOf(main);
  let best = null;
  for (let s = sGuess - 12; s <= sGuess + 12; s += 0.25) {
    const q = ref.at(s);
    const dx = p[0] - q.x, dy = -p[2] - q.y;
    const along = dx * Math.cos(q.heading) + dy * Math.sin(q.heading);
    if (!best || Math.abs(along) < Math.abs(best.along)) best = { s, along, d: -dx * Math.sin(q.heading) + dy * Math.cos(q.heading), q };
  }
  return best;
}
/** The station of the chunk nearest a scene point, every 2 m. */
function nearestS(p, s0, s1) {
  const ref = reflineOf(main);
  let bs = s0, bd = Infinity;
  for (let s = s0; s <= s1; s += 2) { const q = ref.at(s); const dd = Math.hypot(p[0] - q.x, -p[2] - q.y); if (dd < bd) { bd = dd; bs = s; } }
  return bs;
}
const barrierVerts = (m) => [...m.kind.keys()].filter((i) => m.kind[i] === KIND.barrier || m.kind[i] === KIND.reflector);
const embDrop = (e) => (e <= EMBANKMENT[0][0] ? (e * EMBANKMENT[0][1]) / EMBANKMENT[0][0] : EMBANKMENT[0][1]);

describe('swept barriers', () => {
  it('stand outside the pavement on their side, also through the taper', () => {
    for (const [s0, s1] of [[1280, 1536], [1536, 1792], [1792, 2048], [256, 512], [512, 768]]) {
      const m = mesh(s0, s1, 0);
      const vs = barrierVerts(m);
      expect(vs.length).toBeGreaterThan(0);
      for (const i of vs) {
        const p = world(m, i);
        const loc = locate(p, nearestS(p, s0, s1));
        const cs = edgesAt(main, loc.s);
        // never on the lanes: concrete toe at least 0.29 m outside the left edge, guardrail and wall outside the right
        if (loc.d > 0) expect(loc.d).toBeGreaterThan(cs.left - 0.01);
        else expect(loc.d).toBeLessThan(cs.right + 0.01);
      }
    }
  });

  it('stand on the embankment surface the mesher draws, and reach below it', () => {
    const m = mesh(512, 768, 0);
    const ref = reflineOf(main);
    let lowest = Infinity;
    for (const i of barrierVerts(m)) {
      const p = world(m, i);
      const q = ref.at(600);
      lowest = Math.min(lowest, height(p) - q.h);
    }
    expect(lowest).toBeLessThan(-0.4); // posts and the profile go into the ground
    // the rail's top over its base: 31 in at full height between the end zones
    const s = 600, q = ref.at(s), cs = edgesAt(main, s);
    const base = q.h + q.crossfall * cs.right - embDrop(0.3);
    const tops = barrierVerts(m).map((i) => world(m, i)).filter((p) => Math.abs(locate(p, s).s - s) < 0.3).map((p) => height(p) - base);
    expect(Math.max(...tops)).toBeCloseTo(PROFILES.guardrail[2][1], 1);
  });

  it('end cleanly: a sloped concrete end and a flared, buried guardrail end', () => {
    const c = runs[0], g = runs[1];
    expect(endShape(c, c.s0).k).toBe(0);
    expect(endShape(c, c.s0 + END.concrete).k).toBe(1);
    expect(endShape(g, g.s1).flare).toBeCloseTo(1.2, 6);
    expect(endShape(g, g.s1).k).toBeCloseTo(0.15, 6);
    expect(endShape(g, (g.s0 + g.s1) / 2)).toEqual({ k: 1, flare: 0 });
    // rows fall on the end zones' inner ends
    expect(barrierRows(c, c.s0, c.s0 + 64, 16)).toContain(c.s0 + END.concrete);
  });

  it('drop posts and reflectors beyond level 0, guardrail beyond level 1, keep concrete and walls', () => {
    const t = (lod) => { const a = mesh(256, 768, lod), b = mesh(256, 768, lod, main); return (a.indices.length - b.indices.length) / 3; };
    const t0 = t(0), t1 = t(1), t2 = t(2);
    expect(t0).toBeGreaterThan(t1);
    expect(t2).toBe(0); // only a guardrail here
    const posts = Math.floor((runs[1].s1 - runs[1].s0 - END.guardrail) / POST.guardrail.every);
    expect(t0 - t1).toBeGreaterThan(posts * 10 * 0.5); // posts are boxes, 10 triangles each, plus row density
    expect(drawnAt('concrete', 2) && drawnAt('wall', 2) && !drawnAt('guardrail', 2) && !drawnAt('cable', 2)).toBe(true);
    const c2 = (mesh(1536, 1792, 2).indices.length - mesh(1536, 1792, 2, main).indices.length) / 3;
    expect(c2).toBeGreaterThan(0);
    expect(profileOf(runs[0], 2)).toBe(PROFILES.concreteFar);
  });

  it('keep low triangle counts: under 120 triangles per metre of guardrail at level 0', () => {
    const t = (mesh(256, 768, 0).indices.length - mesh(256, 768, 0, main).indices.length) / 3;
    expect(t / (runs[1].s1 - runs[1].s0)).toBeLessThan(12);
  });

  it('face outwards: every barrier triangle winds with its vertex normals', () => {
    const m = mesh(1536, 1792, 0);
    let checked = 0;
    for (let k = 0; k < m.indices.length; k += 3) {
      const [a, b, c] = [m.indices[k], m.indices[k + 1], m.indices[k + 2]];
      if (m.kind[a] !== KIND.barrier) continue;
      const A = world(m, a), B = world(m, b), C = world(m, c);
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const l = Math.hypot(...n);
      if (l < 1e-8) continue; // collapsed at the very end of a sloped end
      const dot = (n[0] * m.normals[3 * a] + n[1] * m.normals[3 * a + 1] + n[2] * m.normals[3 * a + 2]) / l;
      expect(dot).toBeGreaterThan(0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('mark reflectors in the retro attribute: yellow on the left, white on the right, nothing else', () => {
    const left = mesh(1536, 1792, 0), right = mesh(256, 512, 0);
    const codes = (m) => new Set([...m.retro.keys()].filter((i) => m.kind[i] === KIND.reflector).map((i) => m.retro[i]));
    expect(codes(left)).toEqual(new Set([2]));
    expect(codes(right)).toEqual(new Set([1]));
    for (const m of [left, right]) for (let i = 0; i < m.kind.length; i++) if (m.kind[i] !== KIND.reflector) expect(m.retro[i]).toBe(0);
  });

  it('meet at chunk ends: the last row of one chunk is the first of the next, at every level', () => {
    for (const lod of [0, 1, 2]) {
      const a = mesh(1536, 1792, lod), b = mesh(1792, 2048, lod);
      const at = (m, s) => barrierVerts(m).map((i) => world(m, i)).filter((p) => Math.abs(locate(p, s).along) < 1e-3 && Math.abs(locate(p, s).s - s) < 0.3);
      const ea = at(a, 1792), eb = at(b, 1792);
      expect(ea.length).toBeGreaterThan(0);
      for (const p of ea) expect(eb.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-3)).toBe(true);
    }
  });

  it('build a chunk with barriers on both sides quickly', () => {
    const both = { ...main, barriers: [...runs, { ...runs[1], side: 'left', s0: 1200, s1: 2400 }, { ...runs[0], side: 'right', s0: 1000, s1: 2800 }] };
    // the fastest of several runs: robust to a loaded machine running the other suites in parallel
    let best = Infinity;
    for (let k = 0; k < 12; k++) { const t = performance.now(); mesh(1536, 1792, 0, both); best = Math.min(best, performance.now() - t); }
    expect(best).toBeLessThan(8);
  });
});

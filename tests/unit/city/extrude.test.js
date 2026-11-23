// T0.3: extrude() on recorded buildings. Vertex counts follow from the shapes: walls are two triangles per
// edge, a flat roof n - 2 triangles, a pyramid one triangle per edge, a leaning piece two per edge plus a top and
// a bottom cap.
import { describe, it, expect } from 'vitest';
import { extrude, toGeometry, fresh } from '../../../src/city/extrude.js';
import fixture from '../../fixtures/buildings-lv.json' with { type: 'json' };

const byKind = Object.fromEntries(fixture.buildings.map((b) => [b.kind, b]));
const corners = (flat) => flat.length / 2;
function build(b) {
  const out = fresh();
  for (const v of b.v) extrude(v, out, [1, 1, 1], fixture.base);
  return out;
}

describe('extrude', () => {
  it('flat roof: 6n walls + 3(n - 2) roof', () => {
    const b = byKind.flat, n = corners(b.v[0].o);
    expect(build(b).n).toBe(6 * n + 3 * (n - 2));
  });
  it('courtyard: walls round the hole too, roof triangulated around it', () => {
    const b = byKind.courtyard, n = corners(b.v[0].o), m = b.v[0].h.map(corners).reduce((a, c) => a + c, 0);
    expect(build(b).n).toBe(6 * (n + m) + 3 * (n + m + 2 * b.v[0].h.length - 2));
  });
  it('pyramid: 6n walls + 3n faces to the apex', () => {
    const b = byKind.pyramid, n = corners(b.v[0].o);
    expect(build(b).n).toBe(9 * n);
  });
  it('leaning pieces: 6n sides + two caps of 3(n - 2); its plain volumes as flat roofs', () => {
    const b = byKind.leaning;
    expect(b.v.some((v) => v.u) && b.v.every((v) => !v.r)).toBe(true);
    const want = b.v.reduce((a, v) => { const n = corners(v.o); return a + (v.u ? 6 * n + 6 * (n - 2) : 6 * n + 3 * (n - 2)); }, 0);
    expect(build(b).n).toBe(want);
  });
  it('dome: recorded count (seven rings, the last closing to a point)', () => {
    expect(build(byKind.dome).n).toBe(45 * corners(byKind.dome.v[0].o));
  });
  it('lowers heights by the base and flips north to -z', () => {
    const b = byKind.flat, out = build(b), geo = toGeometry(out), pos = geo.attributes.position;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) { minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i)); }
    expect(minY).toBeCloseTo(b.v[0].b - fixture.base, 4);
    expect(maxY).toBeCloseTo(b.v[0].t - fixture.base, 4);
    expect(pos.getZ(0)).toBeCloseTo(-b.v[0].o[1], 4);
    expect(geo.attributes.normal.count).toBe(out.n);
    expect(geo.attributes.windows).toBeUndefined();
  });
});

// The stability pass: extruded footprints are drawn a hair inside their outline, by class, so coplanar surfaces of
// two buildings never fight.
import { insetRing, INSET } from '../../../src/city/extrude.js';
import { Vector2 } from 'three';
describe('insetRing', () => {
  it('moves a square outline inward on every side, a hole outward', () => {
    const sq = [new Vector2(0, 0), new Vector2(10, 0), new Vector2(10, 10), new Vector2(0, 10)]; // counter-clockwise
    const r = insetRing(sq, 0.1);
    expect(r.map((p) => [+p.x.toFixed(6), +p.y.toFixed(6)])).toEqual([[0.1, 0.1], [9.9, 0.1], [9.9, 9.9], [0.1, 9.9]]);
    const hole = [...sq].reverse(); // clockwise
    const h = insetRing(hole, 0.1);
    expect(h.map((p) => [+p.x.toFixed(6), +p.y.toFixed(6)])).toEqual([[-0.1, 10.1], [10.1, 10.1], [10.1, -0.1], [-0.1, -0.1]]);
  });
  it('the classes: models never, tall extruded less than low', () => {
    expect(INSET.model).toBe(0);
    expect(INSET.tall).toBeGreaterThan(0);
    expect(INSET.low).toBeGreaterThan(INSET.tall);
    expect(INSET.low).toBeLessThanOrEqual(0.2);
  });
});

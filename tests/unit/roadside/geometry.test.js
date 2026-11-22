import { describe, it, expect } from 'vitest';
import { buildSign, signFrame, embankmentDrop, postsOf } from '../../../src/drive/roadside/geometry.js';
import { BASE, EARTH_R } from './helpers.js';

// A straight road 60 km out (where true vertical leans 0.4 degrees), heading north-east
const HEADING = Math.PI / 4, X0 = 40000, Y0 = -45000, H = 700, XF = 0.02;
const EDGES = { left: 6.2, right: -9.0 };
const road = {
  base: BASE, earthR: EARTH_R,
  at: (s) => ({ x: X0 + s * Math.cos(HEADING), y: Y0 + s * Math.sin(HEADING), h: H, heading: HEADING, crossfall: XF, grade: 0 }),
  edges: () => EDGES,
};
const uv = () => ({ page: 0, u0: 0, v0: 0, u1: 1, v1: 1 });
const rec = (o) => ({ kind: 'advance', s: 1000, side: 'right', offset: 6, mount: 2.2, w: 5, h: 2.5, cap: 0.4, ...o });
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const corner = (q, i) => q.pos.slice(i * 3, i * 3 + 3);
const upAt = (p) => unit([p[0], EARTH_R, p[2]]);
/** Map lateral offset (positive left) of a scene point from the road's reference line. */
const lateral = (p) => { const x = p[0] - X0, y = -p[2] - Y0; return -Math.sin(HEADING) * x + Math.cos(HEADING) * y; };

describe('sign geometry', () => {
  it('faces oncoming traffic: the face normal points against the direction of travel', () => {
    for (const side of ['right', 'left']) {
      const b = buildSign(rec({ side }), null, road, uv);
      const travel = [Math.cos(HEADING), 0, -Math.sin(HEADING)];
      const q = b.faces[0];
      expect(dot(q.normal, travel)).toBeLessThan(-0.9999);
      // the winding agrees: (BR - BL) x (TL - BL) is the normal
      const [bl, br, , tl] = [0, 1, 2, 3].map((i) => corner(q, i));
      const e1 = sub(br, bl), e2 = sub(tl, bl);
      const n = unit([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
      expect(dot(n, q.normal)).toBeGreaterThan(0.9999);
    }
  });

  it('stands upright along localUp, not along +y, this far out', () => {
    const b = buildSign(rec(), null, road, uv);
    const q = b.faces[0];
    const vertical = unit(sub(corner(q, 3), corner(q, 0)));
    const up = upAt(corner(q, 0));
    expect(dot(vertical, up)).toBeGreaterThan(1 - 1e-9);
    expect(dot(vertical, [0, 1, 0])).toBeLessThan(Math.cos((0.3 * Math.PI) / 180)); // leans measurably
    expect(Math.abs(dot(q.normal, up))).toBeLessThan(1e-9);
  });

  it('stands on its own side, clear of the pavement by its offset, at its mounting height', () => {
    for (const side of ['right', 'left']) {
      const r = rec({ side });
      const b = buildSign(r, null, road, uv);
      const q = b.faces[0];
      const f0 = signFrame(r, road);
      // where each corner stands, dropped along true vertical to the base's level
      const lats = [0, 1, 2, 3].map((i) => { const c = corner(q, i), k = dot(sub(c, f0.base), f0.up); return lateral(sub(c, f0.up.map((u) => u * k))); });
      if (side === 'right') expect(Math.max(...lats)).toBeCloseTo(EDGES.right - r.offset, 3);
      else expect(Math.min(...lats)).toBeCloseTo(EDGES.left + r.offset, 3);
      const f = signFrame(r, road);
      const edgeH = H + XF * (side === 'right' ? EDGES.right : EDGES.left);
      expect(f.edgeH).toBeCloseTo(edgeH, 9);
      expect(dot(sub(corner(q, 0), f.base), f.up)).toBeCloseTo(r.mount, 6);
    }
  });

  it('runs its posts from behind the panel down past the embankment surface into the ground', () => {
    for (const r of [rec(), rec({ side: 'left' }), rec({ kind: 'speed', w: 1.22, h: 1.52, offset: 3 }), rec({ kind: 'mile', w: 0.3, h: 0.9, offset: 2, mount: 1.4 })]) {
      const b = buildSign(r, null, road, uv);
      expect(b.posts).toHaveLength(r.w >= 2 ? 2 : 1);
      for (const p of b.posts) {
        const surface = -embankmentDrop(p.lateral);
        expect(p.yFoot).toBeLessThan(surface - 0.5);
        const f = b.frame;
        const topY = dot(sub(p.top, f.base), f.up);
        expect(topY).toBeGreaterThan(r.mount); // reaches up behind the panel
        expect(dot(sub(p.top, f.base), f.face)).toBeLessThan(0); // behind the face
      }
    }
    expect(postsOf(rec()).map((p) => p.x)).toEqual([-1.5, 1.5]);
  });

  it('puts the exit number plaque on top at the exit side and maps the atlas the right way up', () => {
    const r = rec();
    const b = buildSign(r, { w: 2, h: 0.76, left: false }, road, (plate) => (plate === 'tab' ? { page: 0, u0: 0.5, v0: 0, u1: 0.6, v1: 0.1 } : uv()));
    expect(b.faces).toHaveLength(2);
    const tab = b.faces[1];
    const f = b.frame;
    const bl = corner(tab, 0), br = corner(tab, 1);
    expect(dot(sub(bl, f.base), f.up)).toBeCloseTo(r.mount + r.h, 6);
    expect(dot(sub(br, f.base), f.right)).toBeCloseTo(r.w / 2, 6); // flush with the right edge
    expect(tab.uv.slice(0, 2)).toEqual([0.5, 0.1]); // bottom-left corner takes the bottom of the rect
    expect(tab.uv.slice(6, 8)).toEqual([0.5, 0]);
    const left = buildSign(rec({ side: 'left' }), { w: 2, h: 0.76, left: true }, road, uv);
    expect(dot(sub(corner(left.faces[1], 0), left.frame.base), left.frame.right)).toBeCloseTo(-r.w / 2, 6);
  });
});

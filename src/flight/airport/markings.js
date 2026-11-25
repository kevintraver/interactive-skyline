// The airport's paint (plan 03, section 7.10; F4.2), pure and without three.js: runway markings chosen by each end's
// marking type at the dimensions of the FAA's marking standard (AC 150/5340-1M), and taxiway centre lines, holding
// positions and stand lead-in lines from OpenStreetMap's lines and points. surfaces.js draws them.
//
// Every mark is a rectangle (a rotated one for the strokes of arrowheads and the leg of an R):
//   { kind, colour ('white', 'yellow' or 'rubber'), alpha, soft, cx, cy (map centre), ux, uy (unit axis of its
//     length), hl, hw (half length and half width, m) }
// and a runway's marks also carry { runway, end, cs, ct, angle (its centre in the end's frame and its axis' angle from
// the landing direction toward the right), and s0, s1, t0, t1 when it lies along the runway (angle 0) }.
//
// Order matters: rubber comes first, so that the paint drawn after it in the same draw lies on top.

import { FT } from './geometry.js';

const IN = 0.0254;

/**
 * Runway numerals and letters on a grid 4 units wide and 12 high (one unit 5 ft: 20 ft by 60 ft, section 7.10's 60 ft
 * numerals). x to the right as read from the approach, y away from the threshold. Rectangles [x0, y0, x1, y1]; a
 * stroke at an angle is { from: [x, y], to: [x, y] } one unit wide. ESTIMATED: the strokes are a blocky reading of
 * the standard's figure (its numerals have chamfered corners), one unit (5 ft) wide.
 */
export const GLYPHS = Object.freeze({
  0: [[0, 0, 1, 12], [3, 0, 4, 12], [1, 11, 3, 12], [1, 0, 3, 1]],
  1: [[1.5, 0, 2.5, 12]],
  2: [[0, 11, 4, 12], [3, 6.5, 4, 11], [0, 5.5, 4, 6.5], [0, 1, 1, 5.5], [0, 0, 4, 1]],
  3: [[0, 11, 3, 12], [1, 5.5, 3, 6.5], [0, 0, 3, 1], [3, 0, 4, 12]],
  4: [[0, 4.5, 1, 12], [1, 4.5, 3, 5.5], [3, 0, 4, 12]],
  5: [[0, 11, 4, 12], [0, 6.5, 1, 11], [0, 5.5, 3, 6.5], [3, 0, 4, 6.5], [0, 0, 3, 1]],
  6: [[0, 11, 4, 12], [0, 0, 1, 11], [1, 5.5, 3, 6.5], [3, 0, 4, 6.5], [1, 0, 3, 1]],
  7: [[0, 11, 4, 12], [3, 0, 4, 11]],
  8: [[0, 0, 1, 12], [3, 0, 4, 12], [1, 11, 3, 12], [1, 5.5, 3, 6.5], [1, 0, 3, 1]],
  9: [[0, 11, 3, 12], [0, 5.5, 1, 11], [1, 5.5, 3, 6.5], [3, 0, 4, 12], [0, 0, 3, 1]],
  L: [[0, 0, 1, 12], [1, 0, 4, 1]],
  R: [[0, 0, 1, 12], [1, 11, 4, 12], [3, 6.5, 4, 11], [1, 5.5, 4, 6.5], { from: [1.6, 5.5], to: [3.5, 0] }],
  C: [[0, 0, 1, 12], [1, 11, 4, 12], [1, 0, 4, 1]],
});
const GLYPH_UNIT = 5 * FT;

/** The corners of a mark: map [x, y] (default) or, for a runway mark, its end's [s, t]. */
export function markCorners(m, space = 'map') {
  const out = [];
  if (space === 'local') {
    const ax = Math.cos(m.angle), at = Math.sin(m.angle);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) out.push([m.cs + a * m.hl * ax - b * m.hw * at, m.ct + a * m.hl * at + b * m.hw * ax]);
    return out;
  }
  const vx = m.uy, vy = -m.ux;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) out.push([m.cx + a * m.hl * m.ux + b * m.hw * vx, m.cy + a * m.hl * m.uy + b * m.hw * vy]);
  return out;
}

/** A runway mark from its centre and axis in an end's frame. */
function runwayMark(e, kind, cs, ct, angle, hl, hw, extra = {}) {
  const [cx, cy] = e.toMap(cs, ct);
  const ux = Math.cos(angle) * e.L[0] + Math.sin(angle) * e.R[0], uy = Math.cos(angle) * e.L[1] + Math.sin(angle) * e.R[1];
  const m = { kind, colour: 'white', alpha: 1, soft: 0, runway: e.runway.id, end: e.id, cs, ct, angle, hl, hw, cx, cy, ux, uy, ...extra };
  if (angle === 0) Object.assign(m, { s0: cs - hl, s1: cs + hl, t0: ct - hw, t1: ct + hw });
  return m;
}
/** An axis-aligned runway mark from its extents in an end's frame. */
const box = (e, kind, s0, s1, t0, t1, extra) => runwayMark(e, kind, (s0 + s1) / 2, (t0 + t1) / 2, 0, (s1 - s0) / 2, (t1 - t0) / 2, extra);
/** A stroke between two points of an end's frame, `w` wide. */
function stroke(e, kind, [s0, t0], [s1, t1], w, extra) {
  const l = Math.hypot(s1 - s0, t1 - t0);
  return runwayMark(e, kind, (s0 + s1) / 2, (t0 + t1) / 2, Math.atan2(t1 - t0, s1 - s0), l / 2, w / 2, extra);
}

/** Number of threshold stripes for a runway width (AC 150/5340-1M table: 60 ft 4, 75 ft 6, 100 ft 8, 150 ft 12, 200 ft
 * 16). */
const thresholdStripes = (widthM) => {
  const w = widthM / FT;
  return w >= 195 ? 16 : w >= 145 ? 12 : w >= 95 ? 8 : w >= 70 ? 6 : 4;
};

/** The far edge of an end's designation, m past its threshold (where its centre line may begin, 40 ft on). */
function designationSpan(e) {
  const kind = e.data.markingKind;
  if (!kind || kind === 'none') return null;
  const name = e.id.replace(/^0/, '');
  const hasLetter = /[LRC]$/.test(name);
  const start = (kind === 'basic' ? 20 : 190) * FT;
  // ESTIMATED: 20 ft between the letter and the number
  return { start, letterEnd: start + 60 * FT, numberStart: start + (hasLetter ? 80 : 0) * FT, end: start + (hasLetter ? 140 : 60) * FT, name, hasLetter };
}

/**
 * Runway markings for every end, by its marking type (precision, non-precision, basic), at AC 150/5340-1M's
 * dimensions. Where two runways cross, the shorter one's paint stops at the longer one's edges.
 * @param {object} data airport.json
 * @param {ReturnType<import('./geometry.js').runwayFrames>} frames
 */
export function runwayMarkings(data, frames) {
  const { ends, runways } = frames;
  const rubber = [], paint = [];
  for (const e of Object.values(ends)) {
    const kind = e.data.markingKind;
    const instrument = kind === 'precision' || kind === 'non-precision';
    const W = e.width;
    if (instrument) {
      // threshold: stripes 150 ft long, 5.75 ft wide and as far apart, from 20 ft past the threshold, with a centre
      // gap of two stripe widths
      const n = thresholdStripes(W) / 2, a = 5.75 * FT;
      for (let j = 0; j < n; j++) {
        for (const side of [-1, 1]) {
          const t0 = a + j * 2 * a, t1 = t0 + a;
          paint.push(box(e, 'threshold', 20 * FT, 170 * FT, side > 0 ? t0 : -t1, side > 0 ? t1 : -t0));
        }
      }
    }
    // designation: the letter nearest the threshold, the number beyond, each glyph 20 ft by 60 ft; two digits 15 ft
    // apart (ESTIMATED)
    const d = designationSpan(e);
    if (d) {
      const digits = d.hasLetter ? d.name.slice(0, -1) : d.name;
      const put = (text, s0) => {
        const n = text.length, gap = 15 * FT, w = 4 * GLYPH_UNIT;
        const total = n * w + (n - 1) * gap;
        [...text].forEach((c, i) => {
          const t0 = -total / 2 + i * (w + gap);
          for (const g of GLYPHS[c]) {
            if (Array.isArray(g)) {
              paint.push(box(e, 'designation', s0 + g[1] * GLYPH_UNIT, s0 + g[3] * GLYPH_UNIT, t0 + g[0] * GLYPH_UNIT, t0 + g[2] * GLYPH_UNIT, { glyph: c }));
            } else {
              paint.push(stroke(e, 'designation', [s0 + g.from[1] * GLYPH_UNIT, t0 + g.from[0] * GLYPH_UNIT], [s0 + g.to[1] * GLYPH_UNIT, t0 + g.to[0] * GLYPH_UNIT], GLYPH_UNIT, { glyph: c }));
            }
          }
        });
      };
      if (d.hasLetter) put(d.name.slice(-1), d.start);
      put(digits, d.numberStart);
    }
    if (instrument) {
      // aiming point: two blocks 150 ft by 30 ft from 1,020 ft, inner edges 72 ft apart (runways of 4,200 ft or more)
      if (e.toOpposite >= 4200 * FT) {
        for (const side of [-1, 1]) paint.push(box(e, 'aiming', 1020 * FT, 1170 * FT, side > 0 ? 36 * FT : -66 * FT, side > 0 ? 66 * FT : -36 * FT));
      }
      // touchdown zone (precision): bars 75 ft by 6 ft, 5 ft apart, inner edges 72 ft apart, in threes at 500 and 1,500
      // ft, twos at 2,000 and 2,500, ones at 3,000 and 3,500; a row that would pass the runway's middle is left out
      if (kind === 'precision') {
        for (const [s, n] of [[500, 3], [1500, 3], [2000, 2], [2500, 2], [3000, 1], [3500, 1]]) {
          if ((s + 75) * FT > e.toOpposite / 2) continue;
          for (let j = 0; j < n; j++) {
            const t0 = (36 + j * 11) * FT;
            for (const side of [-1, 1]) paint.push(box(e, 'tdz', s * FT, (s + 75) * FT, side > 0 ? t0 : -(t0 + 6 * FT), side > 0 ? t0 + 6 * FT : -t0));
          }
        }
      }
    }
    // a displaced threshold: a 10 ft bar across the runway at the threshold, arrowheads before it and arrows along the
    // centre line in the displaced area (the area serves take-offs). ESTIMATED: arrowheads 45 ft long, 15 ft across
    // and 3 ft strokes at six places across; arrows 120 ft long every 200 ft, the width of the centre line.
    if (e.displaced >= 1 && kind && kind !== 'none') {
      const half = W / 2 - 3 * FT;
      paint.push(box(e, 'threshold-bar', -10 * FT, 0, -half, half));
      for (const tc of [-57.5, -34.5, -11.5, 11.5, 34.5, 57.5]) {
        for (const side of [-1, 1]) paint.push(stroke(e, 'arrowhead', [-60 * FT, (tc + side * 7.5) * FT], [-15 * FT, tc * FT], 3 * FT));
      }
      const w = (kind === 'precision' ? 36 : kind === 'non-precision' ? 18 : 12) * IN;
      for (let k = 0; ; k++) {
        const tip = -(140 + 200 * k) * FT, tail = tip - 120 * FT;
        if (tail < -e.displaced + 10 * FT) break;
        paint.push(box(e, 'arrow', tail, tip - 10 * FT, -w / 2, w / 2));
        for (const side of [-1, 1]) paint.push(stroke(e, 'arrow', [tip - 30 * FT, side * 15 * FT], [tip, 0], w));
      }
    }
    // rubber where wheels touch down: soft dark bands about the centre line from 300 to 2,500 ft, thickest in the
    // middle, in 30 m pieces whose darkness follows a smooth envelope (ESTIMATED from photographs of busy runways)
    if (instrument) {
      const s0 = 300 * FT, s1 = 2500 * FT, piece = 30;
      for (let s = s0; s < s1 - 1; s += piece) {
        const mid = (s + Math.min(s1, s + piece)) / 2, x = (mid - s0) / (s1 - s0);
        const env = Math.sin(Math.PI * Math.min(1, x * 1.6)) ** 0.7 * (1 - 0.5 * x);
        for (const [hw, a] of [[11, 0.16], [6.5, 0.2], [3, 0.18]]) {
          rubber.push(box(e, 'rubber', s, Math.min(s1, s + piece), -hw, hw, { colour: 'rubber', alpha: a * env, soft: 1 }));
        }
      }
    }
  }

  // per runway: centre line (120 ft stripes, gaps close to 80 ft, between the designations, 40 ft clear of each) and
  // side stripes (3 ft at both edges, end to end); 36 in wide on a precision runway, 18 in non-precision, 12 in basic
  for (const r of runways) {
    const ea = ends[r.ends[0]], eb = ends[r.ends[1]];
    const da = designationSpan(ea), db = designationSpan(eb);
    const kinds = [ea.data.markingKind, eb.data.markingKind];
    const w = (kinds.includes('precision') ? 36 : kinds.includes('non-precision') ? 18 : 12) * IN;
    const from = (da ? da.end : 0) + 40 * FT, to = ea.toOpposite - (db ? db.end : 0) - 40 * FT;
    const stripe = 120 * FT;
    const n = Math.max(1, Math.round((to - from + 80 * FT) / (200 * FT)));
    const gap = n > 1 ? (to - from - n * stripe) / (n - 1) : 0;
    for (let k = 0; k < n; k++) {
      const s = from + k * (stripe + gap);
      for (const [a, b] of pieces(s, s + stripe, 25)) paint.push(box(ea, 'centreline', a, b, -w / 2, w / 2));
    }
    if (kinds.some((k) => k === 'precision' || k === 'non-precision')) {
      for (const side of [-1, 1]) {
        const t0 = side > 0 ? r.width / 2 - 3 * FT : -r.width / 2, t1 = side > 0 ? r.width / 2 : -r.width / 2 + 3 * FT;
        for (const [a, b] of pieces(-ea.displaced, ea.toFarEnd, 25)) paint.push(box(ea, 'side', a, b, t0, t1));
      }
    }
  }

  // where a longer runway crosses, the shorter one's paint stops at its edges: such marks are cut into 2 m pieces and
  // the pieces inside the longer runway left out
  const out = [];
  for (const list of [rubber, paint]) {
    for (const m of list) {
      const own = runways.find((r) => r.id === m.runway);
      const over = runways.filter((r) => r.length > own.length && markCorners(m).some(([x, y]) => inRunway(r, x, y, 0)));
      if (!over.length) { out.push(m); continue; }
      for (const p of splitMark(m, 2)) if (!over.some((r) => inRunway(r, p.cx, p.cy, 1))) out.push({ ...p, cut: true });
    }
  }
  return out;
}

const inRunway = (r, x, y, margin) => {
  const q = r.local(x, y);
  return q.s > -margin && q.s < r.length + margin && Math.abs(q.t) < r.width / 2 + margin;
};

/** [a, b] cut into pieces at most `len` long. */
function pieces(a, b, len) {
  const n = Math.max(1, Math.ceil((b - a) / len - 1e-9));
  const out = [];
  for (let i = 0; i < n; i++) out.push([a + ((b - a) * i) / n, a + ((b - a) * (i + 1)) / n]);
  return out;
}

/** A mark cut along its length into pieces at most `len` long. */
export function splitMark(m, len) {
  if (m.hl * 2 <= len) return [m];
  return pieces(-m.hl, m.hl, len).map(([a, b]) => {
    const c = (a + b) / 2, hl = (b - a) / 2;
    const p = { ...m, cx: m.cx + m.ux * c, cy: m.cy + m.uy * c, hl };
    if (m.cs !== undefined) {
      p.cs = m.cs + Math.cos(m.angle) * c; p.ct = m.ct + Math.sin(m.angle) * c;
      if (m.s0 !== undefined) Object.assign(p, { s0: p.cs - hl, s1: p.cs + hl });
    }
    return p;
  });
}

/** A map mark between two points, `w` wide. */
function lineMark(kind, ax, ay, bx, by, w, extra = {}) {
  const l = Math.hypot(bx - ax, by - ay);
  return { kind, colour: 'yellow', alpha: 1, soft: 0, cx: (ax + bx) / 2, cy: (ay + by) / 2, ux: (bx - ax) / l, uy: (by - ay) / l, hl: l / 2, hw: w / 2, ...extra };
}

/**
 * A polyline as yellow marks in pieces at most `len` long, each lengthened by half its width at both ends so bends
 * close; pieces off the pavement or on a runway are left out.
 */
function polylineMarks(kind, line, w, keep, extra, len = 12) {
  const out = [];
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], ay = line[i + 1], bx = line[i + 2], by = line[i + 3];
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 0.05) continue;
    for (const [a, b] of pieces(0, l, len)) {
      const p = lineMark(kind, ax + ((bx - ax) * a) / l, ay + ((by - ay) * a) / l, ax + ((bx - ax) * b) / l, ay + ((by - ay) * b) / l, w, extra);
      if (!keep(p.cx, p.cy)) continue;
      p.hl += w / 2;
      out.push(p);
    }
  }
  return out;
}

/**
 * Taxiway paint, yellow: OpenStreetMap's taxiway and taxilane centre lines (6 in wide), runway holding positions (two
 * solid and two dashed 12 in lines 12 in apart, the dashes 3 ft long toward the runway), the non-movement area boundary
 * (one solid and one dashed), and lead-in lines to the stands on the aprons with a stop bar. Nothing is painted off the
 * FAA's pavement or on a runway.
 * @param {object} data airport.json
 * @param {ReturnType<import('./geometry.js').runwayFrames>} frames
 * @param {ReturnType<import('./geometry.js').createPavementIndex>} pavement
 */
export function taxiwayMarkings(data, frames, pavement) {
  const { runways } = frames;
  const onRunway = (x, y) => runways.some((r) => inRunway(r, x, y, 0.5));
  const keep = (x, y) => pavement.on(x, y) && !onRunway(x, y);
  const out = [];
  for (const tw of data.taxiways || []) out.push(...polylineMarks('taxi-centre', tw.line, 6 * IN, keep, { taxiway: tw.ref }));

  // holding positions: across the taxiway at the point, as wide as the pavement there (at most 25 m either side)
  const runwayDist = (x, y) => Math.min(...runways.map((r) => {
    const q = r.local(x, y);
    const ds = q.s < 0 ? -q.s : q.s > r.length ? q.s - r.length : 0;
    return Math.hypot(ds, Math.max(0, Math.abs(q.t) - r.width / 2));
  }));
  (data.holdingPositions || []).forEach((h, id) => {
    if (h.dir === null || h.dir === undefined || !h.type) return;
    const a = (h.dir * Math.PI) / 180;
    let ax = [Math.sin(a), Math.cos(a)];
    // the taxiway's axis points toward the runway
    if (runwayDist(h.x + ax[0] * 5, h.y + ax[1] * 5) > runwayDist(h.x - ax[0] * 5, h.y - ax[1] * 5)) ax = [-ax[0], -ax[1]];
    const across = [ax[1], -ax[0]];
    const reach = (sign) => {
      for (let d = 0.5; d <= 25; d += 0.25) if (!pavement.on(h.x + across[0] * d * sign, h.y + across[1] * d * sign)) return d - 0.25;
      return 12;
    };
    const r0 = reach(-1), r1 = reach(1);
    if (r0 + r1 < 3) return;
    const lines = h.type === 'runway' || h.type === 'LAHSO'
      ? [[-3, 'hold-solid'], [-1, 'hold-solid'], [1, 'hold-dash'], [3, 'hold-dash']]
      : [[-1, 'hold-solid'], [1, 'hold-dash']];
    lines.forEach(([off, kind], line) => {
      const ox = h.x + ax[0] * off * FT, oy = h.y + ax[1] * off * FT;
      const at = (d) => [ox + across[0] * d, oy + across[1] * d];
      const extra = { hold: id, holdType: h.type, line };
      if (kind === 'hold-solid') {
        const [p0, p1] = [at(-r0), at(r1)];
        for (const p of polylineMarks(kind, [...p0, ...p1], 12 * IN, keep, extra, 6)) { p.hl -= 6 * IN; out.push(p); }
      } else {
        for (let d = -r0; d + 3 * FT <= r1 + 1e-6; d += 6 * FT) {
          const p0 = at(d), p1 = at(d + 3 * FT);
          const m = lineMark(kind, ...p0, ...p1, 12 * IN, extra);
          if (keep(m.cx, m.cy)) out.push(m);
        }
      }
    });
  });

  // stand lead-in lines and stop bars, for the stands on the aprons
  for (const s of data.stands || []) {
    if (!s.onApron || !s.lead) continue;
    out.push(...polylineMarks('lead-in', s.lead, 6 * IN, keep, { stand: s.osmId ?? s.ref }));
    const a = (s.heading * Math.PI) / 180;
    const [hx, hy] = [Math.sin(a), Math.cos(a)];
    const m = lineMark('stop-bar', s.x - hy * 1.5, s.y + hx * 1.5, s.x + hy * 1.5, s.y - hx * 1.5, 12 * IN, { stand: s.osmId ?? s.ref });
    if (keep(m.cx, m.cy)) out.push(m);
  }
  return out;
}

// The airport's paint (plan 03, section 7.10; F4.2), the pure part: runway markings by each end's marking type at the
// FAA's dimensions (AC 150/5340-1M, section 7.10's table), taxiway centre lines, holding positions and stand lead-in
// lines from OpenStreetMap, and nothing off its pavement.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FT, runwayFrames, createPavementIndex } from '../../../src/flight/airport/geometry.js';
import { runwayMarkings, taxiwayMarkings, GLYPHS, markCorners } from '../../../src/flight/airport/markings.js';

const data = JSON.parse(readFileSync(new URL('../../../public/data/lv/airport.json', import.meta.url), 'utf8'));
const frames = runwayFrames(data);
const marks = runwayMarkings(data, frames);
const pavement = createPavementIndex(data);
const taxi = taxiwayMarkings(data, frames, pavement);
const at = (end, kind) => marks.filter((m) => m.end === end && m.kind === kind);
const ft = (m) => m / FT;

describe('threshold markings', () => {
  for (const end of Object.keys(frames.ends)) {
    it(`${end}: twelve stripes 150 ft by 5.75 ft from 20 ft past the threshold, 69 ft either side`, () => {
      const s = at(end, 'threshold');
      expect(s.length).toBe(12);
      for (const m of s) {
        expect(ft(m.s0)).toBeCloseTo(20, 6);
        expect(ft(m.s1 - m.s0)).toBeCloseTo(150, 6);
        expect(ft(m.t1 - m.t0)).toBeCloseTo(5.75, 6);
      }
      expect(ft(Math.max(...s.map((m) => m.t1)))).toBeCloseTo(69, 6);
      expect(ft(Math.min(...s.map((m) => m.t0)))).toBeCloseTo(-69, 6);
      // a centre gap of two stripe widths
      expect(ft(Math.min(...s.filter((m) => m.t0 > 0).map((m) => m.t0)))).toBeCloseTo(5.75, 6);
    });
  }
});

describe('designation', () => {
  it('reads the end\'s name, numerals 60 ft high, the letter nearest the threshold', () => {
    for (const [end] of Object.entries(frames.ends)) {
      const d = at(end, 'designation');
      const chars = [...new Set(d.map((m) => m.glyph))];
      const name = end.replace(/^0/, '');
      expect(chars.sort()).toEqual([...new Set(name.split(''))].sort());
      for (const c of chars) {
        const g = d.filter((m) => m.glyph === c);
        // 1R's number falls inside 8L/26R, where the longer runway's paint wins
        if (g.some((m) => m.cut)) continue;
        const s0 = Math.min(...g.map((m) => m.s0 ?? m.cs)), s1 = Math.max(...g.map((m) => m.s1 ?? m.cs));
        expect(ft(s1 - s0)).toBeCloseTo(60, 0);
      }
      const letter = name.slice(-1);
      const letterS = Math.min(...d.filter((m) => m.glyph === letter).map((m) => m.s0 ?? m.cs));
      const numS = Math.min(...d.filter((m) => m.glyph !== letter).map((m) => m.s0 ?? m.cs));
      expect(letterS).toBeLessThan(numS);
      // past the threshold stripes
      expect(ft(letterS)).toBeGreaterThanOrEqual(190 - 1e-6);
    }
  });
  it('has a glyph for every digit and the three letters', () => {
    for (const c of '0123456789LRC') expect(GLYPHS[c].length).toBeGreaterThan(0);
  });
});

describe('centre line', () => {
  it('is 120 ft stripes with gaps near 80 ft, 36 in wide on a precision runway and 18 in on the others', () => {
    for (const r of frames.runways) {
      const c = marks.filter((m) => m.runway === r.id && m.kind === 'centreline');
      expect(c.length).toBeGreaterThan(20);
      const precision = r.ends.some((e) => frames.ends[e].data.markingKind === 'precision');
      for (const m of c) expect(ft(m.t1 - m.t0)).toBeCloseTo(precision ? 3 : 1.5, 6);
      // pieces of stripes; join them back by s in the first end's frame
      const e = frames.ends[r.ends[0]];
      const segs = c.map((m) => [m.s0, m.s1]).sort((a, b) => a[0] - b[0]);
      const stripes = [];
      for (const [a, b] of segs) {
        const last = stripes[stripes.length - 1];
        if (last && a - last[1] < 0.01) last[1] = b; else stripes.push([a, b]);
      }
      expect(e.id).toBe(r.ends[0]);
      for (const [a, b] of stripes) expect(ft(b - a)).toBeLessThanOrEqual(120 + 1e-6);
      // whole stripes (those cut where a longer runway crosses are shorter), and the gaps between them
      const full = stripes.filter(([a, b]) => ft(b - a) > 119.9);
      for (let i = 1; i < full.length; i++) {
        const gap = ft(full[i][0] - full[i - 1][1]);
        if (gap < 150) expect(gap).toBeGreaterThan(70);
        if (gap < 150) expect(gap).toBeLessThan(90);
      }
    }
  });
});

describe('aiming points and touchdown zone', () => {
  it('has two aiming-point blocks 150 ft by 30 ft from 1,020 ft, inner edges 72 ft apart, at every end', () => {
    for (const end of Object.keys(frames.ends)) {
      const a = at(end, 'aiming');
      expect(a.length).toBe(2);
      for (const m of a) {
        expect(ft(m.s0)).toBeCloseTo(1020, 6);
        expect(ft(m.s1 - m.s0)).toBeCloseTo(150, 6);
        expect(ft(m.t1 - m.t0)).toBeCloseTo(30, 6);
      }
      expect(ft(Math.min(...a.filter((m) => m.t0 > 0).map((m) => m.t0)))).toBeCloseTo(36, 6);
    }
  });
  it('has touchdown-zone bars 75 ft by 6 ft in threes, threes, twos, twos and ones on the precision ends only', () => {
    for (const [end, e] of Object.entries(frames.ends)) {
      const z = at(end, 'tdz');
      if (e.data.markingKind !== 'precision') { expect(z.length, end).toBe(0); continue; }
      const rows = new Map();
      for (const m of z) {
        expect(ft(m.s1 - m.s0)).toBeCloseTo(75, 6);
        expect(ft(m.t1 - m.t0)).toBeCloseTo(6, 6);
        const k = Math.round(ft(m.s0));
        rows.set(k, (rows.get(k) || 0) + 1);
      }
      expect([...rows.entries()].sort((a, b) => a[0] - b[0])).toEqual([[500, 6], [1500, 6], [2000, 4], [2500, 4], [3000, 2], [3500, 2]]);
    }
  });
});

describe('side stripes and displaced thresholds', () => {
  it('has side stripes 3 ft wide at both edges', () => {
    for (const r of frames.runways) {
      const sides = marks.filter((m) => m.runway === r.id && m.kind === 'side');
      expect(sides.length).toBeGreaterThan(0);
      for (const m of sides) {
        expect(ft(m.t1 - m.t0)).toBeCloseTo(3, 6);
        expect(Math.max(Math.abs(m.t0), Math.abs(m.t1))).toBeCloseTo(r.width / 2, 6);
      }
    }
  });
  it('marks a displaced threshold with a 10 ft bar, arrowheads and arrows, and only where it is displaced', () => {
    for (const [end, e] of Object.entries(frames.ends)) {
      const bar = at(end, 'threshold-bar'), heads = at(end, 'arrowhead'), arrows = at(end, 'arrow');
      if (e.displaced < 1) { expect(bar.length + heads.length + arrows.length, end).toBe(0); continue; }
      expect(bar.length).toBe(1);
      expect(ft(bar[0].s1 - bar[0].s0)).toBeCloseTo(10, 6);
      expect(bar[0].s1).toBeLessThanOrEqual(1e-9);
      expect(heads.length).toBeGreaterThan(0);
      expect(arrows.length).toBeGreaterThan(0);
      // everything of the displacement lies in the displaced area
      for (const m of [...heads, ...arrows]) for (const [s] of markCorners(m, 'local')) expect(s).toBeGreaterThan(-e.displaced - 0.01);
    }
  });
});

describe('rubber', () => {
  it('darkens the touchdown zone of every end, under the paint', () => {
    for (const end of Object.keys(frames.ends)) expect(at(end, 'rubber').length).toBeGreaterThan(0);
    const firstPaint = marks.findIndex((m) => m.kind !== 'rubber');
    expect(marks.slice(firstPaint).some((m) => m.kind === 'rubber')).toBe(false);
  });
});

describe('taxiway paint', () => {
  it('draws yellow centre lines 6 in wide from OpenStreetMap, off the runways', () => {
    const c = taxi.filter((m) => m.kind === 'taxi-centre');
    expect(c.length).toBeGreaterThan(1000);
    for (const m of c) {
      expect(m.colour).toBe('yellow');
      expect(m.hw * 2).toBeCloseTo(6 * 0.0254, 6);
      for (const r of frames.runways) {
        const q = r.local(m.cx, m.cy);
        expect(q.s > 0 && q.s < r.length && Math.abs(q.t) < r.width / 2).toBe(false);
      }
    }
  });
  it('draws runway holding positions as two solid and two dashed lines, the dashes toward the runway', () => {
    const h = taxi.filter((m) => m.kind === 'hold-solid' || m.kind === 'hold-dash');
    expect(h.length).toBeGreaterThan(66 * 4);
    const ids = new Set(h.map((m) => m.hold));
    const runwayDist = (m) => Math.min(...frames.runways.map((r) => {
      const q = r.local(m.cx, m.cy);
      const ds = q.s < 0 ? -q.s : q.s > r.length ? q.s - r.length : 0;
      return Math.hypot(ds, Math.max(0, Math.abs(q.t) - r.width / 2));
    }));
    let checked = 0, right = 0;
    expect(ids.size).toBeGreaterThan(60);
    for (const id of ids) {
      const ms = h.filter((m) => m.hold === id);
      const solid = ms.filter((m) => m.kind === 'hold-solid'), dash = ms.filter((m) => m.kind === 'hold-dash');
      const type = ms[0].holdType;
      if (type !== 'runway' && type !== 'LAHSO') continue;
      expect(new Set(solid.map((m) => m.line)).size).toBe(2);
      expect(new Set(dash.map((m) => m.line)).size).toBe(2);
      // the dashes are nearer the runway than the solid lines
      const ds = dash.reduce((a, m) => a + runwayDist(m), 0) / dash.length, ss = solid.reduce((a, m) => a + runwayDist(m), 0) / solid.length;
      checked++;
      if (ds < ss) right++;
    }
    // a few stand between two runways, where "toward the runway" depends on which one they hold for
    expect(right / checked).toBeGreaterThan(0.9);
  });
  it('draws lead-in lines to the stands on the aprons', () => {
    const lead = taxi.filter((m) => m.kind === 'lead-in');
    const stands = new Set(lead.map((m) => m.stand));
    expect(stands.size).toBeGreaterThan(150);
  });
});

describe('nothing off its pavement', () => {
  it('keeps every runway mark inside its runway', () => {
    for (const m of marks) {
      const r = frames.runways.find((x) => x.id === m.runway);
      for (const [x, y] of markCorners(m)) {
        const q = r.local(x, y);
        expect(q.s).toBeGreaterThan(-0.01);
        expect(q.s).toBeLessThan(r.length + 0.01);
        expect(Math.abs(q.t)).toBeLessThan(r.width / 2 + 0.01);
      }
    }
  });
  it('keeps the shorter runway\'s paint out of the longer runway where they cross', () => {
    const long = frames.runways.find((r) => r.id === '08L/26R');
    for (const m of marks.filter((x) => x.runway === '01L/19R' || x.runway === '01R/19L')) {
      const q = long.local(m.cx, m.cy);
      expect(q.s > 0 && q.s < long.length && Math.abs(q.t) < long.width / 2).toBe(false);
    }
  });
  it('keeps every taxiway mark on the FAA pavement (centre within 0.5 m)', () => {
    let off = 0;
    for (const m of taxi) if (!pavement.on(m.cx, m.cy, 0.5)) off++;
    expect(off).toBe(0);
  });
});

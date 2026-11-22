import { describe, it, expect } from 'vitest';
import { edgesAt, laneCentreAt, taperAt, unionIds, blend } from '../../../src/drive/roadnet/crosssection.js';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';
import { fixture, fixtureFiles } from './helpers.js';

const [main, south] = fixture().roads;
const laneIds = (cs) => cs.strips.filter((st) => st.kind === 'lane').map((st) => st.id);

/** The fixture with every taper taken out: how a version 1 file without tapers reads. */
function withoutTapers() {
  const { json, bin } = fixtureFiles();
  for (const sec of json.roads[0].sections) delete sec.taper;
  return decodeRoadNet(json, bin).roads[0];
}

describe('crosssection', () => {
  it('puts lane edges 3.66 m apart, centred, with shoulders outside', () => {
    const cs = edgesAt(main, 500);
    const lanes = cs.lines.map((l) => l.d);
    expect(lanes).toHaveLength(4);
    for (let i = 1; i < lanes.length; i++) expect(lanes[i - 1] - lanes[i]).toBeCloseTo(3.66, 9);
    expect(lanes[0]).toBeCloseTo(5.49, 9);
    expect(cs.left).toBeCloseTo(5.49 + 3.05, 9);
    expect(cs.right).toBeCloseTo(-5.49 - 3.05, 9);
    expect(cs.lines.map((l) => l.kind)).toEqual(['yellow', 'broken', 'broken', 'white']);
    expect(cs.strips.map((s) => s.kind)).toEqual(['shoulder', 'lane', 'lane', 'lane', 'shoulder']);
    expect(cs.edges).toHaveLength(6);
    expect(laneIds(cs)).toEqual([1, 2, 3]);
    expect(cs.taper).toBeNull();
  });

  it('without tapers changes section abruptly at s0, as version 1 files always did', () => {
    const road = withoutTapers();
    expect(edgesAt(road, 1600 - 1e-6).strips).toHaveLength(5);
    expect(edgesAt(road, 1600).strips).toHaveLength(6);
    expect(edgesAt(road, 1600, 'before').strips).toHaveLength(5);
    expect(edgesAt(road, 1600).right).toBeCloseTo(-9.15 - 3.05, 9);
    expect(edgesAt(road, 3000).lines[0].d).toBeCloseTo(1.83, 9);
  });

  it('opens an added lane over its taper: zero width at the start, full at the end, others still', () => {
    const at = (s, side) => edgesAt(main, s, side);
    expect(at(1600, 'before').strips).toHaveLength(5); // just before: the old section, no taper
    const start = at(1600);
    expect(start.taper).toMatchObject({ index: 1, from: 0, t: 0, u: 0 });
    expect(laneIds(start)).toEqual([1, 2, 3, 4]);
    expect(start.lines[3].d - start.lines[4].d).toBeCloseTo(0, 9); // lane 4 has no width yet
    const mid = at(1728.1);
    expect(mid.lines[3].d - mid.lines[4].d).toBeCloseTo(1.83, 6);
    expect(at(1856.2, 'before').lines[3].d - at(1856.2, 'before').lines[4].d).toBeCloseTo(3.66, 9);
    expect(at(1856.2).taper).toBeNull(); // from its end on, the section's own cross-section
    for (const s of [1600, 1650, 1728.1, 1800, 1856.2]) {
      expect(laneCentreAt(main, 2, s)).toBeCloseTo(0, 9); // lanes 1-3 do not move
      expect(at(s).lines[0].d).toBeCloseTo(5.49, 9);
    }
  });

  it('closes a dropped lane over the taper before its boundary', () => {
    const before = edgesAt(main, 2143.8, 'before'), start = edgesAt(main, 2143.8);
    expect(before.taper).toBeNull();
    expect(start.taper).toMatchObject({ index: 2, from: 1 });
    expect(laneIds(start)).toEqual([1, 2, 3, 4]);
    expect(start.edges).toEqual(before.edges.map((d) => expect.closeTo(d, 9)));
    const end = edgesAt(main, 2400, 'before');
    expect(end.lines[0].d - end.lines[1].d).toBeCloseTo(0, 9); // lane 1 has narrowed to nothing
    expect(edgesAt(main, 2400).lines[0].d).toBeCloseTo(1.83, 9);
    expect(laneIds(edgesAt(main, 2400))).toEqual([2, 3, 4]);
    for (const s of [2143.8, 2200, 2300, 2400]) expect(laneCentreAt(main, 2, s)).toBeCloseTo(0, 9);
  });

  it('hides the line beside a lane narrower than half its width, switching at the taper middle', () => {
    expect(edgesAt(main, 1700).lines.map((l) => l.kind)).toEqual(['yellow', 'broken', 'broken', 'none', 'white']);
    expect(edgesAt(main, 1728.1, 'before').lines[3].kind).toBe('none');
    expect(edgesAt(main, 1728.1).lines[3].kind).toBe('broken');
    expect(edgesAt(main, 2200).lines.map((l) => l.kind)).toEqual(['yellow', 'broken', 'broken', 'broken', 'white']);
    expect(edgesAt(main, 2300).lines.map((l) => l.kind)).toEqual(['yellow', 'none', 'broken', 'broken', 'white']);
    // the edge line follows the pavement edge, whatever lane is outermost
    const cs = edgesAt(main, 1650);
    expect(cs.lines[cs.lines.length - 1].d).toBeCloseTo(cs.strips[cs.strips.length - 2].right, 12);
  });

  it('moves every edge continuously and never faster than 1 m per 20 m', () => {
    let worst = 0;
    let prev = edgesAt(main, 1400);
    for (let s = 1400.5; s <= 2600; s += 0.5) {
      const cs = edgesAt(main, s);
      if (cs.edges.length === prev.edges.length) {
        cs.edges.forEach((d, k) => { worst = Math.max(worst, Math.abs(d - prev.edges[k]) / 0.5); });
      } else {
        // a lane appears or goes at a taper end with zero width: the outer edges carry straight on
        expect(cs.left).toBeCloseTo(prev.left, 2);
        expect(cs.right).toBeCloseTo(prev.right, 2);
      }
      prev = cs;
    }
    expect(worst).toBeGreaterThan(0.02); // the tapers are there
    expect(worst).toBeLessThanOrEqual(1 / 20);
  });

  it('finds tapers by chainage, inclusive of the start after and of the end before', () => {
    expect(taperAt(main, 1600)?.i).toBe(1);
    expect(taperAt(main, 1600, 'before')).toBeNull();
    expect(taperAt(main, 1856.2)).toBeNull();
    expect(taperAt(main, 1856.2, 'before')?.i).toBe(1);
    expect(taperAt(main, 2000)).toBeNull();
  });

  it('merges lane lists in order: previous-only, then this-only, then shared', () => {
    expect(unionIds([1, 2, 3], [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(unionIds([1, 2, 3], [5, 1, 2, 3])).toEqual([5, 1, 2, 3]);
    expect(unionIds([1, 2, 3, 4], [2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(unionIds([6, 1, 2], [7, 1, 2])).toEqual([6, 7, 1, 2]);
    expect(blend(0.5)).toBe(0.5);
  });

  it('blends across a short section that lies wholly inside a taper', () => {
    const lane = (id) => ({ w: 3.66, id, kind: 'drive', line: 'broken' });
    const side = { shoulder: 3.05, edge: 'yellow' };
    const road = {
      sections: [
        { s0: 0, s1: 100, lanes: [lane(1), lane(2)], placement: 'centre', left: side, right: { shoulder: 3.05, edge: 'white' } },
        { s0: 100, s1: 140, lanes: [lane(1), lane(2), lane(3), lane(4)], placement: 'centre', left: side, right: { shoulder: 3.05, edge: 'white' } },
        { s0: 140, s1: 400, lanes: [lane(1), lane(2), lane(3)], placement: 'centre', left: side, right: { shoulder: 3.05, edge: 'white' }, taper: { s0: 60, s1: 260 } },
      ],
    };
    const cs = edgesAt(road, 120);
    expect(cs.sectionIndex).toBe(1);
    expect(cs.taper).toMatchObject({ index: 2, from: 0 });
    expect(laneIds(cs)).toEqual([1, 2, 3]); // lane 4 lives only inside the taper and never shows
    expect(edgesAt(road, 60).left).toBeCloseTo(3.66 + 3.05, 9);
    expect(edgesAt(road, 260).left).toBeCloseTo(5.49 + 3.05, 9);
  });

  it('honours placement: left_of:1 puts the reference line on the left pavement edge', () => {
    const cs = edgesAt(south, 100);
    expect(cs.lines[0].d).toBe(0);
    expect(cs.lines[2].d).toBeCloseTo(-7.32, 9);
    expect(cs.left).toBeCloseTo(1.22, 9);
  });

  it('places middle_of and right_of', () => {
    const road = { sections: [{ s0: 0, s1: 10, placement: 'middle_of:2', lanes: [{ w: 3 }, { w: 4 }], left: { shoulder: 1, edge: 'yellow' }, right: { shoulder: 2, edge: 'white' } }] };
    expect(edgesAt(road, 1).lines.map((l) => l.d)).toEqual([5, 2, -2]);
    road.sections[0] = { ...road.sections[0], placement: 'right_of:1' };
    expect(edgesAt(road, 1).lines.map((l) => l.d)).toEqual([3, 0, -4]);
  });
});

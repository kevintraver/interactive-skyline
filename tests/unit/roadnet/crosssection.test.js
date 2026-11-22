import { describe, it, expect } from 'vitest';
import { edgesAt } from '../../../src/drive/roadnet/crosssection.js';
import { fixture } from './helpers.js';

const [main, south] = fixture().roads;

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
  });

  it('changes section abruptly at s0, and reports either side of the boundary', () => {
    expect(edgesAt(main, 1600 - 1e-6).strips).toHaveLength(5);
    expect(edgesAt(main, 1600).strips).toHaveLength(6);
    expect(edgesAt(main, 1600, 'before').strips).toHaveLength(5);
    expect(edgesAt(main, 3000).lines[0].d).toBeCloseTo(7.32, 9);
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

// The cabin layout (plan 03, sections 4.3 and 7.4; F1.5 v0, completed by F3.6). Expected values come from the
// sources, not from the code's own arithmetic: the window stations traced from the to-scale seat map [B6] (44 on the
// left and 46 on the right, blanks at 13.58 m on the left and 14.66 m on both sides, a window in each overwing exit
// at 16.70 and 17.67 m [B5]), the seat layout of section 7.4, which rows sit beside the wing's edges, the blank-wall
// seats, and the default-seat rule. The numbers reach lopa.js through dimensions.js, written from spec.py.
import { describe, it, expect } from 'vitest';
import { windowStations, seat, parseSeat, defaultSeat, rowFront, seatFor, wingPlace, allSeats, ROWS, LETTERS, bodyZ, stationOf, ALIGNED, BEHIND_TE } from '../../../src/flight/cabin/lopa.js';
import { WING, WINDOW, FUSELAGE } from '../../../src/flight/aircraft/dimensions.js';

const IN = 0.0254;

describe('window stations', () => {
  it('has 44 windows on the left and 46 on the right', () => {
    expect(windowStations('left').filter((w) => !w.blank)).toHaveLength(44);
    expect(windowStations('right').filter((w) => !w.blank)).toHaveLength(46);
  });

  it('starts 5.6 m aft of the nose on the right and 6.1 m on the left, and ends at 30.5 m on both', () => {
    const right = windowStations('right').filter((w) => !w.blank), left = windowStations('left').filter((w) => !w.blank);
    expect(right[0].station).toBeCloseTo(5.588, 3);
    expect(left[0].station).toBeCloseTo(6.102, 3);
    expect(right.at(-1).station).toBeCloseTo(30.47, 3);
    expect(left.at(-1).station).toBeCloseTo(30.47, 3);
  });

  it('has blanks at 13.58 m on the left and 14.66 m on both sides, and no others', () => {
    const blanks = (side) => windowStations(side).filter((w) => w.blank).map((w) => w.station);
    expect(blanks('left')).toEqual([13.58, 14.656]);
    expect(blanks('right')).toEqual([14.656]);
  });

  it('puts a window in each overwing exit, at 16.70 and 17.67 m', () => {
    for (const side of ['left', 'right']) {
      const st = windowStations(side).filter((w) => !w.blank).map((w) => w.station);
      for (const exit of [16.70, 17.67]) expect(Math.min(...st.map((s) => Math.abs(s - exit)))).toBeLessThan(0.005);
    }
  });

  it('pitches the positions between 18.5 and 23.5 in (20 in on the original fuselage, about 22 in in the plugs), except across the exits', () => {
    const st = windowStations('right').map((w) => w.station);
    for (let i = 1; i < st.length; i++) {
      const p = (st[i] - st[i - 1]) / IN;
      if (st[i - 1] > 16.6 && st[i] < 17.8) { expect(p).toBeCloseTo(38, 0); continue; }
      expect(p).toBeGreaterThan(18.5);
      expect(p).toBeLessThan(23.5);
    }
  });

  it('is sorted front to back, each entry carrying its side, and comes from spec.py through dimensions.js', () => {
    const w = windowStations('left');
    for (let i = 1; i < w.length; i++) expect(w[i].station).toBeGreaterThan(w[i - 1].station);
    expect(w.every((x) => x.side === 'left')).toBe(true);
    expect(windowStations('right').filter((x) => !x.blank).map((x) => x.station)).toEqual([...WINDOW.right]);
  });
});

describe('rows', () => {
  it('has 30 rows, the first seat front 6.1 m aft of the nose, 31 in apart except 38 in at rows 15 and 16', () => {
    expect(ROWS).toBe(30);
    expect(LETTERS).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(rowFront(1)).toBeCloseTo(6.1, 6);
    expect(rowFront(2) - rowFront(1)).toBeCloseTo(31 * IN, 4);
    expect(rowFront(15) - rowFront(14)).toBeCloseTo(38 * IN, 4);
    expect(rowFront(16) - rowFront(15)).toBeCloseTo(38 * IN, 4);
    expect(rowFront(17) - rowFront(16)).toBeCloseTo(31 * IN, 4);
  });

  it('puts the wing leading edge beside row 12, the exits ahead of rows 15 and 16, the trailing edge beside row 20', () => {
    // "beside": the row whose seated passenger (halfway from the seat front to the eye, 0.55 m aft) is nearest
    const beside = (station) => { let best = 1; for (let r = 1; r <= ROWS; r++) if (Math.abs(rowFront(r) + 0.275 - station) < Math.abs(rowFront(best) + 0.275 - station)) best = r; return best; };
    expect(beside(WING.rootLE)).toBe(12);
    expect(beside(WING.rootTE)).toBe(20);
    expect(16.70).toBeLessThan(rowFront(15));
    expect(17.67).toBeLessThan(rowFront(16));
    expect(17.67).toBeGreaterThan(rowFront(15));
  });
});

describe('seat()', () => {
  it('puts the eye 0.55 m aft of the seat front and 1.20 m above the floor, outboard on the right for F', () => {
    const s = seat(22, 'F');
    expect(s.id).toBe('22F');
    expect(s.side).toBe('right');
    expect(s.eyeStation).toBeCloseTo(rowFront(22) + 0.55, 6);
    expect(stationOf(s.eye.z)).toBeCloseTo(s.eyeStation, 6);
    expect(s.eye.y).toBeCloseTo(FUSELAGE.floorAtWing + 1.2, 6);
    expect(FUSELAGE.floorAtWing).toBeCloseTo(2.95, 2); // [B1] door sill in body axes (spec.py floor_z)
    expect(s.eye.x).toBeGreaterThan(1.3);
    expect(s.eye.x).toBeLessThan(1.7);
    expect(seat(22, 'A').eye.x).toBeCloseTo(-s.eye.x, 9);
  });

  it('puts the seat back behind the eye and the seat ahead about 0.55 m in front of it', () => {
    const s = seat(22, 'F');
    expect(s.backStation - s.eyeStation).toBeGreaterThan(0.1);
    expect(s.backStation - s.eyeStation).toBeLessThan(0.25);
    expect(s.eyeStation - s.aheadBackStation).toBeGreaterThan(0.45);
    expect(s.eyeStation - s.aheadBackStation).toBeLessThan(0.7);
    expect(seat(1, 'A').aheadBackStation).toBeLessThan(seat(1, 'A').front);
  });

  it('gives the three nearest window positions with their offsets, nearest first', () => {
    const s = seat(22, 'F');
    expect(s.nearest).toHaveLength(3);
    const d = s.nearest.map((w) => Math.abs(w.ahead));
    expect(d[0]).toBeLessThanOrEqual(d[1]);
    expect(d[1]).toBeLessThanOrEqual(d[2]);
    for (const w of s.nearest) expect(w.ahead).toBeCloseTo(s.eyeStation - w.station, 9);
  });

  it('reports 10A, 11A and 11F as blank-wall seats, and no other window seat', () => {
    const blank = [];
    for (let r = 1; r <= ROWS; r++) for (const l of ['A', 'F']) if (seat(r, l).blankWall) blank.push(`${r}${l}`);
    expect(blank.sort()).toEqual(['10A', '11A', '11F']);
  });

  it('accepts a seat id and rejects nonsense', () => {
    expect(parseSeat('22F')).toEqual({ row: 22, letter: 'F' });
    expect(parseSeat(' 3a ')).toEqual({ row: 3, letter: 'A' });
    expect(parseSeat('31A')).toBeNull();
    expect(parseSeat('12G')).toBeNull();
    expect(parseSeat(null)).toBeNull();
    expect(seat('9F').id).toBe('9F');
    expect(() => seat('40C')).toThrow();
  });

  it('maps stations to body z with the origin at the main gear (nose gear 4.09 m + wheelbase 15.60 m)', () => {
    expect(bodyZ(4.09 + 15.60)).toBeCloseTo(0, 9);
    expect(bodyZ(0)).toBeCloseTo(-19.69, 9);
    expect(stationOf(bodyZ(12.3))).toBeCloseTo(12.3, 9);
  });

  it('lists all 180 seats, row by row', () => {
    const all = allSeats();
    expect(all).toHaveLength(180);
    expect(all[0].id).toBe('1A');
    expect(all.at(-1).id).toBe('30F');
  });
});

describe('wingPlace()', () => {
  it('says ahead of, over or behind the wing from the eye station against the root chord', () => {
    expect(wingPlace(WING.rootLE - 0.01)).toBe('ahead');
    expect(wingPlace((WING.rootLE + WING.rootTE) / 2)).toBe('over');
    expect(wingPlace(WING.rootTE + 0.01)).toBe('behind');
  });
});

describe('defaultSeat()', () => {
  it('follows the rule: window at least 1.2 m behind the root trailing edge and within 15 cm of the eye, first such row', () => {
    expect(ALIGNED).toBe(0.15);
    expect(BEHIND_TE).toBe(1.2);
    for (const side of ['right', 'left']) {
      const d = defaultSeat(side);
      const w = d.nearest[0];
      expect(w.blank).toBe(false);
      expect(w.station).toBeGreaterThanOrEqual(WING.rootTE + 1.2);
      expect(Math.abs(w.ahead)).toBeLessThanOrEqual(0.15);
      for (let r = 1; r < d.row; r++) {
        const n = seat(r, d.letter).nearest[0];
        expect(!n.blank && n.station >= WING.rootTE + 1.2 && Math.abs(n.ahead) <= 0.15).toBe(false);
      }
    }
  });

  it('comes out as 23F with the traced windows (21F misses by 1 cm: its window is 1.19 m behind the trailing edge)', () => {
    expect(defaultSeat('right').id).toBe('23F');
    expect(defaultSeat('left').id).toBe('23A');
    const w21 = seat(21, 'F').nearest[0];
    expect(Math.abs(w21.ahead)).toBeLessThanOrEqual(0.15);
    expect(w21.station - WING.rootTE).toBeCloseTo(1.19, 2);
  });
});

describe('seatFor()', () => {
  it('finds a seat ahead of, over and behind the wing, each with a window beside the eye', () => {
    const ahead = seatFor('ahead', 'right'), over = seatFor('over', 'right'), behind = seatFor('behind', 'right');
    expect(ahead.eyeStation).toBeLessThan(WING.rootLE);
    expect(over.eyeStation).toBeGreaterThan(WING.rootLE);
    expect(over.eyeStation).toBeLessThan(WING.rootTE);
    expect(behind.id).toBe(defaultSeat('right').id);
    for (const s of [ahead, over, behind]) { expect(s.nearest[0].blank).toBe(false); expect(Math.abs(s.nearest[0].ahead)).toBeLessThanOrEqual(0.15); }
    expect(seatFor('ahead', 'left').letter).toBe('A');
    expect(() => seatFor('under')).toThrow();
  });
});

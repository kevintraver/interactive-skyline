// The cabin layout (plan 03, sections 4.3 and 7.4; F1.5 v0, completed by F3.6). Expected values come from the plan's
// text, not from the code's own arithmetic: 44 windows on the left and 46 on the right, the blanks, the exit stations,
// which rows sit beside the wing's edges, the blank-wall seats, and the default seat.
import { describe, it, expect } from 'vitest';
import { windowStations, seat, parseSeat, defaultSeat, rowFront, seatFor, ROWS, bodyZ, stationOf } from '../../../src/flight/cabin/lopa.js';

const IN = 0.0254;

describe('window stations', () => {
  it('has 44 windows on the left and 46 on the right', () => {
    expect(windowStations('left').filter((w) => !w.blank)).toHaveLength(44);
    expect(windowStations('right').filter((w) => !w.blank)).toHaveLength(46);
  });

  it('starts 5.6 to 6.1 m aft of the nose and ends about 30.5 m', () => {
    for (const side of ['left', 'right']) {
      const real = windowStations(side).filter((w) => !w.blank);
      expect(real[0].station).toBeGreaterThanOrEqual(5.55);
      expect(real[0].station).toBeLessThanOrEqual(6.15);
      expect(Math.abs(real[real.length - 1].station - 30.5)).toBeLessThan(0.2);
    }
  });

  it('has blanks at about 13.6 m on the left and 14.7 m on both sides, and no others', () => {
    const blanks = (side) => windowStations(side).filter((w) => w.blank).map((w) => w.station);
    const left = blanks('left'), right = blanks('right');
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(1);
    expect(Math.abs(left[0] - 13.6)).toBeLessThan(0.1);
    expect(Math.abs(left[1] - 14.7)).toBeLessThan(0.1);
    expect(Math.abs(right[0] - 14.7)).toBeLessThan(0.1);
  });

  it('puts a window in each overwing exit, at 16.70 and 17.67 m', () => {
    for (const side of ['left', 'right']) {
      const st = windowStations(side).filter((w) => !w.blank).map((w) => w.station);
      for (const exit of [16.70, 17.67]) expect(Math.min(...st.map((s) => Math.abs(s - exit)))).toBeLessThan(0.02);
    }
  });

  it('pitches the windows at 20 in or 22 in, except across the pair of exits', () => {
    const st = windowStations('right').map((w) => w.station);
    for (let i = 1; i < st.length; i++) {
      const p = st[i] - st[i - 1];
      const across = st[i - 1] > 16.6 && st[i] < 17.8;
      if (!across) expect(Math.min(Math.abs(p - 20 * IN), Math.abs(p - 22 * IN))).toBeLessThan(1e-6);
    }
  });

  it('is sorted front to back and each entry carries its side', () => {
    const w = windowStations('left');
    for (let i = 1; i < w.length; i++) expect(w[i].station).toBeGreaterThan(w[i - 1].station);
    expect(w.every((x) => x.side === 'left')).toBe(true);
  });
});

describe('rows', () => {
  it('has 30 rows, the first seat front 6.1 m aft of the nose, 31 in apart except 38 in at rows 15 and 16', () => {
    expect(ROWS).toBe(30);
    expect(rowFront(1)).toBeCloseTo(6.1, 6);
    expect(rowFront(2) - rowFront(1)).toBeCloseTo(31 * IN, 6);
    expect(rowFront(15) - rowFront(14)).toBeCloseTo(38 * IN, 6);
    expect(rowFront(16) - rowFront(15)).toBeCloseTo(38 * IN, 6);
    expect(rowFront(17) - rowFront(16)).toBeCloseTo(31 * IN, 6);
  });

  it('puts the wing leading edge beside row 12, the exits ahead of rows 15 and 16, the trailing edge beside row 20', () => {
    // "beside": the row whose seated passenger (halfway from the seat front to the eye, 0.55 m aft) is nearest
    const beside = (station) => { let best = 1; for (let r = 1; r <= ROWS; r++) if (Math.abs(rowFront(r) + 0.275 - station) < Math.abs(rowFront(best) + 0.275 - station)) best = r; return best; };
    expect(beside(15.0)).toBe(12);
    expect(beside(21.4)).toBe(20);
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
    expect(s.eye.y).toBeCloseTo(2.9 + 1.2, 6);
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
    expect(seat('9F').id).toBe('9F');
  });

  it('maps stations to body z with the origin at the main gear (nose gear 4.09 m + wheelbase 15.60 m)', () => {
    expect(bodyZ(4.09 + 15.60)).toBeCloseTo(0, 9);
    expect(bodyZ(0)).toBeCloseTo(-19.69, 9);
    expect(stationOf(bodyZ(12.3))).toBeCloseTo(12.3, 9);
  });
});

describe('defaultSeat()', () => {
  it('comes out as 21F or 22F on the right', () => {
    expect(['21F', '22F']).toContain(defaultSeat('right').id);
  });

  it('obeys the rule: window at least 1.2 m behind the root trailing edge and within 15 cm of the eye, first such row', () => {
    for (const side of ['right', 'left']) {
      const d = defaultSeat(side);
      const w = d.nearest[0];
      expect(w.blank).toBe(false);
      expect(w.station).toBeGreaterThanOrEqual(21.4 + 1.2);
      expect(Math.abs(w.ahead)).toBeLessThanOrEqual(0.15);
      for (let r = 1; r < d.row; r++) {
        const s = seat(r, d.letter), n = s.nearest[0];
        expect(!n.blank && n.station >= 22.6 && Math.abs(n.ahead) <= 0.15).toBe(false);
      }
    }
  });
});

describe('seatFor()', () => {
  it('finds a seat ahead of, over and behind the wing, each with a window beside the eye', () => {
    const ahead = seatFor('ahead', 'right'), over = seatFor('over', 'right'), behind = seatFor('behind', 'right');
    expect(ahead.eyeStation).toBeLessThan(15.0);
    expect(over.eyeStation).toBeGreaterThan(15.0);
    expect(over.eyeStation).toBeLessThan(21.4);
    expect(behind.id).toBe(defaultSeat('right').id);
    for (const s of [ahead, over, behind]) { expect(s.nearest[0].blank).toBe(false); expect(Math.abs(s.nearest[0].ahead)).toBeLessThanOrEqual(0.15); }
    expect(seatFor('ahead', 'left').letter).toBe('A');
  });
});

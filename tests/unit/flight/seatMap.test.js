// The seat map (plan 03, section 4.3; F3.6). The pure model: every seat present and labelled, the windows at their
// stations, the wing to scale, the Strip's side and the default marked, the shortcuts, the words of a seat, and the
// keyboard: every seat is reachable from any other by the arrow keys alone.
import { describe, it, expect } from 'vitest';
import { seatMapModel, describeSeat, nextSeatId, seatMapSvg, SCALE, FROM } from '../../../src/flight/ui/seatMap.js';
import { seat, defaultSeat, seatFor, windowStations, ROWS } from '../../../src/flight/cabin/lopa.js';
import { WING } from '../../../src/flight/aircraft/dimensions.js';

describe('describeSeat()', () => {
  it('names side, wing and where the window is against the shoulder', () => {
    const s = seat('23F');
    expect(describeSeat(s)).toBe(`23F · right · behind the wing · window ${Math.round(s.nearest[0].ahead * 100)} cm ahead of your shoulder`);
    expect(describeSeat(seat('22F'))).toMatch(/^22F · right · behind the wing · window 17 cm behind your shoulder$/);
    expect(describeSeat(seat('16A'))).toMatch(/^16A · left · over the wing · window/);
    expect(describeSeat(seat('5F'))).toMatch(/ahead of the wing/);
  });

  it('says a blank-wall seat has no window, and where the nearest one is', () => {
    expect(describeSeat(seat('11F'))).toMatch(/^11F · right · ahead of the wing · no window: a blank wall, the nearest window \d+ cm (ahead|behind)$/);
  });

  it('names middle and aisle seats, and the Strip side when asked', () => {
    expect(describeSeat(seat('22E'))).toMatch(/middle seat, one seat from the window$/);
    expect(describeSeat(seat('22D'), { stripSide: 'right' })).toMatch(/aisle seat, two seats from the window · the Strip side$/);
    expect(describeSeat(seat('22C'), { stripSide: 'right' })).not.toMatch(/Strip/);
  });
});

describe('seatMapModel()', () => {
  const m = seatMapModel({ stripSide: 'right' });

  it('has all 180 seats, each labelled, with the current one (the default unless given) selected', () => {
    expect(m.seats).toHaveLength(180);
    expect(m.seats.every((s) => s.label.startsWith(s.id))).toBe(true);
    expect(m.seats.filter((s) => s.current).map((s) => s.id)).toEqual([defaultSeat('right').id]);
    expect(seatMapModel({ current: '9F' }).currentId).toBe('9F');
    expect(seatMapModel({ current: 'nonsense' }).currentId).toBe(defaultSeat('right').id);
  });

  it('marks the window seats on the Strip side, the blank-wall seats and the default', () => {
    expect(m.seats.filter((s) => s.window && s.strip).every((s) => s.letter === 'F')).toBe(true);
    expect(m.seats.filter((s) => s.blankWall).map((s) => s.id).sort()).toEqual(['10A', '11A', '11F']);
    expect(m.seats.find((s) => s.isDefault).id).toBe(defaultSeat('right').id);
    const left = seatMapModel({ stripSide: 'left' });
    expect(left.seats.find((s) => s.isDefault).id).toBe(defaultSeat('left').id);
    expect(left.seats.filter((s) => s.window && s.strip).every((s) => s.letter === 'A')).toBe(true);
  });

  it('draws every window and blank at its station, to scale, on its side', () => {
    expect(m.ticks).toHaveLength(windowStations('right').length + windowStations('left').length);
    for (const t of m.ticks) expect(t.x).toBeCloseTo((t.station - FROM) * SCALE, 0);
    expect(m.ticks.filter((t) => t.blank)).toHaveLength(3);
    const right = m.ticks.filter((t) => t.side === 'right'), left = m.ticks.filter((t) => t.side === 'left');
    expect(right.every((t) => t.y < m.height / 2) && left.every((t) => t.y > m.height / 2)).toBe(true);
  });

  it('draws the wing root where spec.py puts it', () => {
    const xs = m.wing.right.split(' ').map((p) => Number(p.split(',')[0]));
    expect(Math.min(...xs)).toBeCloseTo((WING.rootLE - FROM) * SCALE, 0);
    expect(xs).toContainEqual(Math.round((WING.rootTE - FROM) * SCALE * 10) / 10);
  });

  it('offers the three shortcuts on the Strip side', () => {
    expect(m.shortcuts).toEqual({ ahead: seatFor('ahead', 'right').id, over: seatFor('over', 'right').id, behind: seatFor('behind', 'right').id });
    expect(seatMapModel({ stripSide: 'left' }).shortcuts.over).toMatch(/A$/);
  });
});

describe('nextSeatId()', () => {
  it('moves toward the nose and tail, across the cabin, and to the ends, stopping at the edges', () => {
    expect(nextSeatId('22F', 'ArrowLeft')).toBe('21F');
    expect(nextSeatId('22F', 'ArrowRight')).toBe('23F');
    expect(nextSeatId('22F', 'ArrowDown')).toBe('22E');
    expect(nextSeatId('22F', 'ArrowUp')).toBe('22F');
    expect(nextSeatId('1A', 'ArrowLeft')).toBe('1A');
    expect(nextSeatId('12C', 'Home')).toBe('1C');
    expect(nextSeatId('12C', 'End')).toBe('30C');
    expect(nextSeatId('28C', 'PageDown')).toBe('30C');
    expect(nextSeatId('12C', 'Tab')).toBeNull();
  });

  it('reaches every seat from the default by arrow keys alone', () => {
    const start = defaultSeat('right').id, seen = new Set([start]), queue = [start];
    while (queue.length) {
      const id = queue.shift();
      for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
        const n = nextSeatId(id, k);
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    expect(seen.size).toBe(ROWS * 6);
  });
});

describe('seatMapSvg()', () => {
  it('is a grid of rows of cells with one tab stop, each cell labelled', () => {
    const svg = seatMapSvg(seatMapModel({ current: '9F' }));
    expect(svg).toMatch(/role="grid"/);
    expect(svg.match(/role="row"/g)).toHaveLength(30);
    expect(svg.match(/role="gridcell"/g)).toHaveLength(180);
    expect(svg.match(/tabindex="0"/g)).toHaveLength(1);
    expect(svg).toMatch(/data-seat="9F" tabindex="0" aria-selected="true" aria-label="9F · right/);
  });
});

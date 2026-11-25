// The cabin layout (plan 03, sections 4.3 and 7.4; F3.6): seat <-> station <-> eye point <-> windows. Pure, no
// three.js.
//
// A generic single-class cabin, not an airline's: 30 rows of 3 + 3 (A B C, aisle, D E F) at 31 in, 38 in for the two
// rows behind the overwing exits, the first seat front 6.1 m aft of the nose. Windows are an explicit list of
// stations traced from a to-scale seat map ([B6]: 46 on the right, 44 on the left), with blank panels where the
// fuselage has no window (13.58 m on the left, 14.66 m on both sides, just ahead of the wing root). Every number
// comes from models/aircraft/spec.py through dimensions.js.
//
// The view from a seat then follows from where the eye is, with nothing authored per seat.

import { CABIN, WING, WINDOW, FUSELAGE, bodyZ, stationOf } from '../aircraft/dimensions.js';

export { bodyZ, stationOf };
export const ROWS = CABIN.rows;
export const LETTERS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);

// ---------------------------------------------------------------- windows

const freeze = (list) => Object.freeze(list.map((w) => Object.freeze(w)));
const positions = (side, windows, blanks) => freeze([
  ...windows.map((station) => ({ station, blank: false, side })),
  ...blanks.map((station) => ({ station, blank: true, side })),
].sort((a, b) => a.station - b.station));
const STATIONS = {
  right: positions('right', WINDOW.right, WINDOW.blanksRight),
  left: positions('left', WINDOW.left, WINDOW.blanksLeft),
};

/**
 * Window positions on one side, front to back: { station, blank, side }. A blank is a plain panel where the
 * fuselage has no window.
 * @param {'left'|'right'} side
 */
export const windowStations = (side) => STATIONS[side === 'left' ? 'left' : 'right'];

// ---------------------------------------------------------------- seats

const FRONTS = (() => {
  const f = [NaN, CABIN.firstRowFront];
  for (let r = 2; r <= ROWS; r++) f.push(f[r - 1] + (CABIN.exitRows.includes(r) ? CABIN.exitPitch : CABIN.pitch));
  return f;
})();

/** Station of the front of a row's seats. */
export const rowFront = (row) => FRONTS[row];

/** Lateral centre of each seat letter, metres from the centre line (right positive). */
const SEAT_X = (() => {
  const arm = (CABIN.tripleWidth - 3 * CABIN.seatWidth) / 4; // four armrests in a triple
  const outer = CABIN.aisle / 2 + CABIN.tripleWidth; // the triple's outboard edge
  const f = outer - arm - CABIN.seatWidth / 2;
  const e = f - CABIN.seatWidth - arm, d = e - CABIN.seatWidth - arm;
  return { A: -f, B: -e, C: -d, D: d, E: e, F: f };
})();

/** Lateral centre of a seat letter, metres from the centre line, right positive. */
export const seatCentreX = (letter) => SEAT_X[String(letter).toUpperCase()];

/** '22F' -> { row: 22, letter: 'F' }; null if there is no such seat. */
export function parseSeat(id) {
  const m = /^\s*(\d{1,2})\s*([A-Fa-f])\s*$/.exec(String(id ?? ''));
  if (!m) return null;
  const row = Number(m[1]);
  if (row < 1 || row > ROWS) return null;
  return { row, letter: m[2].toUpperCase() };
}

/** Where an eye station is against the wing's root chord: 'ahead', 'over' or 'behind'. */
export function wingPlace(eyeStation) {
  if (eyeStation < WING.rootLE) return 'ahead';
  if (eyeStation <= WING.rootTE) return 'over';
  return 'behind';
}

const cache = new Map();

/**
 * One seat: where its eye is (body axes, metres: x right, y up from the main-gear contact plane, z aft from the main
 * gear), the stations of its own seat back and of the back of the seat ahead, and the three nearest window positions
 * on its side, nearest first. `ahead` is how far a window is ahead of the eye (positive toward the nose). A window
 * seat whose nearest position is a blank panel looks at a wall. Seats are frozen and shared.
 * @param {number|string} row a row number, or a seat id such as '22F' (then `letter` is ignored)
 * @param {string} [letter]
 */
export function seat(row, letter) {
  if (typeof row === 'string') {
    const p = parseSeat(row);
    if (!p) throw new Error(`no seat ${row}`);
    ({ row, letter } = p);
  }
  letter = String(letter).toUpperCase();
  if (!(row >= 1 && row <= ROWS && Number.isInteger(row)) || !(letter in SEAT_X)) throw new Error(`no seat ${row}${letter}`);
  const id = `${row}${letter}`;
  if (cache.has(id)) return cache.get(id);
  const side = 'ABC'.includes(letter) ? 'left' : 'right';
  const front = rowFront(row);
  const eyeStation = front + CABIN.eyeAft;
  const nearest = windowStations(side)
    .map((w) => ({ station: w.station, blank: w.blank, ahead: eyeStation - w.station }))
    .sort((a, b) => Math.abs(a.ahead) - Math.abs(b.ahead))
    .slice(0, 3);
  const isWindow = letter === 'A' || letter === 'F';
  const s = Object.freeze({
    id, row, letter, side, sign: side === 'right' ? 1 : -1,
    window: isWindow,
    /** 0 at the window, 1 middle, 2 aisle. */
    fromWindow: { A: 0, B: 1, C: 2, D: 2, E: 1, F: 0 }[letter],
    front, eyeStation,
    wing: wingPlace(eyeStation),
    // the passenger's own seat back (its cushion face) and the back of the seat ahead (or the bulkhead for row 1)
    backStation: front + CABIN.backFace,
    aheadBackStation: row > 1 ? rowFront(row - 1) + CABIN.backFace + CABIN.backThickness : front - CABIN.bulkheadAhead,
    eye: Object.freeze({ x: SEAT_X[letter], y: FUSELAGE.floorAtWing + CABIN.eyeAboveFloor, z: bodyZ(eyeStation) }),
    nearest: Object.freeze(nearest.map(Object.freeze)),
    blankWall: isWindow && nearest[0].blank,
  });
  cache.set(id, s);
  return s;
}

/** Every seat, row by row, A to F. */
export function allSeats() {
  const out = [];
  for (let r = 1; r <= ROWS; r++) for (const l of LETTERS) out.push(seat(r, l));
  return out;
}

/** Within this distance of the eye a window counts as beside it (plan 4.3). */
export const ALIGNED = 0.15;
/** The default seat's window is at least this far behind the root trailing edge (plan 4.3). */
export const BEHIND_TE = 1.2;

/** A window (not a blank) within 15 cm of the eye. */
export const aligned = (s) => !s.nearest[0].blank && Math.abs(s.nearest[0].ahead) <= ALIGNED;
const windowLetter = (side) => (side === 'left' ? 'A' : 'F');

/**
 * The default seat (plan 4.3): the window seat on `side` of the first row whose window is at least 1.2 m behind the
 * wing's trailing edge at the root and within 15 cm of the eye. The rule, not a row number, is the specification.
 * @param {'left'|'right'} [side]
 */
export function defaultSeat(side = 'right') {
  const letter = windowLetter(side);
  for (let r = 1; r <= ROWS; r++) {
    const s = seat(r, letter);
    if (aligned(s) && s.nearest[0].station >= WING.rootTE + BEHIND_TE) return s;
  }
  throw new Error('no seat meets the default rule');
}

/**
 * The seat-map shortcuts (plan 4.3): 'ahead' of the wing (the last aligned window seat at least 1.5 m ahead of the
 * root leading edge, where the nacelle shows), 'over' it (the aligned window seat nearest the middle of the root
 * chord) and 'behind' it (the default seat).
 * @param {'ahead'|'over'|'behind'} where  @param {'left'|'right'} [side]
 */
export function seatFor(where, side = 'right') {
  if (where === 'behind') return defaultSeat(side);
  const letter = windowLetter(side);
  const all = [];
  for (let r = 1; r <= ROWS; r++) { const s = seat(r, letter); if (aligned(s)) all.push(s); }
  if (where === 'ahead') return all.filter((s) => s.eyeStation <= WING.rootLE - 1.5).at(-1);
  if (where === 'over') {
    const mid = (WING.rootLE + WING.rootTE) / 2;
    return all.reduce((a, b) => (Math.abs(b.eyeStation - mid) < Math.abs(a.eyeStation - mid) ? b : a));
  }
  throw new Error(`seatFor: unknown place ${where}`);
}

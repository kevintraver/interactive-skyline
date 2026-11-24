// The cabin layout (plan 03, sections 4.3 and 7.4): seat <-> station <-> eye point <-> windows. Pure, no three.js.
// v0 for F1.5; F3.6 completes it (the seat map's needs) and F3.1's spec.py supplies the drawn window stations.
//
// A generic single-class cabin, not an airline's: 30 rows of 3 + 3 (A B C, aisle, D E F) at 31 in, 38 in for the two
// rows behind the overwing exits, the first seat front 6.1 m aft of the nose. Windows are an explicit list of
// stations, not a uniform pitch: 20 in over the original fuselage and 22 in through the stretch plugs, with blank
// panels where the air-conditioning risers climb (13.6 m, left) and just ahead of the wing root (14.7 m, both sides).
//
// The view from a seat then follows from where the eye is, with nothing authored per seat.

import { CABIN, WING, FUSELAGE, IN, bodyZ, stationOf } from '../aircraft/dimensions.js';

export { bodyZ, stationOf };
export const ROWS = CABIN.rows;
export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// ---------------------------------------------------------------- windows
//
// The station list is built from runs of equal pitch between published anchors, so that it meets every published
// fact at once: 46 windows on the right and 44 on the left [B6]; the first 5.6 to 6.1 m aft of the nose and the last
// about 30.5 m (plan 7.4); a window in each overwing exit at 16.70 and 17.67 m [B5]; blanks at about 13.6 m (left)
// and 14.7 m (both) [B6], [B7]; pitches of 20 in and 22 in only (plan 7.4). Which runs are 20 in and which 22 in is
// ESTIMATED (about half of the intervals have to be 22 in to reach 30.5 m with 46 windows); F3.1 replaces this with
// the stations read off the drawings, and the tests in tests/unit/flight/lopa.test.js state the facts it must keep.
const P20 = 20 * IN, P22 = 22 * IN;
const EXIT_1 = CABIN.overwingExits[0], EXIT_2 = CABIN.overwingExits[1];
/** Runs going forward from the first exit: [pitch, count]. */
const FORWARD_OF_EXIT = [[P20, 4], [P20, 2], [P22, 8], [P20, 7]];
/** Runs going aft from the second exit. */
const AFT_OF_EXIT = [[P20, 4], [P22, 12], [P20, 8]];
/** The blank panels: four 20 in pitches ahead of the first exit (14.67 m, both sides, just ahead of the wing root) and
 * six (13.65 m, left only, the risers). */
const BLANK_BOTH = EXIT_1 - 4 * P20, BLANK_LEFT = EXIT_1 - 6 * P20;
const near = (a, b) => Math.abs(a - b) < 1e-6;

function buildRight() {
  const fwd = [];
  let s = EXIT_1;
  for (const [p, n] of FORWARD_OF_EXIT) for (let i = 0; i < n; i++) { s -= p; fwd.push(s); }
  const aft = [];
  s = EXIT_2;
  for (const [p, n] of AFT_OF_EXIT) for (let i = 0; i < n; i++) { s += p; aft.push(s); }
  return [...fwd.reverse(), EXIT_1, EXIT_2, ...aft];
}
const RIGHT_POSITIONS = buildRight();
// The left's forward door is 0.27 m further aft than the right's [B1], and its first window one position further aft.
const LEFT_POSITIONS = RIGHT_POSITIONS.slice(1);

const freeze = (list) => Object.freeze(list.map((w) => Object.freeze(w)));
const STATIONS = {
  right: freeze(RIGHT_POSITIONS.map((station) => ({ station, blank: near(station, BLANK_BOTH), side: 'right' }))),
  left: freeze(LEFT_POSITIONS.map((station) => ({ station, blank: near(station, BLANK_BOTH) || near(station, BLANK_LEFT), side: 'left' }))),
};

/**
 * Window positions on one side, front to back: { station, blank, side }. A blank is a plain panel where the
 * fuselage has no window.
 * @param {'left'|'right'} side
 */
export const windowStations = (side) => STATIONS[side === 'left' ? 'left' : 'right'];

// ---------------------------------------------------------------- seats

/** Station of the front of a row's seats. */
export function rowFront(row) {
  let s = CABIN.firstRowFront;
  for (let r = 2; r <= row; r++) s += CABIN.exitRows.includes(r) ? CABIN.exitPitch : CABIN.pitch;
  return s;
}

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

/**
 * One seat: where its eye is (body axes, metres: x right, y up from the ground, z aft from the main gear), the
 * stations of its own seat back and of the back of the seat ahead, and the three nearest window positions on its
 * side, nearest first. `ahead` is how far a window is ahead of the eye
 * (positive toward the nose). A window seat whose nearest position is a blank panel looks at a wall.
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
  if (!(row >= 1 && row <= ROWS) || !(letter in SEAT_X)) throw new Error(`no seat ${row}${letter}`);
  const side = 'ABC'.includes(letter) ? 'left' : 'right';
  const front = rowFront(row);
  const eyeStation = front + CABIN.eyeAft;
  const nearest = windowStations(side)
    .map((w) => ({ station: w.station, blank: w.blank, ahead: eyeStation - w.station }))
    .sort((a, b) => Math.abs(a.ahead) - Math.abs(b.ahead))
    .slice(0, 3);
  const isWindow = letter === 'A' || letter === 'F';
  return {
    id: `${row}${letter}`, row, letter, side, sign: side === 'right' ? 1 : -1,
    window: isWindow, front, eyeStation,
    // the passenger's own seat back (its cushion face) and the back of the seat ahead (or the bulkhead for row 1)
    backStation: front + CABIN.backFace,
    aheadBackStation: row > 1 ? rowFront(row - 1) + CABIN.backFace + CABIN.backThickness : front - CABIN.bulkheadAhead,
    eye: { x: SEAT_X[letter], y: FUSELAGE.floorAtWing + CABIN.eyeAboveFloor, z: bodyZ(eyeStation) },
    nearest,
    blankWall: isWindow && nearest[0].blank,
  };
}

/** Within this distance of the eye a window counts as beside it (plan 4.3). */
export const ALIGNED = 0.15;
/** The default seat's window is at least this far behind the root trailing edge (plan 4.3). */
export const BEHIND_TE = 1.2;

const aligned = (s) => !s.nearest[0].blank && Math.abs(s.nearest[0].ahead) <= ALIGNED;
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

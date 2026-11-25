// The flight's state in the address bar (plan 03, section 4.10):
// ?city=lv&mode=flight&flight=lv-19-dusk&at=1240&seat=22F&yaw=-10&pitch=-8&lens=26
// `at` is seconds from the start of the flight; `frame=0` turns the cabin frame off (the clean view); `t` is plan 01's
// simulation-time parameter and is written only when the flight is retimed (then the departure is t - at). Other
// parameters (city, backend, renderer...) are left alone. Pure: no DOM.

export const FLIGHT_KEYS = ['mode', 'flight', 'at', 'seat', 'yaw', 'pitch', 'lens', 'frame', 't'];
/** Keys of the drive's address that mean nothing while flying (src/drive/url.js), dropped when the flight writes its own. */
const DRIVE_ONLY = ['route', 's', 'view', 'rain'];
/** The orbit's own keys (orbitUrl.js ORBIT_KEYS, listed here so this module stays free of the orbit's): moving from an
 * orbit to a recorded flight, or out of Fly, drops them. */
const ORBIT_ONLY = ['orbit', 'alt', 'r', 'phase', 'c', 'on', 'out', 'ias'];

const num = (v) => {
  if (v == null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const round1 = (v) => String(Math.round(v * 10) / 10);
const params = (base) => new URLSearchParams(base instanceof URLSearchParams ? base.toString() : base || '');

/** An ISO time that names its zone (Z or an offset); a zoneless time would be read in the browser's zone. */
function parseTime(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v.trim())) return undefined;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? ms : undefined;
}
/** Whole seconds in UTC, without ".000". */
const isoTime = (ms) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/**
 * Read the flight state. Missing or malformed values are undefined; `flight` says whether mode=flight. Nothing is
 * clamped here: the head rig and the journey clamp what they are given.
 * @param {URLSearchParams|string} search
 * @returns {{ flight: boolean, id?: string, at?: number, seat?: string, yaw?: number, pitch?: number, lens?: number, frame?: boolean, t?: number }}
 */
export function decodeFlightState(search) {
  const p = params(search);
  const id = p.get('flight');
  const at = num(p.get('at'));
  const seat = p.get('seat');
  const lens = num(p.get('lens'));
  const frame = p.get('frame');
  return {
    flight: p.get('mode') === 'flight',
    id: id && /^[\w-]{1,64}$/.test(id) ? id : undefined,
    at: at != null && at >= 0 ? at : undefined,
    seat: seat && /^\s*\d{1,2}[A-Fa-f]\s*$/.test(seat) ? seat.trim().toUpperCase() : undefined,
    yaw: num(p.get('yaw')),
    pitch: num(p.get('pitch')),
    lens: lens != null && lens > 0 ? lens : undefined,
    frame: frame === '0' ? false : frame === '1' ? true : undefined,
    t: parseTime(p.get('t')),
  };
}

/**
 * The flight state written into a copy of `base`: mode=flight and the flight keys replaced, the drive's own keys
 * dropped, everything else kept. A value that is missing removes its key; frame is written only when off.
 * @param {{ id?: string, at?: number, seat?: string, yaw?: number, pitch?: number, lens?: number, frame?: boolean, t?: number }} s
 * @param {URLSearchParams|string} [base]
 */
export function encodeFlightState(s, base) {
  const p = params(base);
  for (const k of [...FLIGHT_KEYS, ...DRIVE_ONLY, ...ORBIT_ONLY]) p.delete(k);
  p.set('mode', 'flight');
  if (s.id) p.set('flight', s.id);
  if (Number.isFinite(s.at)) p.set('at', round1(Math.max(0, s.at)));
  if (s.seat) p.set('seat', s.seat);
  for (const k of ['yaw', 'pitch', 'lens']) if (Number.isFinite(s[k])) p.set(k, round1(s[k]));
  if (s.frame === false) p.set('frame', '0');
  if (Number.isFinite(s.t)) p.set('t', isoTime(s.t));
  return p;
}

/** A copy of `base` without the flight's keys (the orbit's too); another mode's address is left as it is. */
export function clearFlightState(base) {
  const p = params(base);
  if (p.get('mode') !== 'flight') return p;
  for (const k of [...FLIGHT_KEYS, ...ORBIT_ONLY]) p.delete(k);
  return p;
}

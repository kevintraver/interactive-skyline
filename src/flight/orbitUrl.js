// The orbit's state in the address bar (plan 03, section 4.10), beside the recorded flight's (url.js):
// ?city=lv&mode=flight&orbit=1&alt=12000&r=9&phase=140&seat=22F&t=2026-11-14T01:07:30Z
// alt is feet above sea level, r the radius in km, phase the bearing in degrees from the centre to the aircraft,
// clockwise from north. Optional: c=x,n (the centre in metres east and north of the city origin, when it is not the
// Strip), on=<building id> (the building circled, "Orbit this"; the mode resolves it and falls back to c), out=1 (look
// out of the circle), ias=<kt> (a speed other than the schedule's), and the look (yaw, pitch, lens, frame=0) as url.js
// writes them. t is plan 01's simulation-time parameter. Other parameters are left alone. Pure: no DOM.
//
// A link names the orbit being flown (the one a change is heading for) and where on it the aircraft is; decoded, it
// starts on that circle at that phase (no roll-in), so a link taken on the steady circle reproduces the same moment.

export const ORBIT_KEYS = ['orbit', 'alt', 'r', 'phase', 'c', 'on', 'out', 'ias'];
/** Keys shared with the recorded flight's address (url.js FLIGHT_KEYS) that the orbit also writes. */
const SHARED = ['mode', 'seat', 'yaw', 'pitch', 'lens', 'frame', 't'];
/** Keys that mean nothing in an orbit: the recorded flight's and the drive's. */
const OTHERS = ['flight', 'at', 'route', 's', 'view', 'rain'];

const num = (v) => {
  if (v == null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const positive = (v) => { const n = num(v); return n != null && n > 0 ? n : undefined; };
const round = (v, d) => String(Math.round(v * 10 ** d) / 10 ** d);
const params = (base) => new URLSearchParams(base instanceof URLSearchParams ? base.toString() : base || '');
function parseTime(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v.trim())) return undefined;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? ms : undefined;
}
const isoTime = (ms) => new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/**
 * Read the orbit's state. Missing or malformed values are undefined; nothing is clamped here (orbitParams holds the
 * limits). `orbit` says whether the address is an orbit (mode=flight and orbit=1).
 * @param {URLSearchParams|string} search
 */
export function decodeOrbitState(search) {
  const p = params(search);
  const c = p.get('c');
  const cm = c && /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(c);
  const on = p.get('on');
  const out = p.get('out');
  const seat = p.get('seat');
  const phase = num(p.get('phase'));
  const frame = p.get('frame');
  return {
    orbit: p.get('mode') === 'flight' && p.get('orbit') === '1',
    altFt: positive(p.get('alt')),
    radiusKm: positive(p.get('r')),
    phaseDeg: phase != null ? ((phase % 360) + 360) % 360 : undefined,
    center: cm ? { x: Number(cm[1]), n: Number(cm[3]) } : undefined,
    on: on && /^[\w-]{1,64}$/.test(on) ? on : undefined,
    outward: out === '1' ? true : out === '0' ? false : undefined,
    iasKt: positive(p.get('ias')),
    seat: seat && /^\s*\d{1,2}[A-Fa-f]\s*$/.test(seat) ? seat.trim().toUpperCase() : undefined,
    yaw: num(p.get('yaw')),
    pitch: num(p.get('pitch')),
    lens: positive(p.get('lens')),
    frame: frame === '0' ? false : frame === '1' ? true : undefined,
    t: parseTime(p.get('t')),
  };
}

/**
 * The orbit's state written into a copy of `base`: mode=flight, orbit=1 and the orbit keys replaced, the recorded
 * flight's and the drive's keys dropped, everything else kept. A missing value removes its key.
 * @param {{ altFt?: number, radiusKm?: number, phaseDeg?: number, center?: { x: number, n: number }, on?: string,
 *   outward?: boolean, iasKt?: number, seat?: string, yaw?: number, pitch?: number, lens?: number, frame?: boolean, t?: number }} s
 * @param {URLSearchParams|string} [base]
 */
export function encodeOrbitState(s, base) {
  const p = params(base);
  for (const k of [...ORBIT_KEYS, ...SHARED, ...OTHERS]) p.delete(k);
  p.set('mode', 'flight');
  p.set('orbit', '1');
  if (Number.isFinite(s.altFt)) p.set('alt', String(Math.round(s.altFt)));
  if (Number.isFinite(s.radiusKm)) p.set('r', round(s.radiusKm, 2));
  if (Number.isFinite(s.phaseDeg)) p.set('phase', round(((s.phaseDeg % 360) + 360) % 360, 2));
  if (s.center && Number.isFinite(s.center.x) && Number.isFinite(s.center.n)) p.set('c', `${Math.round(s.center.x)},${Math.round(s.center.n)}`);
  if (s.on) p.set('on', s.on);
  if (s.outward) p.set('out', '1');
  if (Number.isFinite(s.iasKt)) p.set('ias', String(Math.round(s.iasKt)));
  if (s.seat) p.set('seat', s.seat);
  for (const k of ['yaw', 'pitch', 'lens']) if (Number.isFinite(s[k])) p.set(k, round(s[k], 1));
  if (s.frame === false) p.set('frame', '0');
  if (Number.isFinite(s.t)) p.set('t', isoTime(s.t));
  return p;
}

/** A copy of `base` without the orbit's own keys; another mode's address is left as it is. */
export function clearOrbitState(base) {
  const p = params(base);
  if (p.get('mode') !== 'flight') return p;
  for (const k of ORBIT_KEYS) p.delete(k);
  return p;
}

/**
 * What a link should say for an orbit track at time t: the orbit flown (or being changed to) and the bearing from its
 * centre to the aircraft. The centre is written unless it is within a metre of `defaultCenter` (the Strip).
 * @param {{ orbit: object, sample: Function }} track a createOrbitTrack / changeOrbit track
 * @param {number} t seconds on that track
 * @param {{ seat?: string, on?: string, defaultCenter?: { x: number, n: number }, look?: object, simMs?: number }} [o]
 */
export function orbitLinkState(track, t, { seat, on, defaultCenter, look = {}, simMs } = {}) {
  const p = track.orbit;
  const st = track.sample(t);
  const c = p.center;
  const phaseDeg = ((Math.atan2(st.position.x - c.x, -st.position.z - c.n) * 180) / Math.PI + 360) % 360;
  const isDefault = defaultCenter && Math.hypot(c.x - defaultCenter.x, c.n - defaultCenter.n) < 1;
  return {
    altFt: p.altFt, radiusKm: p.radiusKm, phaseDeg,
    center: isDefault ? undefined : { x: c.x, n: c.n }, on,
    outward: p.outward || undefined, iasKt: p.iasKt ?? undefined, seat: seat ?? p.seat ?? undefined,
    ...look, t: simMs,
  };
}

/**
 * The parameters for createOrbitTrack from a decoded link: on its circle at its phase, no roll-in. The centre is the
 * link's, else `center` (the Strip, or the building the mode resolved from `on`).
 * @param {ReturnType<typeof decodeOrbitState>} s  @param {{ center?: { x: number, n: number } }} [o]
 */
export function orbitInput(s, { center } = {}) {
  const out = { rollIn: false };
  if (s.center ?? center) out.center = s.center ?? center;
  for (const k of ['altFt', 'radiusKm', 'phaseDeg', 'seat', 'outward', 'iasKt']) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

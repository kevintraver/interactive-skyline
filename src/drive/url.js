// The drive's state in the address bar (plan 02, section 4.9):
// ?city=lv&mode=drive&route=i15n&s=42150&t=2026-11-14T01:07:30Z&view=cabin&yaw=-12&pitch=2&lens=28
// s is metres along the road the route drives; t is simulation time in UTC. Other parameters
// (city, and anything else) are left alone. rain=light|moderate|heavy (or a rate in mm/h) is the drive's rain shorthand
// (env.js RAIN_PRESETS, into plan 01's weather); absent means clear.

export const DRIVE_KEYS = ['mode', 'route', 's', 't', 'view', 'yaw', 'pitch', 'lens', 'rain'];
/** The rain presets an address may name (env.js RAIN_PRESETS; clear is the absence of the key). */
export const RAIN_NAMES = ['clear', 'light', 'moderate', 'heavy'];
/** The views: the car's cabin (the default) and the clean camera. */
export const VIEW_NAMES = ['cabin', 'clean'];

const num = (v) => {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Seconds precision, and no ".000" when the time is whole. */
function isoTime(ms) {
  const iso = new Date(Math.round(ms / 1000) * 1000).toISOString();
  return iso.replace('.000Z', 'Z');
}

/** Parse an ISO time that names its zone (Z or +hh:mm); a zoneless time would be read as local. */
function parseTime(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v.trim())) return undefined;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

const round1 = (v) => String(Math.round(v * 10) / 10);

/** The rain parameter: a preset name, or a rate in mm/h (0 to 100); anything else is undefined. */
export function decodeRain(v) {
  if (v == null) return undefined;
  const t = String(v).trim().toLowerCase();
  if (RAIN_NAMES.includes(t)) return t;
  const n = num(t);
  return n != null && n >= 0 && n <= 100 ? n : undefined;
}

/** A copy of `base` with the rain parameter set (clear or undefined removes it). */
export function withRain(base, rain) {
  const p = new URLSearchParams(base instanceof URLSearchParams ? base.toString() : base || '');
  const r = decodeRain(rain);
  if (r === undefined || r === 'clear' || r === 0) p.delete('rain'); else p.set('rain', String(r));
  return p;
}

/**
 * Read the drive state. Missing or malformed values are undefined; `drive` says whether
 * mode=drive. Nothing is clamped here: the rig and the journey clamp what they are given.
 * @param {URLSearchParams|string} searchParams
 * @returns {{ drive: boolean, route?: string, s?: number, t?: number, view?: 'cabin'|'clean', yaw?: number, pitch?: number, lens?: number, rain?: string|number }}
 */
export function decodeDriveState(searchParams) {
  const p = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams || '');
  const route = p.get('route');
  const view = p.get('view');
  const s = num(p.get('s'));
  const lens = num(p.get('lens'));
  return {
    drive: p.get('mode') === 'drive',
    route: route && /^[\w.-]{1,64}$/.test(route) ? route : undefined,
    s: s != null && s >= 0 ? s : undefined,
    t: parseTime(p.get('t')),
    view: VIEW_NAMES.includes(view) ? view : undefined,
    yaw: num(p.get('yaw')),
    pitch: num(p.get('pitch')),
    lens: lens != null && lens > 0 ? lens : undefined,
    rain: decodeRain(p.get('rain')),
  };
}

/**
 * Write the drive state into a copy of `base` (other parameters kept, drive keys replaced).
 * Keys whose value is missing are removed, except rain, which is kept from `base` unless the state names it.
 * @param {{ route?: string, s?: number, t?: number, view?: string, yaw?: number, pitch?: number, lens?: number }} state
 * @param {URLSearchParams|string} [base]
 * @returns {URLSearchParams}
 */
export function encodeDriveState(state, base) {
  const baseRain = decodeRain(new URLSearchParams(base instanceof URLSearchParams ? base.toString() : base || '').get('rain'));
  const p = clearDriveState(base);
  const set = (k, v) => { if (v !== undefined) p.set(k, v); };
  p.set('mode', 'drive');
  set('route', state.route || undefined);
  set('s', Number.isFinite(state.s) ? String(Math.round(state.s)) : undefined);
  set('t', Number.isFinite(state.t) ? isoTime(state.t) : undefined);
  set('view', state.view || undefined);
  set('yaw', Number.isFinite(state.yaw) ? round1(state.yaw) : undefined);
  set('pitch', Number.isFinite(state.pitch) ? round1(state.pitch) : undefined);
  set('lens', Number.isFinite(state.lens) ? String(Math.round(state.lens)) : undefined);
  const rain = state.rain !== undefined ? decodeRain(state.rain) : baseRain;
  set('rain', rain === undefined || rain === 'clear' || rain === 0 ? undefined : String(rain));
  return p;
}

/** A copy of `base` without the drive's keys, for leaving Drive. */
export function clearDriveState(base) {
  const p = new URLSearchParams(base instanceof URLSearchParams ? base.toString() : base || '');
  for (const k of DRIVE_KEYS) p.delete(k);
  return p;
}

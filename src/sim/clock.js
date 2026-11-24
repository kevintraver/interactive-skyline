// SimClock: the one time base of the app, UTC epoch milliseconds (plan 01, sections 7.13 and 11.2). Pure: no DOM,
// no three.js. The frame loop calls advance(dtWallMs) at frame step 0; nothing else moves the time except the
// set* calls, goLive and step, so every reader later in a frame sees one consistent value.
import { zonedParts, zonedToUtc } from '../core/time.js';

/** A single frame that moves the clock by more than this is a jump: subsystems recompute instead of integrating. */
export const SEEK_MS = 2000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * @param {{ zone: string, now?: () => number, timeMs?: number }} o
 *   zone: the city's IANA zone (cities.json `tz`); now: the wall clock (injected in tests); timeMs: where to start.
 * @returns {import('../contracts.d.ts').SimClock & { advance(dtWallMs: number): void }}
 */
export function createSimClock({ zone, now = () => Date.now(), timeMs = now() }) {
  // The time is an anchor (whole ms) plus a small offset, so that many small steps add up exactly: at epoch scale
  // one float ulp is 0.24 microseconds, and a thousand 16.666 ms steps would otherwise drift off 16,666.
  let anchor = Math.round(timeMs), offset = timeMs - anchor, rate = 1, playing = false, live = false;
  let t = anchor + offset;
  const listeners = { tick: new Set(), seek: new Set(), rate: new Set(), state: new Set() };
  const emit = (type, dtSimMs = 0) => {
    if (!listeners[type].size) return;
    const e = { clock, simMs: t, dtSimMs };
    for (const fn of [...listeners[type]]) fn(e);
  };
  /** Move to `next`; a jump larger than SEEK_MS (or any explicit set) is a seek. */
  const move = (dt, { tick = false, seek = false } = {}) => {
    offset += dt;
    if (Math.abs(offset) > 1e9) { const whole = Math.trunc(offset); anchor += whole; offset -= whole; }
    t = anchor + offset;
    if (seek || Math.abs(dt) > SEEK_MS) emit('seek', dt);
    if (tick) emit('tick', dt);
  };
  /** Jump to an absolute instant: re-anchor there. */
  const jump = (next, o) => {
    const dt = next - t;
    anchor = Math.round(next);
    offset = next - anchor - dt; // move() adds dt back
    t = anchor + offset;
    move(dt, o);
  };
  const leaveLive = () => {
    if (!live) return false;
    live = false;
    return true;
  };

  const clock = {
    get timeMs() { return t; },
    get rate() { return rate; },
    get playing() { return playing; },
    get live() { return live; },
    get zone() { return zone; },

    /** Frame step 0: advance by one frame of wall time (live: read the wall clock). */
    advance(dtWallMs) {
      if (live) jump(now(), { tick: true });
      else if (playing) move(dtWallMs * rate, { tick: true });
    },
    set(timeMs) {
      const wasLive = leaveLive();
      jump(Number(timeMs), { seek: true });
      if (wasLive) emit('state');
    },
    setLocal(p) { clock.set(zonedToUtc(p, zone)); },
    setTimeOfDay(hour, minute = 0) {
      const { year, month, day } = zonedParts(t, zone);
      clock.setLocal({ year, month, day, hour, minute, second: 0 });
    },
    play() {
      if (playing) return;
      playing = true;
      emit('state');
    },
    pause() {
      if (!playing && !live) return;
      playing = false;
      live = false;
      emit('state');
    },
    setRate(r) {
      r = Number(r);
      const wasLive = r !== 1 && leaveLive();
      if (r !== rate) { rate = r; emit('rate'); }
      if (wasLive) emit('state');
    },
    goLive() {
      live = true;
      playing = true;
      if (rate !== 1) { rate = 1; emit('rate'); }
      jump(now(), { seek: true });
      emit('state');
    },
    local(timeMs = t) { return zonedParts(timeMs, zone); },
    format(timeMs = t, style = 'full') {
      const p = zonedParts(timeMs, zone);
      const h12 = p.hour % 12 || 12, ampm = p.hour < 12 ? 'AM' : 'PM';
      const time = `${h12}:${String(p.minute).padStart(2, '0')} ${ampm}`;
      const date = `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`;
      if (style === 'time') return time;
      if (style === 'date') return `${date} ${p.year}`;
      return `${time} ${p.zoneAbbr} · ${date}`;
    },
    on(type, fn) {
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
    step(dtSimMs) { move(dtSimMs, { tick: true }); },
  };
  return clock;
}

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * The `t` address parameter (section 8.6): an ISO 8601 instant with an offset, a local time without one (read in
 * the city's zone), or `now`. Returns { timeMs }, { live: true } or null.
 */
export function parseTimeParam(value, zone) {
  if (!value) return null;
  if (value === 'now') return { live: true };
  if (ISO_ZONED.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? { timeMs: ms } : null;
  }
  const m = ISO_LOCAL.exec(value);
  if (!m) return null;
  const [, year, month, day, hour, minute, second = '0'] = m.map((x) => x);
  return { timeMs: zonedToUtc({ year: +year, month: +month, day: +day, hour: +hour, minute: +minute, second: +second }, zone) };
}

/** An instant as the `t` parameter: local wall time in the city's zone with its offset, seconds only if not zero. */
export function formatTimeParam(timeMs, zone) {
  const p = zonedParts(timeMs, zone);
  const pad = (n) => String(n).padStart(2, '0');
  const off = Math.abs(p.offsetMin);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}${p.second ? `:${pad(p.second)}` : ''}`
    + `${p.offsetMin < 0 ? '-' : '+'}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}

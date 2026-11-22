// Pure formatting for the drive's controls: distance, speed, durations, the city's local time and the
// playback rate. No DOM, so the unit tests can pin every string the route bar and card show.

export const MPH = 0.44704;
const MILE = 1609.344;
const FOOT = 0.3048;

/** The playback rates the rate control steps through (env.js clamps the clock to the same range). */
export const RATES = [0.25, 0.5, 1, 2, 4, 8, 16];

/**
 * The next rate up (dir 1) or down (dir -1) from `rate`, staying at the ends. A rate between two
 * steps goes to the neighbouring step in that direction.
 */
export function stepRate(rate, dir) {
  if (dir > 0) return RATES.find((r) => r > rate + 1e-9) ?? RATES[RATES.length - 1];
  return [...RATES].reverse().find((r) => r < rate - 1e-9) ?? RATES[0];
}

/** "0.25×", "1×", "16×". */
export const formatRate = (rate) => `${Number(rate.toFixed(2))}×`;

/**
 * A distance in the visitor's units: miles (feet under 1,000 ft) or kilometres (metres
 * under one kilometre). One decimal under 100, none above.
 * @param {number} m metres  @param {'ft'|'m'} units
 */
export function formatDistance(m, units) {
  m = Math.max(0, m);
  if (units === 'm') {
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    const km = m / 1000;
    return `${km < 100 ? km.toFixed(1) : Math.round(km)} km`;
  }
  const mi = m / MILE, ft = m / FOOT;
  if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
  return `${mi < 100 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** Speed in mph (feet) or km/h (metres), whole numbers. */
export function formatSpeed(mps, units) {
  return units === 'm' ? `${Math.round(Math.max(0, mps) * 3.6)} km/h` : `${Math.round(Math.max(0, mps) / MPH)} mph`;
}

/** "38 min", "1 h 05 min". */
export function formatDuration(seconds) {
  const min = Math.round(Math.max(0, seconds) / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

const clockFormats = new Map();
const partFormats = new Map();
const cached = (map, tz, make) => { if (!map.has(tz)) map.set(tz, make()); return map.get(tz); };

/** "6:42 PM" in the city's time zone. */
export function formatClock(ms, tz) {
  return cached(clockFormats, tz, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })).format(ms);
}

/** The local wall clock of an instant: { y, m (1-12), d, minutes since local midnight }. */
export function localParts(ms, tz) {
  const fmt = cached(partFormats, tz, () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }));
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value]));
  return { y: p.year, m: p.month, d: p.day, minutes: (p.hour % 24) * 60 + p.minute + p.second / 60 };
}

/** Minutes the zone is ahead of UTC at an instant (Las Vegas in November: -480). */
function zoneOffset(ms, tz) {
  const p = localParts(ms, tz);
  const wall = Date.UTC(p.y, p.m - 1, p.d) + p.minutes * 60000;
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * The instant on the same local calendar day as `ms` when the wall clock reads `minutes` past
 * midnight. Across a daylight-saving change the offset of the result itself is used.
 */
export function atLocalMinutes(ms, tz, minutes) {
  const { y, m, d } = localParts(ms, tz);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60000;
  let t = wall - zoneOffset(ms, tz) * 60000;
  t = wall - zoneOffset(t, tz) * 60000;
  return t;
}

/** "18:42" for a slider's minutes since midnight, as a 12-hour reading ("6:42 PM"). */
export function formatMinutes(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

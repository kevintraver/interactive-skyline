// Time zones through Intl, so the city's local time is shown whatever the visitor's own zone is. Pure.

const formatters = new Map();
function formatter(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', timeZoneName: 'short',
    }));
  }
  return formatters.get(zone);
}
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall time in `zone` at UTC instant `ms`: {year, month (1-12), day, hour, minute, second, weekday (0 = Sunday),
 * zoneAbbr, offsetMin (local minus UTC)}. */
export function zonedParts(ms, zone) {
  const p = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const parts = { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMin = Math.round((asUtc - (ms - (((ms % 1000) + 1000) % 1000))) / 60000);
  return { ...parts, weekday: WEEKDAYS[p.weekday], zoneAbbr: p.timeZoneName, offsetMin };
}

/** UTC instant of a wall time in `zone`. In a repeated hour (autumn) the earlier instant; in a skipped hour
 * (spring) the instant the same number of minutes after the jump. */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, zone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let ms = wall;
  for (let i = 0; i < 3; i++) ms = wall - zonedParts(ms, zone).offsetMin * 60000;
  const earlier = wall - zonedParts(ms - 3600000, zone).offsetMin * 60000;
  const back = zonedParts(earlier, zone);
  if (Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, back.second) === wall && earlier < ms) return earlier;
  return ms;
}

/** Julian date of a UTC instant. */
export const julianDate = (ms) => ms / 86400000 + 2440587.5;

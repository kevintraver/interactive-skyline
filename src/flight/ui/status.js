// The status chip's words (plan 03, section 4.4): the phase, the time to touchdown, the altitude above sea level and
// the ground speed, in the visitor's units setting (feet go with knots, metres with km/h). Pure: no DOM.

const FT = 0.3048, KT = 1852 / 3600;
const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** Vertical speeds within this (m/s) count as level: an approach holds an altitude to within about 200 ft/min. */
const LEVEL_MS = 1.5;
/** On the ground and slower than this (m/s, about 30 kt) is taxiing. */
const TAXI_MS = 15;

const eventT = (events, id) => events.find((e) => e.id === id)?.t;

/**
 * The phase of flight in plain words.
 * @param {{ t: number, vs: number, gs: number, onGround: boolean }} s
 * @param {{ events: { t: number, id: string }[] }} ctx
 */
export function phaseOf(s, { events = [] } = {}) {
  if (s.onGround) return s.gs > TAXI_MS ? 'Landing roll' : 'Taxiing';
  const threshold = eventT(events, 'threshold');
  if (Number.isFinite(threshold) && s.t >= threshold) return 'Over the runway';
  const final = eventT(events, 'ft1000') ?? eventT(events, 'gear');
  if (Number.isFinite(final) && s.t >= final) return 'Final approach';
  if (s.vs < -LEVEL_MS) return 'Descending';
  if (s.vs > LEVEL_MS) return 'Climbing';
  return 'Level';
}

/** "9 min to landing", "40 s to landing" (both rounded up), "Landed", or '' without a touchdown. */
function toTouchdownText(t, touchdownT) {
  if (!Number.isFinite(touchdownT)) return '';
  const left = touchdownT - t;
  if (left <= 0) return 'Landed';
  return left >= 60 ? `${Math.ceil(left / 60)} min to landing` : `${Math.ceil(left)} s to landing`;
}

/**
 * Everything the chip shows, and the one line it reads as.
 * @param {{ t: number, altMsl: number, gs: number, vs: number, onGround: boolean }} s an AircraftState
 * @param {{ touchdownT: number, events: object[], units: 'ft'|'m' }} ctx
 */
export function flightStatus(s, { touchdownT, events = [], units = 'ft' }) {
  const metric = units === 'm';
  const alt = Math.round((metric ? s.altMsl : s.altMsl / FT) / 10) * 10;
  const gs = Math.max(0, s.gs);
  const speed = metric ? `${group.format(Math.round(gs * 3.6))} km/h` : `${group.format(Math.round(gs / KT))} kt`;
  const out = {
    phase: phaseOf(s, { events }),
    toTouchdown: toTouchdownText(s.t, touchdownT),
    altitude: `${group.format(alt)} ${metric ? 'm' : 'ft'}`,
    speed,
  };
  out.text = [out.phase, out.toTouchdown, out.altitude, out.speed].filter(Boolean).join(' · ');
  return out;
}

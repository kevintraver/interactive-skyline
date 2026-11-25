// Where a flight's playback starts, the condensed pace through the clock's rate, and the ways to play that the picker
// offers (plan 03, sections 4.2 and 4.4). Pure: the journey's own paceRate is the schedule; this decides when to apply
// it and what each way to play costs in wall time.

/** The final approach starts this many seconds before touchdown (about the gear and 1,000 ft on a 3 degree path). */
export const FINAL_LEAD_S = 150;
/** The rate is set again only when it is this far off: setting it every frame would announce a change every frame. */
const RATE_EPS = 0.005;

/**
 * Seconds from the start of the track where playback begins: the `terrain` event (the aircraft enters the terrain
 * that exists today; until phase 6 nothing before it has ground under it), else the start of the track.
 * @param {{ events: { t: number, id: string }[] }} track
 */
export function playStart(track) {
  const e = track.events.find((ev) => ev.id === 'terrain');
  return e && Number.isFinite(e.t) ? e.t : 0;
}

/**
 * The clock rate the condensed pace wants now, or null when nothing should change: the pace is off (the visitor chose
 * a rate), the clock is paused, or the rate is already there.
 * @param {{ pace: boolean, playing: boolean, progressS: number, rate: number }} s
 * @param {{ paceRate(progressS: number): number }} journey
 */
export function paceRateFor({ pace, playing, progressS, rate }, journey) {
  if (!pace || !playing) return null;
  const want = journey.paceRate(progressS);
  return Math.abs(want - rate) > RATE_EPS ? want : null;
}

/**
 * Wall-clock seconds to play the flight from `from` to `to` seconds, at the condensed pace or at rate 1. The pace is
 * summed in quarter seconds, which is within a few milliseconds of the integral.
 */
export function wallSeconds(journey, from, to, pace) {
  const a = Math.max(0, from), b = Math.min(journey.durationS, to);
  if (!(b > a)) return 0;
  if (!pace) return b - a;
  const steps = Math.ceil((b - a) * 4), h = (b - a) / steps;
  let wall = 0;
  for (let k = 0; k < steps; k++) wall += h / journey.paceRate(a + (k + 0.5) * h);
  return wall;
}

/**
 * The ways to play one flight (section 4.2, for a flight that may be as short as its last minutes): the condensed pace
 * from the start of playback, real time from there, and real time from the final approach.
 * @returns {{ key: 'pace'|'real'|'final', label: string, from: number, pace: boolean, wallS: number }[]}
 */
export function playOptions(track, journey) {
  const start = playStart(track);
  const end = journey.durationS;
  const td = Number.isFinite(track.touchdownT) ? track.touchdownT : end;
  const finalFrom = Math.max(start, td - FINAL_LEAD_S);
  return [
    { key: 'pace', label: 'Play', from: start, pace: true, wallS: wallSeconds(journey, start, end, true) },
    { key: 'real', label: 'Real time', from: start, pace: false, wallS: wallSeconds(journey, start, end, false) },
    { key: 'final', label: 'Final', from: finalFrom, pace: false, wallS: wallSeconds(journey, finalFrom, end, false) },
  ];
}

/** "8 min": whole minutes, at least one. */
export const minutesText = (s) => `${Math.max(1, Math.round(s / 60))} min`;

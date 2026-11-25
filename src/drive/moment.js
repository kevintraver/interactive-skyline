// The default moment (plan 02, section 4.6): today in the city's time zone, timed so the car
// reaches the reveal in mid civil twilight, when the sun is 3 degrees below the horizon.

export const REVEAL_SUN_ELEVATION = -3;

/**
 * @param {{ journey: object, env: object, startS?: number, nowMs?: number }} opts
 *   journey from createJourney (its departMs may be anything; only its time-distance shape is used);
 *   env from createEnv (its ephemeris works in the city's time zone); startS is the chosen start
 *   chip's s (default the journey's own startS).
 * @returns {{ departMs: number, startMs: number, revealMs: number }} departMs to give the journey
 *   (simulation time at journey.startS), startMs to seek the clock to, revealMs when the car
 *   reaches the reveal. NaN everywhere if the sun never reaches -3 degrees that day.
 */
export function defaultDeparture({ journey, env, startS, nowMs = Date.now() }) {
  const revealS = journey.reveal?.s ?? journey.s1;
  const revealMs = env.ephemeris.timeOfSunElevation(REVEAL_SUN_ELEVATION, nowMs, true);
  // offsets from the journey's departure are independent of departMs itself
  const offset = (s) => journey.timeAt(s) - journey.departMs;
  const departMs = revealMs - offset(revealS);
  const startMs = departMs + offset(Number.isFinite(startS) ? startS : journey.startS);
  return { departMs, startMs, revealMs };
}

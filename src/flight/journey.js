// A recorded flight as a journey (plan 03, section 5.5): plan 01's Journey, which the timeline binds to the clock so
// that scrubbing the flight moves the sky, plus plan 02's members (length, poseAt, timeAt) so either transport can
// drive it, plus the condensed pace of sections 4.2 and 4.4.
//
// The aircraft is a pure function of progress: progressS = (clock time - start) / 1000, clamped by the timeline, and
// the state is track.sample(progressS). At the end the timeline's atEnd 'hold' leaves the clock running (the sky moves
// on) while progress stays at the end, so the aircraft holds where the recording ends (section 4.4).

/**
 * The condensed pace (section 4.2: "cruise and descent run fast, the last three minutes run in real time"): the clock
 * rate is 1 from `realS` seconds before touchdown to the end, `maxRate` earlier, and eases between the two over `rampS`
 * seconds of flight. maxRate is the transport's fastest rate (section 4.4). A 27-minute flight plays in 7 to 8 minutes,
 * depending on how much of it is rollout (7.3 for the synthetic arrival with its 60 s rollout).
 */
export const PACE = Object.freeze({ maxRate: 8, realS: 180, rampS: 120 });

const smoothstep = (a, b, v) => { const u = Math.min(1, Math.max(0, (v - a) / (b - a))); return u * u * (3 - 2 * u); };

/** The title of section 4.2 from the header: the runway and where the flight came from. No airline or flight number. */
function labelOf(meta) {
  if (meta.label) return meta.label;
  const from = meta.badges?.from;
  return `Runway ${meta.runway ?? '?'}${from ? `, from the ${from}` : ''}`;
}

/**
 * @param {import('./types.d.ts').Track} track
 * @param {(state: import('./types.d.ts').AircraftState, info: { seek: boolean, dtS: number }) => void} apply called by the
 *   timeline with the aircraft at each new progress, and the timeline's seek flag; the state object is reused from call
 *   to call, so copy what you keep
 */
export function flightJourney(track, apply) {
  const meta = track.meta;
  const recordedStartMs = track.recordedStartMs;
  let startMs = recordedStartMs;
  const touchdownT = Number.isFinite(track.touchdownT) ? track.touchdownT : track.durationS;
  const state = track.sample(0);

  const journey = {
    id: meta.id,
    label: labelOf(meta),
    durationS: track.durationS,
    recordedStartMs,
    markers: track.events.map((e) => ({ progressS: e.t, label: e.label, id: e.id })),
    atEnd: 'hold',
    track,
    /** Frame step 10 (plan 01's timeline): the aircraft at this progress. */
    onProgress(progressS, info) { apply(track.sample(progressS, state), info); },
    /** Plan 01's timeline calls this when the departure moves; plan 02's members follow the new start. */
    rebase(ms) { startMs = ms; },
    /** The simulation time (UTC ms) at progress 0: the recorded start until the departure is moved. */
    get startMs() { return startMs; },

    // ---- plan 02's members
    /** Metres along the ground track. */
    length: track.lengthM,
    /** The aircraft at a simulation time (a new state each call). */
    poseAt: (simMs) => track.sample((simMs - startMs) / 1000),
    /** The simulation time at which the aircraft has come s metres along the track. */
    timeAt: (s) => startMs + track.timeAtS(s) * 1000,

    // ---- the condensed pace
    /** The clock rate to use at this progress when the condensed pace is on (touching the rate control turns it off). */
    paceRate(progressS) {
      const toTouchdown = touchdownT - progressS;
      return 1 + (PACE.maxRate - 1) * smoothstep(PACE.realS, PACE.realS + PACE.rampS, toTouchdown);
    },
    /** Wall-clock seconds the whole flight takes at the condensed pace (for the picker's "Play (8 min)"). */
    paceDurationS() {
      // the rate is flat outside the ramp, so only the ramp needs summing (in quarter seconds, to a few milliseconds)
      const rampEnd = touchdownT - PACE.realS, rampStart = rampEnd - PACE.rampS;
      const clip = (a, b) => Math.max(0, Math.min(b, track.durationS) - Math.max(a, 0));
      let wall = clip(-Infinity, rampStart) / PACE.maxRate + clip(rampEnd, Infinity);
      const a = Math.max(0, rampStart), b = Math.min(track.durationS, rampEnd), steps = Math.ceil((b - a) * 4);
      for (let k = 0; k < steps; k++) {
        const h = (b - a) / steps;
        wall += h / journey.paceRate(a + (k + 0.5) * h);
      }
      return wall;
    },
  };
  return journey;
}

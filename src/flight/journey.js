// A recorded flight as a journey (plan 03, section 5.5): plan 01's Journey, which the timeline binds to the clock so
// that scrubbing the flight moves the sky, plus plan 02's members (length, poseAt, timeAt) so either transport can
// drive it, plus the condensed pace of sections 4.2 and 4.4.
//
// The aircraft is a pure function of progress: progressS = (clock time - start) / 1000, clamped by the timeline, and
// the state is track.sample(progressS). At the end the timeline's atEnd 'hold' leaves the clock running (the sky moves
// on) while progress stays at the end, so the aircraft holds where the recording ends (section 4.4).

/**
 * The condensed pace (section 4.2: "cruise and descent run fast, the last three minutes run in real time"): the clock
 * rate is 1 from `realS` seconds before touchdown through the landing roll, `maxRate` earlier, and eases between the
 * two over `rampS` seconds of flight. Once the aircraft is down to taxi speed (the `vacate` event) the rate eases back
 * up to maxRate over the same ramp, so five minutes of taxiing do not run in real time. maxRate is the transport's
 * fastest rate (section 4.4). A baked flight from cruise (33 to 41 minutes) plays in about 8 minutes (F6.5); a track
 * without a vacate event runs in real time to its end (7.3 minutes for the synthetic arrival with its 60 s rollout).
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
 * The journey bar's markers (F2.8): where each of the header's chapters begins, or the events for a header without
 * chapters.
 * @param {{ chapters?: { id: string, label: string, from: number }[], events?: { id: string, label: string, t: number }[] }} meta
 */
export function chapterMarkers(meta) {
  if (Array.isArray(meta.chapters) && meta.chapters.length) return meta.chapters.map((c) => ({ progressS: c.from, label: c.label, id: c.id }));
  return (meta.events || []).map((e) => ({ progressS: e.t, label: e.label, id: e.id }));
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
  const vacateT = track.events.find((e) => e.id === 'vacate')?.t;
  const taxiFrom = Number.isFinite(vacateT) && vacateT > touchdownT ? vacateT : Infinity;
  const state = track.sample(0);

  const journey = {
    id: meta.id,
    label: labelOf(meta),
    durationS: track.durationS,
    recordedStartMs,
    markers: chapterMarkers({ chapters: meta.chapters, events: track.events }),
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
      const before = smoothstep(PACE.realS, PACE.realS + PACE.rampS, toTouchdown);
      const taxi = progressS > taxiFrom ? smoothstep(taxiFrom, taxiFrom + PACE.rampS, progressS) : 0;
      return 1 + (PACE.maxRate - 1) * Math.max(before, taxi);
    },
    /** Wall-clock seconds the whole flight takes at the condensed pace (for the picker's "Play (8 min)"). */
    paceDurationS() {
      // the rate is flat outside the two ramps, so only the ramps need summing (in quarter seconds, to a few ms)
      const rampEnd = touchdownT - PACE.realS, rampStart = rampEnd - PACE.rampS, taxiEnd = taxiFrom + PACE.rampS;
      const clip = (a, b) => Math.max(0, Math.min(b, track.durationS) - Math.max(a, 0));
      let wall = clip(-Infinity, rampStart) / PACE.maxRate + clip(rampEnd, taxiFrom) + clip(taxiEnd, Infinity) / PACE.maxRate;
      for (const [a0, b0] of [[rampStart, rampEnd], [taxiFrom, taxiEnd]]) {
        const a = Math.max(0, a0), b = Math.min(track.durationS, b0);
        if (!(b > a)) continue;
        const steps = Math.ceil((b - a) * 4), h = (b - a) / steps;
        for (let k = 0; k < steps; k++) wall += h / journey.paceRate(a + (k + 0.5) * h);
      }
      return wall;
    },
  };
  return journey;
}

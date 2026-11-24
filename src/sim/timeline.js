// Journeys bound to the clock (plan 01, section 11.3; task T1.8). A journey's progress is a pure function of the
// clock: progressS = clamp((clock.timeMs - startMs) / 1000, 0, durationS). Scrubbing a journey moves the clock
// (so the sky follows), and choosing a departure re-anchors the journey and moves the sky, not the position.
// `coupling: 'frozen-sky'` is the one exception: the clock is held and progress runs on wall time.
// timeline.update() runs at frame step 10, before any mode or environment update.
import { zonedToUtc } from '../core/time.js';

/** @param {{ clock: import('../contracts.d.ts').SimClock }} o @returns {import('../contracts.d.ts').Timeline & { update(f: { dtWallMs: number }): void, demand(): string }} */
export function createTimeline({ clock }) {
  let active = null;
  const listeners = { begin: new Set(), end: new Set() };
  const emit = (type, h) => { for (const fn of [...listeners[type]]) fn(h); };

  // a clock seek since the last frame (any set*, or a frame that jumped): onProgress gets seek: true
  let seeked = false;
  clock.on('seek', () => { seeked = true; });

  const timeline = {
    get active() { return active; },
    begin(j, { startMs, coupling = 'clock' } = {}) {
      if (active) active.end();
      const clamp = (p) => Math.min(Math.max(p, 0), j.durationS);
      let start = startMs ?? j.recordedStartMs ?? clock.timeMs;
      let frozenProgress = 0, last = null, ended = false;
      if (coupling === 'frozen-sky') clock.pause();
      const handle = {
        journey: j, coupling,
        get progressS() { return coupling === 'frozen-sky' ? frozenProgress : clamp((clock.timeMs - start) / 1000); },
        get startMs() { return start; },
        seek(progressS) {
          if (coupling === 'frozen-sky') { frozenProgress = clamp(progressS); seeked = true; return; }
          clock.set(start + clamp(progressS) * 1000);
        },
        setStart(ms) {
          const p = handle.progressS;
          start = ms;
          if (j.rebase) j.rebase(ms);
          clock.set(start + p * 1000); // the sky moves; the position along the path does not
        },
        setTimeOfDay(hour, minute = 0) {
          const { year, month, day } = clock.local();
          const present = zonedToUtc({ year, month, day, hour, minute, second: 0 }, clock.zone);
          handle.setStart(present - handle.progressS * 1000);
        },
        useRecordedStart() { if (j.recordedStartMs !== undefined) handle.setStart(j.recordedStartMs); },
        end() {
          if (ended) return;
          ended = true;
          if (active === handle) active = null;
          emit('end', handle);
        },
        /** Frame step 10. */
        update({ dtWallMs = 0 }) {
          if (coupling === 'frozen-sky') frozenProgress = clamp(frozenProgress + dtWallMs / 1000);
          let p = handle.progressS;
          if (coupling === 'clock' && clock.timeMs - start >= j.durationS * 1000 && clock.playing) {
            const atEnd = j.atEnd || 'pause';
            if (atEnd === 'pause') clock.pause();
            else if (atEnd === 'loop') { clock.set(start); p = 0; }
          }
          const moved = last === null || p !== last || seeked;
          if (moved && j.onProgress) j.onProgress(p, { seek: seeked || last === null, dtS: last === null ? 0 : p - last });
          last = p;
          seeked = false;
        },
      };
      active = handle;
      seeked = true;
      emit('begin', handle);
      return handle;
    },
    on(type, fn) {
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
    /** Frame step 10: the active journey follows the clock. */
    update(f = {}) { if (active) active.update(f); else seeked = false; },
    /** A journey playing asks for every frame (section 5.5). */
    demand() {
      if (!active) return 'idle';
      if (active.coupling === 'frozen-sky') return active.progressS < active.journey.durationS ? 'continuous' : 'idle';
      return clock.playing || clock.live ? 'continuous' : 'idle';
    },
  };
  return timeline;
}

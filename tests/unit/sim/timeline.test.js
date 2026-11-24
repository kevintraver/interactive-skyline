// T1.8: journeys bound to the clock (plan 01, section 11.3).
import { describe, it, expect } from 'vitest';
import { createSimClock } from '../../../src/sim/clock.js';
import { createTimeline } from '../../../src/sim/timeline.js';

const LA = 'America/Los_Angeles';
const T0 = Date.UTC(2026, 6, 14, 3, 0); // 8 pm PDT on 13 July

function make(journey = {}) {
  const clock = createSimClock({ zone: LA, now: () => T0, timeMs: T0 });
  const timeline = createTimeline({ clock });
  const calls = [];
  const j = { id: 'test', label: 'Test', durationS: 120, onProgress: (p, info) => calls.push({ p, ...info }), ...journey };
  /** One rendered frame: the clock (step 0), then the timeline (step 10). */
  const frame = (dtWallMs = 16) => { clock.advance(dtWallMs); timeline.update({ dtWallMs }); };
  return { clock, timeline, j, calls, frame };
}

describe('Timeline', () => {
  it('progress is a pure function of the clock', () => {
    const { clock, timeline, j } = make();
    const h = timeline.begin(j, { startMs: T0 - 30000 });
    expect(h.progressS).toBe(30);
    clock.set(T0 - 60000);
    expect(h.progressS).toBe(0); // before the start: 0
    clock.set(T0 + 10 * 60000);
    expect(h.progressS).toBe(120); // after the end: the duration
    expect(timeline.active).toBe(h);
  });

  it('starts at the clock\'s present by default, or at a recorded start', () => {
    const a = make();
    expect(a.timeline.begin(a.j).startMs).toBe(T0);
    const b = make({ recordedStartMs: T0 - 3600000 });
    expect(b.timeline.begin(b.j).startMs).toBe(T0 - 3600000);
  });

  it('seek moves the clock; onProgress runs at frame step 10 with seek: true after a jump', () => {
    const { clock, timeline, j, calls, frame } = make();
    const h = timeline.begin(j);
    h.seek(45);
    expect(clock.timeMs).toBe(T0 + 45000);
    frame();
    expect(calls.at(-1)).toMatchObject({ p: 45, seek: true });
    clock.play();
    frame(1000);
    expect(calls.at(-1)).toMatchObject({ p: 46, seek: false, dtS: 1 });
    const n = calls.length;
    clock.pause();
    frame(1000);
    expect(calls.length).toBe(n); // the clock did not move: no call
  });

  it('setStart keeps the position on the path and moves the sky', () => {
    const { clock, timeline, j } = make();
    const h = timeline.begin(j);
    h.seek(60);
    let rebased = null;
    j.rebase = (ms) => { rebased = ms; };
    h.setStart(T0 - 5 * 3600000);
    expect(h.progressS).toBe(60);
    expect(h.startMs).toBe(T0 - 5 * 3600000);
    expect(clock.timeMs).toBe(T0 - 5 * 3600000 + 60000);
    expect(rebased).toBe(T0 - 5 * 3600000);
  });

  it('setTimeOfDay: the present moment gets that local time, the position is kept', () => {
    const { clock, timeline, j } = make();
    const h = timeline.begin(j);
    h.seek(30);
    h.setTimeOfDay(6, 15);
    expect(h.progressS).toBe(30);
    expect(clock.local()).toMatchObject({ year: 2026, month: 7, day: 13, hour: 6, minute: 15, second: 0 });
    expect(h.startMs).toBe(clock.timeMs - 30000);
  });

  it('useRecordedStart', () => {
    const { timeline, j } = make({ recordedStartMs: T0 - 86400000 });
    const h = timeline.begin(j, { startMs: T0 });
    h.seek(10);
    h.useRecordedStart();
    expect(h.startMs).toBe(T0 - 86400000);
    expect(h.progressS).toBe(10);
  });

  it('at the end: pause (the default), hold, loop', () => {
    for (const [atEnd, expectPlaying, expectProgress] of [[undefined, false, 120], ['hold', true, 120], ['loop', true, 0]]) {
      const { clock, timeline, j, frame } = make({ atEnd });
      const h = timeline.begin(j);
      h.seek(119);
      clock.play();
      frame(5000);
      expect(clock.playing, String(atEnd)).toBe(expectPlaying);
      expect(h.progressS, String(atEnd)).toBe(expectProgress);
    }
  });

  it('frozen-sky holds the clock; progress advances from wall time', () => {
    const { clock, timeline, j, calls, frame } = make();
    clock.play();
    const h = timeline.begin(j, { coupling: 'frozen-sky' });
    expect(clock.playing).toBe(false);
    frame(1000);
    frame(1000);
    expect(clock.timeMs).toBe(T0);
    expect(h.progressS).toBeCloseTo(2, 6);
    expect(calls.at(-1).p).toBeCloseTo(2, 6);
    h.seek(100);
    expect(clock.timeMs).toBe(T0);
    expect(h.progressS).toBe(100);
  });

  it('one journey at a time; end() and the begin and end events', () => {
    const { timeline, j } = make();
    const seen = [];
    timeline.on('begin', (h) => seen.push(['begin', h.startMs]));
    timeline.on('end', () => seen.push(['end']));
    const a = timeline.begin(j);
    timeline.begin({ ...j, id: 'other' });
    expect(timeline.active).not.toBe(a);
    timeline.active.end();
    expect(timeline.active).toBeNull();
    expect(seen.map((s) => s[0])).toEqual(['begin', 'end', 'begin', 'end']);
  });

  it('asks for every frame while a journey plays', () => {
    const { clock, timeline, j } = make();
    expect(timeline.demand()).toBe('idle');
    timeline.begin(j);
    expect(timeline.demand()).toBe('idle');
    clock.play();
    expect(timeline.demand()).toBe('continuous');
  });
});

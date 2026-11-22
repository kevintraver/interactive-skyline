// T1.1: SimClock, the one time base (plan 01, section 11.2).
import { describe, it, expect } from 'vitest';
import { createSimClock, parseTimeParam } from '../../../src/sim/clock.js';

const LA = 'America/Los_Angeles';
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // 4 am PST

function make(o = {}) {
  let wall = o.wall ?? T0;
  const clock = createSimClock({ zone: LA, now: () => wall, timeMs: T0, ...o });
  const events = [];
  for (const type of ['tick', 'seek', 'rate', 'state']) clock.on(type, (e) => events.push({ type, simMs: e.simMs, dtSimMs: e.dtSimMs }));
  return { clock, events, setWall: (ms) => { wall = ms; } };
}

describe('SimClock', () => {
  it('starts paused at the given instant, in the given zone', () => {
    const { clock } = make();
    expect(clock.timeMs).toBe(T0);
    expect(clock.playing).toBe(false);
    expect(clock.live).toBe(false);
    expect(clock.rate).toBe(1);
    expect(clock.zone).toBe(LA);
  });

  it('runs at its rate while playing and stands still while paused', () => {
    const { clock, events } = make();
    clock.advance(1000);
    expect(clock.timeMs).toBe(T0);
    clock.play();
    clock.advance(1000);
    expect(clock.timeMs).toBe(T0 + 1000);
    clock.setRate(60);
    clock.advance(1000);
    expect(clock.timeMs).toBe(T0 + 61000);
    clock.pause();
    clock.advance(5000);
    expect(clock.timeMs).toBe(T0 + 61000);
    expect(events.filter((e) => e.type === 'tick').length).toBe(2);
    expect(events.some((e) => e.type === 'rate')).toBe(true);
    expect(events.filter((e) => e.type === 'state').length).toBe(2); // play, pause
  });

  it('tick carries the simulated step', () => {
    const { clock, events } = make();
    clock.play();
    clock.setRate(10);
    clock.advance(100);
    const tick = events.find((e) => e.type === 'tick');
    expect(tick).toEqual({ type: 'tick', simMs: T0 + 1000, dtSimMs: 1000 });
  });

  it('seek fires for every set and for a frame that moves more than two simulated seconds', () => {
    const { clock, events } = make();
    clock.set(T0 + 5);
    expect(events.filter((e) => e.type === 'seek').length).toBe(1);
    clock.play();
    clock.setRate(1000);
    clock.advance(2); // 2 s of simulation: not more than two, no seek
    expect(events.filter((e) => e.type === 'seek').length).toBe(1);
    clock.advance(3); // 3 s
    expect(events.filter((e) => e.type === 'seek').length).toBe(2);
    clock.setRate(-1000);
    clock.advance(3); // backwards counts too
    expect(events.filter((e) => e.type === 'seek').length).toBe(3);
  });

  it('runs backwards with a negative rate', () => {
    const { clock } = make();
    clock.play();
    clock.setRate(-3600);
    clock.advance(1000);
    expect(clock.timeMs).toBe(T0 - 3600000);
  });

  it('step advances by an exact amount with no wall clock', () => {
    const { clock, events } = make();
    for (let i = 0; i < 1000; i++) clock.step(16.666);
    expect(clock.timeMs).toBe(T0 + 16666);
    expect(events.filter((e) => e.type === 'tick').length).toBe(1000);
    clock.step(-16666);
    expect(clock.timeMs).toBe(T0);
  });

  it('live follows the wall clock; any set leaves live', () => {
    const { clock, setWall } = make();
    clock.goLive();
    expect(clock.live && clock.playing).toBe(true);
    setWall(T0 + 123456);
    clock.advance(16);
    expect(clock.timeMs).toBe(T0 + 123456);
    clock.set(T0);
    expect(clock.live).toBe(false);
    clock.goLive();
    clock.setRate(60);
    expect(clock.live).toBe(false);
    clock.goLive();
    clock.pause();
    expect(clock.live).toBe(false);
  });

  it('setLocal and local across the spring change (8 March 2026)', () => {
    const { clock } = make();
    clock.setLocal({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 });
    expect(clock.timeMs).toBe(Date.UTC(2026, 2, 8, 9, 30)); // PST, UTC-8
    expect(clock.local().zoneAbbr).toBe('PST');
    // 2:30 does not exist; it rolls forward to 3:30 PDT
    clock.setLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 });
    expect(clock.timeMs).toBe(Date.UTC(2026, 2, 8, 10, 30));
    expect(clock.local()).toMatchObject({ hour: 3, minute: 30, zoneAbbr: 'PDT', offsetMin: -420 });
    clock.setLocal({ year: 2026, month: 3, day: 8, hour: 12, minute: 0 });
    expect(clock.timeMs).toBe(Date.UTC(2026, 2, 8, 19, 0));
  });

  it('setLocal across the autumn change (1 November 2026): the repeated hour resolves to the first', () => {
    const { clock } = make();
    clock.setLocal({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(clock.timeMs).toBe(Date.UTC(2026, 10, 1, 8, 30)); // 1:30 PDT, the first of the two
    expect(clock.local().zoneAbbr).toBe('PDT');
    clock.setLocal({ year: 2026, month: 11, day: 1, hour: 3, minute: 0 });
    expect(clock.timeMs).toBe(Date.UTC(2026, 10, 1, 11, 0));
    expect(clock.local().zoneAbbr).toBe('PST');
  });

  it('setLocal for a 1955 date uses that year\'s rules', () => {
    const { clock } = make();
    // 1955: Los Angeles kept daylight time from 24 April to 25 September
    clock.setLocal({ year: 1955, month: 7, day: 4, hour: 12, minute: 0 });
    expect(clock.timeMs).toBe(Date.UTC(1955, 6, 4, 19, 0));
    expect(clock.local()).toMatchObject({ year: 1955, month: 7, day: 4, hour: 12, offsetMin: -420 });
    clock.setLocal({ year: 1955, month: 1, day: 15, hour: 12, minute: 0 });
    expect(clock.timeMs).toBe(Date.UTC(1955, 0, 15, 20, 0));
  });

  it('setTimeOfDay keeps the local date', () => {
    const { clock } = make();
    clock.set(Date.UTC(2026, 10, 10, 6, 30)); // 9 Nov, 10:30 pm PST
    clock.setTimeOfDay(7, 15);
    expect(clock.local()).toMatchObject({ year: 2026, month: 11, day: 9, hour: 7, minute: 15 });
  });

  it('formats in the city\'s zone, not the visitor\'s', () => {
    const { clock } = make();
    clock.set(Date.UTC(2026, 10, 10, 5, 42)); // 9:42 pm PST on Monday 9 November
    expect(clock.format(undefined, 'time')).toBe('9:42 PM');
    expect(clock.format(undefined, 'date')).toBe('Mon 9 Nov 2026');
    expect(clock.format(undefined, 'full')).toBe('9:42 PM PST · Mon 9 Nov');
    const denver = createSimClock({ zone: 'America/Denver', timeMs: Date.UTC(2026, 10, 10, 5, 42) });
    expect(denver.format(undefined, 'full')).toBe('10:42 PM MST · Mon 9 Nov');
  });

  it('on returns an unsubscribe function', () => {
    const { clock } = make();
    let n = 0;
    const off = clock.on('seek', () => n++);
    clock.set(T0 + 1);
    off();
    clock.set(T0 + 2);
    expect(n).toBe(1);
  });
});

describe('parseTimeParam (?t=)', () => {
  it('reads an ISO instant with an offset', () => {
    expect(parseTimeParam('2025-07-14T19:42-07:00', LA)).toEqual({ timeMs: Date.UTC(2025, 6, 15, 2, 42) });
    expect(parseTimeParam('2025-07-15T02:42:00Z', LA)).toEqual({ timeMs: Date.UTC(2025, 6, 15, 2, 42) });
  });
  it('reads a local time without an offset in the city\'s zone', () => {
    expect(parseTimeParam('2025-07-14T19:42', LA)).toEqual({ timeMs: Date.UTC(2025, 6, 15, 2, 42) });
  });
  it('reads now', () => { expect(parseTimeParam('now', LA)).toEqual({ live: true }); });
  it('rejects anything else', () => {
    expect(parseTimeParam('yesterday', LA)).toBeNull();
    expect(parseTimeParam('', LA)).toBeNull();
    expect(parseTimeParam(null, LA)).toBeNull();
  });
  it('formats an instant back for the address bar, in the city\'s zone with its offset', async () => {
    const { formatTimeParam } = await import('../../../src/sim/clock.js');
    expect(formatTimeParam(Date.UTC(2025, 6, 15, 2, 42), LA)).toBe('2025-07-14T19:42-07:00');
    expect(formatTimeParam(Date.UTC(2026, 0, 1, 7, 5, 30), LA)).toBe('2025-12-31T23:05:30-08:00');
  });
});

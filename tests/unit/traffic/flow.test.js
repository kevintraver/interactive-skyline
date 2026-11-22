// D6.2: hour-of-week indexing in local time (daylight saving, week wrap) and the continuous flow curve.
import { describe, it, expect } from 'vitest';
import { hourOfWeek, tzOffsetMs, createClock, createSegmentFlow, HOUR_MS } from '../../../src/drive/traffic/flow.js';
import { SEASON_OF_MONTH } from '../../../src/drive/traffic/format.js';

const TZ = 'America/Los_Angeles';
const at = (iso) => Date.parse(iso);
/** A table whose value names its own season and hour: 1000 * season + how + 1. */
const NAMED = [0, 1, 2, 3].map((s) => Array.from({ length: 168 }, (_, h) => 1000 * s + h + 1));

describe('hour of week', () => {
  it('reads local time: Monday 00:00 is 0, Sunday 23:00 is 167, and wraps', () => {
    expect(hourOfWeek(at('2025-07-07T07:00:00Z'), TZ)).toBe(0); // Mon 00:00 PDT
    expect(hourOfWeek(at('2025-07-07T06:59:59Z'), TZ)).toBe(167); // Sun 23:59 PDT
    expect(hourOfWeek(at('2025-07-11T22:30:00Z'), TZ)).toBe(4 * 24 + 15); // Fri 15:30 PDT
    expect(hourOfWeek(at('2025-01-06T08:00:00Z'), TZ)).toBe(0); // Mon 00:00 PST
  });
  it('skips local 02:00 when the clocks go forward (9 March 2025)', () => {
    expect(tzOffsetMs(at('2025-03-09T09:30:00Z'), TZ)).toBe(-8 * HOUR_MS);
    expect(hourOfWeek(at('2025-03-09T09:30:00Z'), TZ)).toBe(6 * 24 + 1); // Sun 01:30 PST
    expect(hourOfWeek(at('2025-03-09T10:30:00Z'), TZ)).toBe(6 * 24 + 3); // Sun 03:30 PDT
    expect(tzOffsetMs(at('2025-03-09T10:30:00Z'), TZ)).toBe(-7 * HOUR_MS);
  });
  it('repeats local 01:00 when the clocks go back (2 November 2025)', () => {
    expect(hourOfWeek(at('2025-11-02T08:30:00Z'), TZ)).toBe(6 * 24 + 1); // 01:30 PDT
    expect(hourOfWeek(at('2025-11-02T09:30:00Z'), TZ)).toBe(6 * 24 + 1); // 01:30 PST
    expect(hourOfWeek(at('2025-11-02T10:30:00Z'), TZ)).toBe(6 * 24 + 2);
  });
  it('a clock agrees with hourOfWeek hour by hour across both changes and a year end', () => {
    const clock = createClock(TZ, SEASON_OF_MONTH);
    for (const start of ['2025-03-08T00:00:00Z', '2025-11-01T00:00:00Z', '2025-12-31T00:00:00Z']) {
      const H0 = at(start) / HOUR_MS;
      for (let H = H0; H < H0 + 72; H++) {
        const h = clock.hour(H);
        expect(h.how).toBe(hourOfWeek(H * HOUR_MS + HOUR_MS / 2, TZ));
        const local = new Date(H * HOUR_MS + HOUR_MS / 2 + h.off);
        expect(h.season).toBe(SEASON_OF_MONTH[local.getUTCMonth()]);
      }
    }
  });
});

describe('cumulative count', () => {
  const clock = createClock(TZ, SEASON_OF_MONTH);
  const flow = createSegmentFlow(NAMED, clock, 2025 * 12);
  it('counts whole hours exactly: equal to a brute-force sum across DST, months, seasons and a year end', () => {
    for (const [a, b] of [['2025-02-20T00:00:00Z', '2025-04-10T00:00:00Z'], ['2025-10-25T00:00:00Z', '2026-01-15T00:00:00Z'], ['2024-12-20T00:00:00Z', '2025-01-05T00:00:00Z']]) {
      const Ha = at(a) / HOUR_MS, Hb = at(b) / HOUR_MS;
      let sum = 0;
      for (let H = Ha; H < Hb; H++) sum += flow.q(H);
      expect(flow.countTo(Hb) - flow.countTo(Ha)).toBeCloseTo(sum, 6);
    }
  });
  it('uses the season of the local month and the local hour of week', () => {
    const H = at('2025-07-11T22:00:00Z') / HOUR_MS; // Fri 15:00 PDT, summer
    expect(flow.q(H)).toBe(2000 + 4 * 24 + 15 + 1);
    const W = at('2025-01-01T07:00:00Z') / HOUR_MS; // Tue 23:00 PST, 31 Dec local: winter
    expect(flow.q(W)).toBe(0 + 24 + 23 + 1);
  });
  it('is the same number however far it is from the reference', () => {
    const H = at('2026-08-01T12:00:00Z') / HOUR_MS;
    const a = createSegmentFlow(NAMED, createClock(TZ, SEASON_OF_MONTH), 2025 * 12).countTo(H);
    expect(flow.countTo(H)).toBe(a);
  });
});

describe('continuous flow', () => {
  const clock = createClock(TZ, SEASON_OF_MONTH);
  // a rough table with big jumps and zeros, the worst case for the curve
  const rough = [0, 1, 2, 3].map((s) => Array.from({ length: 168 }, (_, h) => ((h * 7919 + s * 13) % 11 === 0 ? 0 : 200 + ((h * 104729 + s) % 3000))));
  const flow = createSegmentFlow(rough, clock, 2025 * 12);
  const H0 = at('2025-03-07T00:00:00Z') / HOUR_MS; // spans the spring change and a week wrap
  const span = flow.span(H0 - 2, H0 + 80);
  it('has the table mean over every hour (to 0.01%)', () => {
    for (let H = H0; H < H0 + 72; H++) {
      let sum = 0;
      const n = 3600;
      for (let i = 0; i < n; i++) sum += span.flowAt(H * 3600 + (i + 0.5));
      expect(sum / n).toBeCloseTo(flow.q(H), 1);
      // and the cumulative agrees with the integral
      expect(span.countAt((H + 1) * 3600) - span.countAt(H * 3600)).toBeCloseTo(flow.q(H), 6);
    }
  });
  it('has no step at the hour and never goes negative', () => {
    for (let H = H0; H < H0 + 72; H++) {
      const before = span.flowAt(H * 3600 - 1e-6), after = span.flowAt(H * 3600 + 1e-6);
      expect(Math.abs(after - before)).toBeLessThan(0.01);
      for (let i = 0; i <= 60; i++) expect(span.flowAt(H * 3600 + i * 60)).toBeGreaterThanOrEqual(0);
    }
  });
  it('peak() bounds the curve', () => {
    const p = flow.peak();
    for (let H = H0; H < H0 + 72; H++) for (let i = 0; i < 4; i++) expect(span.flowAt(H * 3600 + i * 900)).toBeLessThanOrEqual(p + 1e-9);
  });
});

import { describe, it, expect } from 'vitest';
import {
  RATES, stepRate, formatRate, formatDistance, formatSpeed, formatDuration, formatClock, localParts, atLocalMinutes, formatMinutes,
} from '../../../src/drive/ui/format.js';

const TZ = 'America/Los_Angeles';

describe('rates', () => {
  it('steps through 0.25 to 16 and stops at the ends', () => {
    expect(RATES).toEqual([0.25, 0.5, 1, 2, 4, 8, 16]);
    expect(stepRate(1, 1)).toBe(2);
    expect(stepRate(1, -1)).toBe(0.5);
    expect(stepRate(16, 1)).toBe(16);
    expect(stepRate(0.25, -1)).toBe(0.25);
    expect(stepRate(3, 1)).toBe(4);
    expect(stepRate(3, -1)).toBe(2);
  });
  it('reads as a multiple', () => {
    expect(RATES.map(formatRate)).toEqual(['0.25×', '0.5×', '1×', '2×', '4×', '8×', '16×']);
  });
});

describe('distance and speed in the units setting', () => {
  it('miles with feet', () => {
    expect(formatDistance(68352, 'ft')).toBe('42.5 mi');
    expect(formatDistance(200, 'ft')).toBe('660 ft');
    expect(formatDistance(161, 'ft')).toBe('530 ft');
    expect(formatDistance(400, 'ft')).toBe('0.2 mi');
    expect(formatDistance(0, 'ft')).toBe('0 ft');
    expect(formatDistance(-5, 'ft')).toBe('0 ft');
  });
  it('kilometres with metres', () => {
    expect(formatDistance(68352, 'm')).toBe('68.4 km');
    expect(formatDistance(420, 'm')).toBe('420 m');
    expect(formatDistance(1000, 'm')).toBe('1.0 km');
    expect(formatDistance(150000, 'm')).toBe('150 km');
  });
  it('mph and km/h', () => {
    expect(formatSpeed(70 * 0.44704, 'ft')).toBe('70 mph');
    expect(formatSpeed(70 * 0.44704, 'm')).toBe('113 km/h');
    expect(formatSpeed(0, 'm')).toBe('0 km/h');
  });
  it('durations', () => {
    expect(formatDuration(2250)).toBe('38 min');
    expect(formatDuration(3900)).toBe('1 h 05 min');
  });
});

describe('local time', () => {
  const evening = Date.parse('2026-11-22T01:42:00Z'); // 5:42 PM PST on the 21st

  it('formats the city clock', () => {
    expect(formatClock(evening, TZ)).toBe('5:42 PM');
    expect(localParts(evening, TZ)).toEqual({ y: 2026, m: 11, d: 21, minutes: 17 * 60 + 42 });
  });
  it('moves to a time of day on the same local day', () => {
    expect(new Date(atLocalMinutes(evening, TZ, 12 * 60)).toISOString()).toBe('2026-11-21T20:00:00.000Z');
    expect(new Date(atLocalMinutes(evening, TZ, 3 * 60)).toISOString()).toBe('2026-11-21T11:00:00.000Z');
    expect(new Date(atLocalMinutes(evening, TZ, 1439)).toISOString()).toBe('2026-11-22T07:59:00.000Z');
  });
  it('uses the offset of the result across a daylight-saving change', () => {
    // 8 March 2026: clocks go forward at 2 a.m.; noon that day is PDT (UTC-7), the morning before it PST
    const day = Date.parse('2026-03-08T20:00:00Z');
    expect(new Date(atLocalMinutes(day, TZ, 12 * 60)).toISOString()).toBe('2026-03-08T19:00:00.000Z');
    expect(new Date(atLocalMinutes(day, TZ, 60)).toISOString()).toBe('2026-03-08T09:00:00.000Z');
  });
  it('reads slider minutes as a 12-hour time', () => {
    expect(formatMinutes(0)).toBe('12:00 AM');
    expect(formatMinutes(180)).toBe('3:00 AM');
    expect(formatMinutes(720)).toBe('12:00 PM');
    expect(formatMinutes(1062)).toBe('5:42 PM');
  });
});

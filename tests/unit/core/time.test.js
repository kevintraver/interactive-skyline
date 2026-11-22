import { describe, it, expect } from 'vitest';
import { zonedParts, zonedToUtc, julianDate } from '../../../src/core/time.js';

const LA = 'America/Los_Angeles', DEN = 'America/Denver';

describe('time', () => {
  it('reads wall time and zone in the city, not the visitor', () => {
    const p = zonedParts(Date.UTC(2026, 2, 19, 5, 0, 0), LA);
    expect(p).toMatchObject({ year: 2026, month: 3, day: 18, hour: 22, minute: 0, zoneAbbr: 'PDT', offsetMin: -420, weekday: 3 });
    expect(zonedParts(Date.UTC(2026, 0, 1, 12), DEN)).toMatchObject({ hour: 5, zoneAbbr: 'MST', offsetMin: -420 });
  });
  it('converts wall time to UTC across both 2026 daylight-saving changes', () => {
    expect(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, LA)).toBe(Date.UTC(2026, 2, 8, 9, 30));
    expect(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, LA)).toBe(Date.UTC(2026, 2, 8, 10, 30));
    // 1:30 on 1 November happens twice; the earlier one (PDT) is chosen
    expect(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, LA)).toBe(Date.UTC(2026, 10, 1, 8, 30));
    expect(zonedToUtc({ year: 1955, month: 7, day: 14, hour: 12 }, LA)).toBe(Date.UTC(1955, 6, 14, 19));
  });
  it('round-trips every hour of a year', () => {
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 3600000) {
      expect(zonedToUtc(zonedParts(ms, LA), LA)).toBeLessThanOrEqual(ms);
      const p = zonedParts(zonedToUtc(zonedParts(ms, DEN), DEN), DEN);
      expect(p.hour).toBe(zonedParts(ms, DEN).hour);
    }
  });
  it('gives the Julian date', () => {
    expect(julianDate(Date.UTC(2000, 0, 1, 12))).toBe(2451545);
  });
});

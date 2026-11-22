// The cabin's displays and model choice (plan 02, D4.5, D4.2): the instrument cluster reads the pose's speed in
// the visitor's units within 1 unit and the city's local time; the temperature only when there is one; the route
// display names the next exit; small or slow devices get the low model.
import { describe, it, expect } from 'vitest';
import { instrumentText, screenText } from '../../../src/drive/vehicle/displays.js';
import { chooseCabinModel } from '../../../src/drive/vehicle/cabin.js';

const TZ = 'America/Los_Angeles';
const T = Date.parse('2026-11-22T01:12:00Z'); // 5:12 PM in Las Vegas

describe('instrumentText', () => {
  it('reads the speed in mph or km/h within 1 unit', () => {
    for (const mps of [0, 0.3, 13.4, 26.8224, 29.0576, 31.2928, 33.5]) {
      const ft = instrumentText({ speed: mps, simMs: T, tz: TZ, units: 'ft' });
      const m = instrumentText({ speed: mps, simMs: T, tz: TZ, units: 'm' });
      expect(Math.abs(+ft.speed - mps / 0.44704)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(+m.speed - mps * 3.6)).toBeLessThanOrEqual(0.5);
      expect([ft.unit, m.unit]).toEqual(['mph', 'km/h']);
    }
    expect(instrumentText({ speed: 31.2928, simMs: T, tz: TZ, units: 'ft' }).speed).toBe('70');
    expect(instrumentText({ speed: -3, simMs: T, tz: TZ, units: 'ft' }).speed).toBe('0');
    expect(instrumentText({ speed: NaN, simMs: T, tz: TZ, units: 'm' }).speed).toBe('0');
  });

  it('reads the city\'s local time, and the temperature only when the environment has one', () => {
    const t = instrumentText({ speed: 30, simMs: T, tz: TZ, units: 'ft' });
    expect(t.clock).toBe('5:12 PM');
    expect(t.temp).toBe(null);
    expect(instrumentText({ speed: 30, simMs: T, tz: 'UTC', units: 'ft' }).clock).toBe('1:12 AM');
    expect(instrumentText({ speed: 30, simMs: T, tz: TZ, units: 'ft', tempC: 12.4 }).temp).toBe('54°F');
    expect(instrumentText({ speed: 30, simMs: T, tz: TZ, units: 'm', tempC: 12.4 }).temp).toBe('12°C');
  });
});

describe('screenText', () => {
  const markers = [{ s: 1500, kind: 'exit', ref: '33', label: 'Blue Diamond Road' }, { s: 800, kind: 'place', label: 'Curve' }, { s: 2600, kind: 'exit', ref: '34' }];
  it('names the next exit ahead and how far it is', () => {
    expect(screenText({ s: 1000, s1: 3000, markers, to: 'Las Vegas', units: 'ft' })).toEqual({ title: 'Exit 33 · Blue Diamond Road', dist: '0.3 mi', foot: 'To Las Vegas' });
    expect(screenText({ s: 1600, s1: 3000, markers, units: 'm' })).toEqual({ title: 'Exit 34', dist: '1.0 km', foot: '' });
  });
  it('gives the destination past the last exit, and says when the car has arrived', () => {
    expect(screenText({ s: 2700, s1: 3000, markers, to: 'Las Vegas', units: 'm' })).toEqual({ title: 'Las Vegas', dist: '300 m', foot: '' });
    expect(screenText({ s: 2999, s1: 3000, markers, to: 'Las Vegas', units: 'm' }).dist).toBe('Arrived');
  });
});

describe('chooseCabinModel', () => {
  it('gives small or slow devices the low model', () => {
    expect(chooseCabinModel({ deviceMemory: 8, cores: 10, coarse: false, minScreen: 1080 })).toBe('high');
    expect(chooseCabinModel({})).toBe('high'); // nothing known: a desktop browser that reports nothing
    expect(chooseCabinModel({ software: true, deviceMemory: 8, cores: 16 })).toBe('low');
    expect(chooseCabinModel({ deviceMemory: 4, cores: 8 })).toBe('low');
    expect(chooseCabinModel({ deviceMemory: 8, cores: 4 })).toBe('low');
    expect(chooseCabinModel({ deviceMemory: 8, cores: 8, coarse: true, minScreen: 390 })).toBe('low');
    expect(chooseCabinModel({ deviceMemory: 8, cores: 8, coarse: true, minScreen: 1024 })).toBe('high'); // a tablet
  });
});

// Plan 03, section 4.4: the status chip (time to touchdown, altitude, ground speed, phase) in the visitor's units.
import { describe, it, expect } from 'vitest';
import { flightStatus, phaseOf } from '../../../src/flight/ui/status.js';

const KT = 1852 / 3600, FT = 0.3048;
const events = [
  { t: 417, id: 'gear', label: 'Gear down' },
  { t: 461, id: 'ft1000', label: '1,000 ft' },
  { t: 534.5, id: 'threshold', label: 'Runway 19R threshold' },
  { t: 540, id: 'touchdown', label: 'Touchdown' },
];
const ctx = (units = 'ft') => ({ touchdownT: 540, events, units });
const air = (o) => ({ t: 0, altMsl: 3000, gs: 140, vs: -5, onGround: false, ...o });

describe('phaseOf', () => {
  it('names the phase from the vertical speed in the air, and from the events near the runway', () => {
    expect(phaseOf(air({ vs: -6 }), ctx())).toBe('Descending');
    expect(phaseOf(air({ vs: 0.3 }), ctx())).toBe('Level');
    expect(phaseOf(air({ vs: 4 }), ctx())).toBe('Climbing');
    expect(phaseOf(air({ t: 470, vs: -4 }), ctx())).toBe('Final approach');
    expect(phaseOf(air({ t: 536, vs: -3 }), ctx())).toBe('Over the runway');
    expect(phaseOf(air({ t: 545, gs: 60, onGround: true }), ctx())).toBe('Landing roll');
    expect(phaseOf(air({ t: 590, gs: 9, onGround: true }), ctx())).toBe('Taxiing');
  });

  it('uses the gear event for the final approach when the track has no 1,000 ft event', () => {
    const noFt = { ...ctx(), events: events.filter((e) => e.id !== 'ft1000') };
    expect(phaseOf(air({ t: 420, vs: -4 }), noFt)).toBe('Final approach');
    expect(phaseOf(air({ t: 400, vs: -4 }), noFt)).toBe('Descending');
  });
});

describe('flightStatus', () => {
  it('reads feet and knots, with the time to landing in whole minutes rounded up', () => {
    const s = flightStatus(air({ t: 0, altMsl: 3400 * FT, gs: 180 * KT }), ctx('ft'));
    expect(s.phase).toBe('Descending');
    expect(s.toTouchdown).toBe('9 min to landing');
    expect(s.altitude).toBe('3,400 ft');
    expect(s.speed).toBe('180 kt');
    expect(s.text).toBe('Descending · 9 min to landing · 3,400 ft · 180 kt');
  });

  it('reads metres and km/h in the metric setting', () => {
    const s = flightStatus(air({ t: 100, altMsl: 1043, gs: 92.6 }), ctx('m'));
    expect(s.altitude).toBe('1,040 m');
    expect(s.speed).toBe('333 km/h');
    expect(s.toTouchdown).toBe('8 min to landing');
  });

  it('counts the last minute in seconds, then says landed', () => {
    expect(flightStatus(air({ t: 500.2 }), ctx()).toTouchdown).toBe('40 s to landing');
    expect(flightStatus(air({ t: 540, onGround: true, gs: 70 }), ctx()).toTouchdown).toBe('Landed');
    expect(flightStatus(air({ t: 599, onGround: true, gs: 8 }), ctx()).toTouchdown).toBe('Landed');
  });

  it('rounds altitude to tens and never shows a negative speed', () => {
    expect(flightStatus(air({ altMsl: 2187 * FT }), ctx()).altitude).toBe('2,190 ft');
    expect(flightStatus(air({ gs: -0.01 }), ctx()).speed).toBe('0 kt');
  });

  it('leaves the time out for a track without a touchdown', () => {
    const s = flightStatus(air({}), { touchdownT: Infinity, events: [], units: 'ft' });
    expect(s.toTouchdown).toBe('');
    expect(s.text).toBe('Descending · 9,840 ft · 272 kt');
  });
});

// Plan 03, sections 4.2 and 4.7: what a picker card says, the cards' order, and which flight Fly opens on.
import { describe, it, expect } from 'vitest';
import { titleOf, whenText, badgesOf, sortFlights, defaultFlight } from '../../../src/flight/ui/cards.js';

const f = (id, light, runway = '19R', o = {}) => ({ id, runway, touchdown: '2025-03-16T01:42:17Z', badges: { light, weather: 'clear', from: 'north-east', stripSide: 'right' }, ...o });

describe('a card', () => {
  it('is titled by the runway and where the flight came from, and nothing that names the airline or the aircraft', () => {
    expect(titleOf(f('a', 'dusk'))).toBe('Runway 19R, from the north-east');
    expect(titleOf({ id: 'b', runway: '26L', badges: {} })).toBe('Runway 26L');
    expect(titleOf({ id: 'c', runway: '26L', label: 'Straight in over the lake' })).toBe('Straight in over the lake');
  });

  it('gives the real date and local time of touchdown in the airport\'s zone', () => {
    expect(whenText('2025-03-16T01:42:17Z', 'America/Los_Angeles')).toBe('Sat 15 Mar 2025 · touched down 6:42 pm');
    expect(whenText('2026-02-16T20:30:35Z', 'America/Los_Angeles')).toBe('Mon 16 Feb 2026 · touched down 12:30 pm');
    expect(whenText('not a date', 'UTC')).toBe('');
  });

  it('carries the badges of section 4.2: light, runway, weather, the Strip\'s side', () => {
    expect(badgesOf(f('a', 'dusk'))).toEqual(['DUSK', '19R', 'CLEAR', 'STRIP ON THE RIGHT']);
    expect(badgesOf({ id: 'x', runway: '26L', badges: { light: 'night', stripSide: 'left' } })).toEqual(['NIGHT', '26L', 'STRIP ON THE LEFT']);
  });
});

describe('the order and the default', () => {
  const list = [f('n', 'night'), f('d26', 'day', '26L'), f('k', 'dusk'), f('d19', 'day')];
  it('orders day, dusk, night', () => {
    expect(sortFlights(list).map((x) => x.id)).toEqual(['d19', 'd26', 'k', 'n']);
  });
  it('opens on the dusk arrival on runway 19, else the first day arrival, else the first', () => {
    expect(defaultFlight(list).id).toBe('k');
    expect(defaultFlight(list.filter((x) => x.id !== 'k')).id).toBe('d19');
    expect(defaultFlight([f('n', 'night')]).id).toBe('n');
    expect(defaultFlight([f('k26', 'dusk', '26R'), f('d', 'day')]).id).toBe('d');
  });
});

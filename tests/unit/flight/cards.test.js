// Plan 03, sections 4.2 and 4.7: what a picker card says, the cards' order, and which flight Fly opens on.
import { describe, it, expect } from 'vitest';
import { titleOf, whenText, badgesOf, sortFlights, defaultFlight, stripText, previewUrl } from '../../../src/flight/ui/cards.js';
import { chapterMarkers } from '../../../src/flight/journey.js';

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

  it('says where the Strip is truthfully from stripView, and falls back to stripSide for a value it does not know', () => {
    const v = (stripView, stripSide = 'right') => stripText({ stripView, stripSide });
    expect(v('right')).toBe('Strip on the right');
    expect(v('left', 'left')).toBe('Strip on the left');
    expect(v('passes-right')).toBe('Strip passes on the right');
    expect(v('passes-left', 'left')).toBe('Strip passes on the left');
    expect(v('ahead-right')).toBe('Strip ahead, to the right');
    expect(v('ahead-left', 'left')).toBe('Strip ahead, to the left');
    expect(v('ahead')).toBe('Strip ahead');
    expect(v('none')).toBe('Strip out of sight');
    expect(v(undefined, 'left')).toBe('Strip on the left');
    expect(v('somewhere-new', 'right')).toBe('Strip on the right');
    expect(stripText({})).toBe(null);
    expect(badgesOf(f('a', 'dusk', '19R', { badges: { light: 'dusk', weather: 'clear', stripSide: 'right', stripView: 'passes-right' } }))).toEqual(['DUSK', '19R', 'CLEAR', 'STRIP PASSES ON THE RIGHT']);
  });

  it('looks for its preview picture beside the flight, by convention, whatever the index says', () => {
    expect(previewUrl({ id: 'lv-19-dusk', preview: null }, '/data/lv')).toBe('/data/lv/flights/lv-19-dusk.jpg');
    expect(previewUrl({ id: 'lv-26-day' }, '/data/lv/')).toBe('/data/lv/flights/lv-26-day.jpg');
  });
});

describe('the order and the default', () => {
  // the index lists the default first (selection.json's order: the dusk arrival on runway 19, section 4.7)
  const list = [f('k', 'dusk'), f('n', 'night'), f('d26', 'day', '26L'), f('d19', 'day'), f('n26', 'night', '26L')];
  it('opens on the index\'s first flight', () => {
    expect(defaultFlight(list).id).toBe('k');
    expect(defaultFlight([f('n', 'night'), f('d', 'day')]).id).toBe('n');
    expect(defaultFlight([])).toBeUndefined();
  });
  it('puts the default first, then day, dusk, night, each by runway', () => {
    expect(sortFlights(list).map((x) => x.id)).toEqual(['k', 'd19', 'd26', 'n', 'n26']);
  });
});

describe('journey markers', () => {
  it('come from the header\'s chapters (where each begins), else from its events', () => {
    const chapters = [{ id: 'cruise', label: 'Cruise, 31,000 ft', from: 0, to: 415 }, { id: 'tod', label: 'Top of descent', from: 415, to: 761 }];
    expect(chapterMarkers({ chapters, events: [{ id: 'x', t: 3, label: 'X' }] })).toEqual([
      { progressS: 0, label: 'Cruise, 31,000 ft', id: 'cruise' }, { progressS: 415, label: 'Top of descent', id: 'tod' }]);
    expect(chapterMarkers({ events: [{ id: 'x', t: 3, label: 'X' }] })).toEqual([{ progressS: 3, label: 'X', id: 'x' }]);
  });
});

describe('the Orbit entry beside the flights (4.6, 4.9)', async () => {
  const { chipTitle, ORBIT_ID, orbitPresetText } = await import('../../../src/flight/ui/cards.js');
  it('names the chip "Orbit" while orbiting, the flight while flying one, and asks for a choice otherwise', () => {
    const flights = [f('a', 'dusk')];
    expect(chipTitle(ORBIT_ID, flights)).toBe('Orbit');
    expect(chipTitle('a', flights)).toBe('Runway 19R, from the north-east');
    expect(chipTitle(null, flights)).toBe('Choose a flight');
  });
  it('labels each preset with its height', () => {
    expect(orbitPresetText({ label: 'The valley', altFt: 12000 })).toBe('The valley · 12,000 ft');
  });
});

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { markerLabel, layoutTicks, nextExit, nearestTick, tickAtPixel, aheadText, placeText } from '../../../src/drive/ui/track.js';

const route = JSON.parse(readFileSync(new URL('../../../public/data/lv/routes.json', import.meta.url), 'utf8')).routes[0];

describe('marker labels', () => {
  it('names exits by number and name, and leaves out what is missing', () => {
    expect(markerLabel({ kind: 'exit', ref: '38', label: 'Flamingo Road' })).toBe('Exit 38 · Flamingo Road');
    expect(markerLabel({ kind: 'exit', ref: '', label: 'Harmon Avenue' })).toBe('Harmon Avenue');
    expect(markerLabel({ kind: 'exit', ref: '', label: 'Exit' })).toBe('Exit');
    expect(markerLabel({ kind: 'exit', ref: '7', label: 'Exit' })).toBe('Exit 7');
    expect(markerLabel({ kind: 'place', label: 'Jean' })).toBe('Jean');
  });
});

describe('ticks', () => {
  const toy = {
    s0: 0, s1: 10000,
    reveal: { s: 5000, label: 'The view' },
    markers: [
      { s: 9000, kind: 'exit', ref: '9', label: 'Ninth' },
      { s: 2000, kind: 'exit', ref: '2', label: 'Jean / Goodsprings' },
      { s: 2000, kind: 'place', label: 'Jean' },
      { s: 5000, kind: 'reveal', label: 'First view' },
      { s: 12000, kind: 'exit', ref: 'x', label: 'Off the route' },
    ],
  };
  it('places one tick per exit and place, merging an exit with its place, plus the reveal', () => {
    expect(layoutTicks(toy)).toEqual([
      { s: 2000, at: 0.2, kind: 'place', label: 'Exit 2 · Jean / Goodsprings' },
      { s: 5000, at: 0.5, kind: 'reveal', label: 'The view' },
      { s: 9000, at: 0.9, kind: 'exit', label: 'Exit 9 · Ninth' },
    ]);
  });
  it('adds the reveal when the markers do not list it', () => {
    const t = layoutTicks({ ...toy, markers: [] });
    expect(t).toEqual([{ s: 5000, at: 0.5, kind: 'reveal', label: 'The view' }]);
  });
  it('covers every exit and place on I-15 with one reveal, in order', () => {
    const t = layoutTicks(route);
    expect(t.filter((x) => x.kind === 'reveal')).toHaveLength(1);
    expect(t.map((x) => x.s)).toEqual([...t.map((x) => x.s)].sort((a, b) => a - b));
    const spots = new Set(route.markers.filter((m) => m.kind !== 'reveal').map((m) => m.s));
    expect(t.filter((x) => x.kind !== 'reveal')).toHaveLength(spots.size);
    expect(t.every((x) => x.label && x.at >= 0 && x.at <= 1)).toBe(true);
  });
  it('picks the tick under the pointer, the nearest among bunched ones', () => {
    const t = layoutTicks(route);
    const w = 400; // the city's exits are a few pixels apart at this width
    const flamingo = t.find((x) => x.label.includes('Flamingo'));
    expect(tickAtPixel(t, flamingo.at * w + 0.4, w)).toBe(flamingo);
    expect(tickAtPixel(t, 0.36 * w, w)).toBe(null);
    expect(nearestTick(t, 61200)).toBe(flamingo);
  });
});

describe('the road ahead', () => {
  it('names the next exit and how far', () => {
    expect(nextExit(route.markers, 41000).label).toBe('Sloan');
    expect(nextExit(route.markers, 41047.8).label).toBe('Southern Highlands Parkway / Saint Rose Parkway');
    expect(aheadText({ s: 61000, s1: route.s1, markers: route.markers, to: route.to, units: 'ft' }))
      .toEqual({ arrived: false, text: 'Next: Exit 38 · Flamingo Road', dist: '820 ft' });
  });
  it('names the destination after the last exit, and says when the car has arrived', () => {
    expect(aheadText({ s: 68300, s1: route.s1, markers: route.markers, to: route.to, units: 'm' }))
      .toEqual({ arrived: false, text: 'Next: Spaghetti Bowl', dist: '50 m' });
    expect(aheadText({ s: route.s1, s1: route.s1, markers: route.markers, to: route.to, units: 'm' }))
      .toEqual({ arrived: true, text: 'Arrived at Spaghetti Bowl' });
  });
  it('describes the place for a screen reader', () => {
    const ticks = layoutTicks(route);
    expect(placeText({ s: 41047.8, s0: 0, s1: route.s1, ticks, units: 'm' })).toBe('41.0 of 68.4 km, at Exit 25 · Sloan');
    expect(placeText({ s: 25000, s0: 0, s1: route.s1, ticks, units: 'ft' })).toBe('15.5 of 42.5 mi, 3.3 mi past Exit 12 · Jean / Goodsprings');
    expect(placeText({ s: 100, s0: 0, s1: route.s1, ticks, units: 'ft' })).toBe('330 ft of 42.5 mi, at Exit 1 · Primm');
  });
});

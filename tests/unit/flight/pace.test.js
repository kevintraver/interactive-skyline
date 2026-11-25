// Plan 03, sections 4.2 and 4.4: where playback starts, the condensed pace through the clock's rate, and the ways to
// play a flight that the picker offers.
import { describe, it, expect } from 'vitest';
import { createFrame } from '../../../src/world/frame.js';
import { parseTrack } from '../../../src/flight/track.js';
import { flightJourney, PACE } from '../../../src/flight/journey.js';
import { playStart, paceRateFor, wallSeconds, playOptions, minutesText, FINAL_LEAD_S } from '../../../src/flight/pace.js';
import { syntheticArrival } from '../../helpers/flightTrack.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);
const short = syntheticArrival({ durationS: 600 }); // the fixture: the last ten minutes, no terrain event
const shortTrack = parseTrack(short.header, short.buffer, { frame });
const withTerrain = syntheticArrival({ durationS: 600 });
withTerrain.header.events = [{ t: 95, id: 'terrain', label: 'Over the valley' }, ...withTerrain.header.events];
const terrainTrack = parseTrack(withTerrain.header, withTerrain.buffer, { frame });

describe('playStart', () => {
  it('starts at the terrain event (the aircraft enters the terrain that exists), else at the start of the track', () => {
    expect(playStart(terrainTrack)).toBe(95);
    expect(playStart(shortTrack)).toBe(0);
  });
});

describe('paceRateFor', () => {
  const journey = flightJourney(shortTrack, () => {});
  const td = shortTrack.touchdownT;

  it('asks for the pace rate while the pace is on and the clock plays', () => {
    expect(paceRateFor({ pace: true, playing: true, progressS: 10, rate: 1 }, journey)).toBe(PACE.maxRate);
    expect(paceRateFor({ pace: true, playing: true, progressS: td - 30, rate: 8 }, journey)).toBe(1);
    const mid = td - PACE.realS - PACE.rampS / 2;
    expect(paceRateFor({ pace: true, playing: true, progressS: mid, rate: 1 }, journey)).toBeCloseTo(journey.paceRate(mid), 9);
  });

  it('leaves the rate alone when it is already there, when paused, and when the visitor turned the pace off', () => {
    expect(paceRateFor({ pace: true, playing: true, progressS: 10, rate: PACE.maxRate }, journey)).toBeNull();
    expect(paceRateFor({ pace: true, playing: true, progressS: 10, rate: PACE.maxRate - 0.004 }, journey)).toBeNull();
    expect(paceRateFor({ pace: true, playing: false, progressS: 10, rate: 1 }, journey)).toBeNull();
    expect(paceRateFor({ pace: false, playing: true, progressS: 10, rate: 1 }, journey)).toBeNull();
  });
});

describe('wallSeconds', () => {
  const journey = flightJourney(shortTrack, () => {});
  it('is the flight time at rate 1, and agrees with the journey\'s own sum for the condensed pace', () => {
    expect(wallSeconds(journey, 0, 600, false)).toBe(600);
    expect(wallSeconds(journey, 0, 600, true)).toBeCloseTo(journey.paceDurationS(), 0);
    expect(wallSeconds(journey, 450, 600, true)).toBeCloseTo(150, 0); // the last minutes run in real time
    expect(wallSeconds(journey, 0, 100, true)).toBeCloseTo(100 / PACE.maxRate, 1);
  });
});

describe('playOptions', () => {
  it('offers the condensed pace, real time and the final approach, each with its length', () => {
    const journey = flightJourney(shortTrack, () => {});
    const opts = playOptions(shortTrack, journey);
    expect(opts.map((o) => o.key)).toEqual(['pace', 'real', 'final']);
    const [pace, real, fin] = opts;
    expect(pace).toMatchObject({ from: 0, pace: true, label: 'Play' });
    expect(pace.wallS).toBeCloseTo(journey.paceDurationS(), 0);
    expect(real).toMatchObject({ from: 0, pace: false, label: 'Real time', wallS: 600 });
    expect(fin).toMatchObject({ from: shortTrack.touchdownT - FINAL_LEAD_S, pace: false, label: 'Final' });
    expect(fin.wallS).toBeCloseTo(600 - fin.from, 6);
  });

  it('starts the first two at the terrain event when there is one', () => {
    const opts = playOptions(terrainTrack, flightJourney(terrainTrack, () => {}));
    expect(opts[0].from).toBe(95);
    expect(opts[1]).toMatchObject({ from: 95, wallS: 505 });
  });
});

describe('minutesText', () => {
  it('rounds to whole minutes, never below one', () => {
    expect(minutesText(29)).toBe('1 min');
    expect(minutesText(300)).toBe('5 min');
    expect(minutesText(1650)).toBe('28 min');
  });
});

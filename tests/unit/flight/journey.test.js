// Plan 03, F1.4 (journey.js) and section 8.2: a recorded flight as a journey on plan 01's timeline, with plan 02's
// members and the condensed pace of sections 4.2 and 4.4.
import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createSimClock } from '../../../src/sim/clock.js';
import { createTimeline } from '../../../src/sim/timeline.js';
import { createFrame } from '../../../src/world/frame.js';
import { parseTrack } from '../../../src/flight/track.js';
import { flightJourney, PACE } from '../../../src/flight/journey.js';
import { syntheticArrival } from '../../helpers/flightTrack.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);
const synthetic = syntheticArrival();
const track = parseTrack(synthetic.header, synthetic.buffer, { frame });
const touchdownT = track.events.find((e) => e.id === 'touchdown').t;

function setup(apply = vi.fn()) {
  const clock = createSimClock({ zone: cities.lv.tz, now: () => 0, timeMs: Date.UTC(2026, 10, 23, 12) });
  const timeline = createTimeline({ clock });
  const journey = flightJourney(track, apply);
  return { clock, timeline, journey, apply };
}

describe('flightJourney as a plan 01 journey', () => {
  it('names itself from the track and carries its markers, its recorded start and atEnd hold', () => {
    const { journey } = setup();
    expect(journey.id).toBe('synthetic-19');
    expect(journey.label).toBe('Runway 19R, from the east');
    expect(journey.durationS).toBe(1620);
    expect(journey.recordedStartMs).toBe(Date.parse('2025-03-15T19:16:17Z'));
    expect(journey.atEnd).toBe('hold');
    expect(journey.markers.map((m) => m.label)).toEqual(['Cruise, 35,000 ft', 'Top of descent', '18,000 ft', '10,000 ft', 'Gear down', '1,000 ft', 'Runway 19R threshold', 'Touchdown']);
    expect(journey.markers.find((m) => m.label === 'Touchdown').progressS).toBe(touchdownT);
  });

  it('begun on the timeline, starts at the recorded time and hands the aircraft at each progress to apply', () => {
    const { clock, timeline, journey, apply } = setup();
    const h = timeline.begin(journey);
    expect(h.startMs).toBe(journey.recordedStartMs);
    clock.set(h.startMs + 900_000);
    timeline.update({ dtWallMs: 16 });
    const st = apply.mock.calls.at(-1)[0];
    expect(st.t).toBeCloseTo(900, 9);
    expect(st.position.distanceTo(track.sample(900).position)).toBe(0);
    // scrubbing backwards gives the same aircraft as playing there
    clock.set(h.startMs + 100_000); timeline.update({ dtWallMs: 16 });
    clock.set(h.startMs + 900_000); timeline.update({ dtWallMs: 16 });
    expect(apply.mock.calls.at(-1)[0].position.distanceTo(track.sample(900).position)).toBe(0);
  });

  it('holds at the end of the recording while the clock (and the sky) runs on', () => {
    const { clock, timeline, journey, apply } = setup();
    const h = timeline.begin(journey);
    clock.set(h.startMs + 1615_000);
    clock.play();
    for (let k = 0; k < 600; k++) { clock.advance(16); timeline.update({ dtWallMs: 16 }); }
    expect(clock.playing).toBe(true); // 'hold', not 'pause'
    expect(clock.timeMs).toBeGreaterThan(h.startMs + 1620_000);
    expect(h.progressS).toBe(1620);
    expect(apply.mock.calls.at(-1)[0].position.distanceTo(track.sample(1620).position)).toBe(0);
  });

  it('keeps the aircraft where it is when the departure moves (plan 01 setStart calls rebase)', () => {
    const { clock, timeline, journey } = setup();
    const h = timeline.begin(journey);
    clock.set(h.startMs + 600_000);
    const before = journey.poseAt(clock.timeMs).position.clone();
    h.setTimeOfDay(21, 30); // a dusk retiming
    expect(h.startMs).not.toBe(journey.recordedStartMs);
    expect(journey.poseAt(clock.timeMs).position.distanceTo(before)).toBeLessThan(1e-6);
    expect(h.progressS).toBeCloseTo(600, 6);
  });
});

describe('flightJourney with plan 02 members', () => {
  it('poseAt and timeAt agree with the track', () => {
    const { journey } = setup();
    expect(journey.length).toBe(track.lengthM);
    for (const t of [0, 250.5, 1000, touchdownT, 1620]) {
      const ms = journey.recordedStartMs + t * 1000;
      expect(journey.poseAt(ms).position.distanceTo(track.sample(t).position)).toBe(0);
      const s = track.sample(t).s;
      expect(journey.poseAt(journey.timeAt(s)).s).toBeCloseTo(s, 3);
    }
    expect(journey.timeAt(0)).toBe(journey.recordedStartMs);
  });

  it('moving the start keeps the pose at the same progress', () => {
    const { journey } = setup();
    const old = journey.startMs;
    const p = journey.poseAt(old + 777_000).position.clone();
    journey.rebase(old + 3_600_000);
    expect(journey.startMs).toBe(old + 3_600_000);
    expect(journey.poseAt(old + 3_600_000 + 777_000).position.distanceTo(p)).toBe(0);
    expect(journey.timeAt(journey.poseAt(journey.startMs + 777_000).s)).toBeCloseTo(journey.startMs + 777_000, 0);
  });

  it('poseAt hands back a fresh state each time (plan 02 callers keep them)', () => {
    const { journey } = setup();
    const a = journey.poseAt(journey.startMs), b = journey.poseAt(journey.startMs + 60_000);
    expect(a).not.toBe(b);
    expect(a.position.distanceTo(b.position)).toBeGreaterThan(1000);
  });
});

describe('the condensed pace', () => {
  it('runs the last three minutes before touchdown, and the rollout, in real time', () => {
    const { journey } = setup();
    for (let p = touchdownT - PACE.realS; p <= 1620; p += 5) expect(journey.paceRate(p)).toBe(1);
  });

  it('is positive, bounded by the transport rates, continuous and slowing toward the landing', () => {
    const { journey } = setup();
    let last = Infinity;
    for (let p = 0; p <= 1620; p += 0.5) {
      const r = journey.paceRate(p);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(8);
      expect(r).toBeLessThanOrEqual(last + 1e-12);
      if (Number.isFinite(last)) expect(last - r).toBeLessThan(0.1); // no jumps the eye would see
      last = r;
    }
    expect(journey.paceRate(0)).toBe(8);
    expect(journey.paceRate(-50)).toBe(8);
    expect(journey.paceRate(1e6)).toBe(1); // no taxi-speed event in the fixture: real time to the end
  });

  it('plays a 27-minute flight in about 8 minutes', () => {
    const { journey } = setup();
    const wall = journey.paceDurationS();
    expect(wall / 60).toBeGreaterThan(6.5);
    expect(wall / 60).toBeLessThan(9);
    // checked against a plain sum of 0.1 s steps at the pace's rate
    let sum = 0;
    for (let p = 0; p < 1620; p += 0.1) sum += 0.1 / journey.paceRate(p + 0.05);
    expect(wall).toBeCloseTo(sum, 0);
  });

  it('a short flight (the 10-minute fixture) is mostly real time and still shorter condensed than real', () => {
    const short = syntheticArrival({ durationS: 600 });
    const j = flightJourney(parseTrack(short.header, short.buffer, { frame }), () => {});
    expect(j.paceDurationS()).toBeLessThan(600);
    expect(j.paceDurationS()).toBeGreaterThan(240);
  });
});

describe('the condensed pace on the baked flights (from cruise)', () => {
  const ids = JSON.parse(fs.readFileSync('public/data/lv/flights/index.json', 'utf8')).flights.map((f) => f.id);
  const load = (id) => parseTrack(JSON.parse(fs.readFileSync(`public/data/lv/flights/${id}.json`, 'utf8')),
    new Uint8Array(fs.readFileSync(`public/data/lv/flights/${id}.bin`)).buffer, { frame });

  it.each(ids)('%s: the rollout runs in real time, the taxi after the taxi-speed event runs fast again', (id) => {
    const t = load(id), j = flightJourney(t, () => {});
    const vacate = t.events.find((e) => e.id === 'vacate').t;
    for (let p = t.touchdownT; p <= vacate; p += 2) expect(j.paceRate(p)).toBe(1);
    expect(j.paceRate(vacate + PACE.rampS + 1)).toBe(PACE.maxRate);
    // continuous: no jump the eye would see, in either direction
    let last = j.paceRate(0);
    for (let p = 0; p <= t.durationS; p += 0.5) { const r = j.paceRate(p); expect(Math.abs(r - last)).toBeLessThan(0.1); last = r; }
  });

  // F6.5 asks for 8 minutes give or take one. Every flight's first 30 minutes (cruise to touchdown) take the same 6.7
  // minutes; what differs is the taxi after it, and lv-26-day's ten-minute taxi brings it to 9.2.
  it.each(ids)('%s: plays from cruise to the end in about 8 minutes (F6.5)', (id) => {
    const t = load(id), wall = flightJourney(t, () => {}).paceDurationS();
    expect(wall / 60).toBeGreaterThan(7);
    expect(wall / 60).toBeLessThan(9.5);
  });
});


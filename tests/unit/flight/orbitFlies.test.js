// Plan 03, F7.1: the orbit flies in the app as a recording does. Its track has every member of a parsed real flight
// (lv-19-day) with the same type, and run through flightJourney (and plan 01's timeline) for a full circle it gives
// what the session relies on: time that only goes forward, finite state, unit quaternions, no NaN anywhere.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createFrame } from '../../../src/world/frame.js';
import { parseTrack } from '../../../src/flight/track.js';
import { flightJourney } from '../../../src/flight/journey.js';
import { createOrbitTrack, changeOrbit } from '../../../src/flight/orbit.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createTimeline } from '../../../src/sim/timeline.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const frame = createFrame(cities.lv);
const dir = new URL('../../../public/data/lv/flights/', import.meta.url);
const header = JSON.parse(fs.readFileSync(new URL('lv-19-day.json', dir), 'utf8'));
const real = parseTrack(header, fs.readFileSync(new URL('lv-19-day.bin', dir)), { frame });
const orbit = createOrbitTrack({ center: { x: 316, n: 415 }, altFt: 12000, radiusKm: 9, phaseDeg: 140, seat: '22F' }, { frame });

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : ArrayBuffer.isView(v) ? v.constructor.name : typeof v);

describe('the orbit track has the interface of a parsed flight', () => {
  it('has every member of parseTrack(lv-19-day) with the same type', () => {
    const members = Object.keys(real);
    expect(members.length).toBeGreaterThan(10);
    for (const m of members) {
      expect(orbit, `member ${m}`).toHaveProperty(m);
      expect(typeOf(orbit[m]), `type of ${m}`).toBe(typeOf(real[m]));
    }
  });

  it('samples a state with every field of a recorded state, of the same type', () => {
    const a = real.sample(100), b = orbit.sample(100);
    for (const [k, v] of Object.entries(a)) {
      expect(b, `state.${k}`).toHaveProperty(k);
      expect(typeOf(b[k]), `type of state.${k}`).toBe(typeOf(v));
      if (v?.isVector3 || v?.isQuaternion) expect(b[k].constructor).toBe(v.constructor);
    }
  });

  it('has the meta fields the session, journey and hooks read, and events shaped like a flight\'s', () => {
    for (const k of ['id', 'runway', 'channels', 'badges', 'events', 'atmosphere', 'provenance', 'recordedStart']) {
      expect(typeOf(orbit.meta[k]), `meta.${k}`).toBe(typeOf(header[k]));
    }
    expect(typeOf(orbit.meta.label)).toBe('string'); // optional in a flight's header; journey.js prefers it
    expect(orbit.meta.channels).toContain('lights');
    expect(typeOf(orbit.meta.badges.stripSide)).toBe('string');
    for (const e of orbit.events) expect(Object.keys(e).sort()).toEqual(Object.keys(real.events[0]).sort());
  });

  it('gives channel() as a file stores it: Float32Array of `samples` values, null for an unknown channel', () => {
    const h = orbit.channel('hdg');
    expect(h).toBeInstanceOf(Float32Array);
    expect(h.length).toBe(orbit.samples);
    expect(Math.max(...h)).toBeLessThan(360);
    expect(orbit.channel('nonsense')).toBe(null);
    expect(real.channel('nonsense')).toBe(null);
  });

  it('inverts s and t as a flight does', () => {
    for (const t of [0, 31.5, orbit.joinT + 100, orbit.durationS]) expect(orbit.timeAtS(orbit.sAt(t))).toBeCloseTo(t, 4);
  });
});

/** Every number of a state finite, the quaternion a unit one. */
function expectSane(st) {
  for (const [k, v] of Object.entries(st)) {
    if (typeof v === 'number') expect(Number.isFinite(v), `state.${k} = ${v}`).toBe(true);
    if (v?.isVector3) expect(v.toArray().every(Number.isFinite), `state.${k}`).toBe(true);
  }
  const q = st.quaternion;
  expect([q.x, q.y, q.z, q.w].every(Number.isFinite)).toBe(true);
  expect(Math.abs(q.length() - 1)).toBeLessThan(1e-9);
}

describe('it flies: the orbit through flightJourney for a full circle', () => {
  it('samples through the journey with monotonic time and s, finite state and unit quaternions', () => {
    const journey = flightJourney(orbit, () => {});
    expect(journey.durationS).toBe(orbit.durationS);
    expect(journey.label).toBe(orbit.meta.label);
    let prevT = -1, prevS = -1;
    const end = orbit.joinT + orbit.lapS;
    for (let t = 0; t <= end; t += 0.5) {
      const st = journey.poseAt(journey.startMs + t * 1000);
      expect(st.t).toBeGreaterThan(prevT);
      expect(st.s).toBeGreaterThan(prevS);
      expectSane(st);
      prevT = st.t; prevS = st.s;
    }
    expect(journey.timeAt(journey.length / 2)).toBeGreaterThan(journey.startMs);
  });

  it('runs on plan 01\'s timeline: the clock plays it and onProgress hands sane states to apply', () => {
    const clock = createSimClock({ zone: cities.lv.tz, now: () => 0, timeMs: orbit.recordedStartMs });
    const timeline = createTimeline({ clock });
    const seen = [];
    const journey = flightJourney(orbit, (st) => seen.push({ t: st.t, ok: Number.isFinite(st.quaternion.w) && Number.isFinite(st.position.x) }));
    const h = timeline.begin(journey);
    clock.setRate(8);
    clock.play();
    const steps = Math.ceil(((orbit.joinT + orbit.lapS) / 8) * 1000 / 100);
    for (let k = 0; k < steps; k++) { clock.advance(100); timeline.update({ dtWallMs: 100 }); }
    expect(h.progressS).toBeGreaterThanOrEqual(Math.min(orbit.durationS, orbit.joinT + orbit.lapS) - 1);
    expect(seen.length).toBeGreaterThan(100);
    expect(seen.every((s) => s.ok)).toBe(true);
    for (let i = 1; i < seen.length; i++) expect(seen[i].t).toBeGreaterThanOrEqual(seen[i - 1].t);
  });

  it('flies a changed orbit through the journey the same way', () => {
    const next = changeOrbit(orbit, orbit.joinT + 200, { radiusKm: 15, altFt: 14000 }).track;
    const journey = flightJourney(next, () => {});
    for (let t = 0; t <= next.joinT + next.lapS; t += 2) expectSane(journey.poseAt(journey.startMs + t * 1000));
  });
});

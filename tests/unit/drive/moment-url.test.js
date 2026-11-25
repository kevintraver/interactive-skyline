import { describe, it, expect } from 'vitest';
import { defaultDeparture } from '../../../src/drive/moment.js';
import { createEnv, localDate } from '../../../src/drive/env.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createEphemeris } from '../../../src/sky/ephemeris.js';
import { createJourney } from '../../../src/drive/journey.js';
import { encodeDriveState, decodeDriveState, clearDriveState } from '../../../src/drive/url.js';
import { fixture, LV } from './helpers.js';

describe('defaultDeparture', () => {
  const { route, road, frame } = fixture();
  const clock = createSimClock({ zone: LV.tz, timeMs: Date.parse('2026-11-21T20:00:00Z') });
  const ephemeris = createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: 610 });
  const env = createEnv({ city: LV, app: { clock, env: { state: null, ephemeris, nodes: {} } } });
  const opts = { route: route('test'), road: road('test.main'), frame };

  it.each(['2026-11-21T20:00:00Z', '2026-06-21T18:00:00Z', '2026-03-09T07:30:00Z'])(
    'reaches the reveal with the sun at -3 degrees on the local day of %s', (iso) => {
      const nowMs = Date.parse(iso);
      const first = createJourney({ ...opts, departMs: 0 });
      const { departMs, startMs, revealMs } = defaultDeparture({ journey: first, env, startS: 1700, nowMs });
      const j = createJourney({ ...opts, departMs });
      expect(Math.abs(env.ephemeris.sun(j.timeAt(2000)).elevation + 3)).toBeLessThan(0.2);
      expect(j.timeAt(2000)).toBeCloseTo(revealMs, 0);
      expect(startMs).toBeCloseTo(j.timeAt(1700), 0);
      expect(j.sAt(startMs)).toBeCloseTo(1700, 3);
      expect(localDate(revealMs, LV.tz)).toEqual(localDate(nowMs, LV.tz));
    });

  it('does not depend on the journey it was given', () => {
    const nowMs = Date.parse('2026-11-21T20:00:00Z');
    const a = defaultDeparture({ journey: createJourney({ ...opts, departMs: 0 }), env, nowMs });
    const b = defaultDeparture({ journey: createJourney({ ...opts, departMs: 5e12, startS: 500 }), env, nowMs });
    expect(b.departMs).not.toBe(a.departMs); // departMs is at each journey's own startS ...
    expect(b.revealMs).toBe(a.revealMs); // ... but the reveal falls at the same moment
    expect(createJourney({ ...opts, departMs: a.departMs }).timeAt(2000)).toBeCloseTo(a.revealMs, 0);
    expect(createJourney({ ...opts, departMs: b.departMs, startS: 500 }).timeAt(2000)).toBeCloseTo(b.revealMs, 0);
  });
});

describe('address state', () => {
  const state = { route: 'i15n', s: 42150, t: Date.parse('2026-11-14T01:07:30Z'), yaw: -12, pitch: 2, lens: 28, view: 'clean' };

  it('writes the plan example and keeps other parameters', () => {
    const p = encodeDriveState(state, '?city=lv&debug=1');
    expect(p.toString()).toBe('city=lv&debug=1&mode=drive&route=i15n&s=42150&t=2026-11-14T01%3A07%3A30Z&view=clean&yaw=-12&pitch=2&lens=28');
  });

  it('round trips', () => {
    const back = decodeDriveState(encodeDriveState(state, 'city=lv'));
    expect(back).toEqual({ drive: true, ...state });
    const frac = decodeDriveState(encodeDriveState({ ...state, s: 42150.4, yaw: -12.34, t: state.t + 400 }));
    expect([frac.s, frac.yaw, frac.t]).toEqual([42150, -12.3, state.t]);
  });

  it('reads the plan example, cabin view included', () => {
    const d = decodeDriveState('?city=lv&mode=drive&route=i15n&s=42150&t=2026-11-14T01:07:30Z&view=cabin&yaw=-12&pitch=2&lens=28');
    expect(d).toEqual({ drive: true, route: 'i15n', s: 42150, t: Date.parse('2026-11-14T01:07:30Z'), view: 'cabin', yaw: -12, pitch: 2, lens: 28 });
    expect(encodeDriveState(d).get('view')).toBe('cabin');
  });

  it('tolerates missing and malformed values', () => {
    expect(decodeDriveState('')).toEqual({ drive: false, route: undefined, s: undefined, t: undefined, view: undefined, yaw: undefined, pitch: undefined, lens: undefined });
    const d = decodeDriveState('mode=drive&route=<x>&s=-5&t=2026-11-14T01:07:30&yaw=abc&pitch=&lens=0&view=DROP%20TABLE');
    expect(d).toEqual({ drive: true, route: undefined, s: undefined, t: undefined, view: undefined, yaw: undefined, pitch: undefined, lens: undefined });
    expect(decodeDriveState('mode=map&t=2026-11-14T01:07:30%2B00:00').t).toBe(Date.parse('2026-11-14T01:07:30Z'));
    expect(decodeDriveState(new URLSearchParams('mode=drive&s=12.5')).s).toBe(12.5);
  });

  it('drops keys it is not given and clears on leaving', () => {
    const p = encodeDriveState({ route: 'i15n' }, 'city=lv&s=5&yaw=3');
    expect(p.toString()).toBe('city=lv&mode=drive&route=i15n');
    expect(clearDriveState(p).toString()).toBe('city=lv');
  });
});

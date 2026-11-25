// Plan 03, F1.4: entering Fly takes the app's one clock into the clock state; leaving gives the map back its time
// exactly as it was (pinned or the clock state, the instant, the rate, playing or paused, live), through the adapter.
import { describe, it, expect, vi } from 'vitest';
import { createSimClock } from '../../../src/sim/clock.js';
import { createTimeline } from '../../../src/sim/timeline.js';
import { createFlightEnv } from '../../../src/flight/env.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const city = cities.lv;
const T0 = Date.UTC(2026, 10, 24, 18);

function fakeApp({ mode = 'pinned', night = false } = {}) {
  const clock = createSimClock({ zone: city.tz, now: () => T0 + 5000, timeMs: T0 });
  const settings = { night };
  const env = {
    mode, state: null, nodes: {}, lights: {},
    enterClock: vi.fn(() => { env.mode = 'clock'; }),
    pin: vi.fn((n) => { env.mode = 'pinned'; settings.night = !!n; clock.pause(); }),
  };
  const loop = { add: () => () => {}, invalidate: () => {} };
  return { city, cityId: 'lv', clock, timeline: createTimeline({ clock }), env, settings, loop, invalidate: loop.invalidate };
}

describe('the map\'s time, saved and given back', () => {
  it('a pinned night map comes back pinned at night, at its instant, paused', () => {
    const app = fakeApp({ night: true });
    const fe = createFlightEnv(app);
    const saved = fe.saveMapTime();
    fe.enterClock();
    expect(app.env.mode).toBe('clock');
    app.clock.set(T0 + 3_600_000);
    app.clock.setRate(6.5);
    app.clock.play();
    fe.restoreMapTime(saved);
    expect(app.env.pin).toHaveBeenCalledWith(true);
    expect(app.env.mode).toBe('pinned');
    expect(app.clock.timeMs).toBe(T0);
    expect(app.clock.rate).toBe(1);
    expect(app.clock.playing).toBe(false);
  });

  it('a map in the clock state, playing at 60x, comes back playing at 60x at its instant', () => {
    const app = fakeApp({ mode: 'clock' });
    app.clock.setRate(60);
    app.clock.play();
    const fe = createFlightEnv(app);
    const saved = fe.saveMapTime();
    app.clock.set(T0 - 10_000);
    app.clock.setRate(2);
    fe.restoreMapTime(saved);
    expect(app.env.pin).not.toHaveBeenCalled();
    expect(app.clock.timeMs).toBe(T0);
    expect(app.clock.rate).toBe(60);
    expect(app.clock.playing).toBe(true);
  });

  it('a live map goes live again', () => {
    const app = fakeApp({ mode: 'clock' });
    app.clock.goLive();
    const fe = createFlightEnv(app);
    const saved = fe.saveMapTime();
    app.clock.set(T0 - 99_000);
    fe.restoreMapTime(saved);
    expect(app.clock.live).toBe(true);
    expect(app.clock.timeMs).toBe(T0 + 5000);
  });
});

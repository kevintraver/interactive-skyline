// T5.3 and T5.4: the weather reaches env.state (plan 01, section 11.4) in the clock state only; the pinned looks stay
// exactly what they were. state.medium is the atmosphere's medium of the state's weather (section 7.5).
import { describe, it, expect } from 'vitest';
import { createEnvironment, clearWeather } from '../../../src/env/environment.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createEphemeris } from '../../../src/sky/ephemeris.js';
import { presetSample } from '../../../src/weather/presets.js';
import { atmosphereMedium } from '../../../src/weather/derive.js';

const medium = (s) => atmosphereMedium(s, { elevationM: 620 });

const LV = { origin: { lat: 36.1147, lon: -115.1728 }, base: 620, tz: 'America/Los_Angeles' };
const T = Date.UTC(2026, 5, 21, 19);

function make() {
  const clock = createSimClock({ zone: LV.tz, now: () => T, timeMs: T });
  const ephemeris = createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: LV.base });
  const env = createEnvironment({ city: LV, clock, ephemeris, settings: { night: false } });
  const asked = { request: 0, sample: [], preset: [] };
  env.setWeatherRequest(() => { asked.request++; });
  env.update();
  const provider = {
    sample: (t) => { asked.sample.push(t); const s = presetSample('dusty', t, 620); s.wind = { dirDeg: 90, speedMs: 10, gustMs: 14 }; return s; },
    preset: (id, t) => { asked.preset.push(id); return presetSample(id, t, 620); },
    medium,
  };
  return { clock, env, asked, provider };
}

describe('env and the weather', () => {
  it('pinned: the clear stub, no medium until the weather code loads, then the stub\'s; nothing sampled', () => {
    const { env, asked, provider } = make();
    expect(env.state.weather).toEqual(clearWeather(env.state.timeMs));
    expect(env.state.medium).toBe(null);
    expect(env.state.wind.length()).toBe(0);
    env.setWeather(provider);
    expect(env.state.medium).toEqual(medium(clearWeather(0)));
    env.update();
    expect(asked).toEqual({ request: 0, sample: [], preset: [] });
    expect(env.state.weather.source.surface).toBe('preset');
  });

  it('clock state, before the weather code has loaded: asks for it, and keeps the clear stub meanwhile', () => {
    const { env, asked } = make();
    env.enterClock();
    expect(asked.request).toBeGreaterThan(0);
    expect(env.state.weather).toEqual(clearWeather(env.state.timeMs));
  });

  it('clock state with a provider: its sample at the clock\'s time, the wind as a world vector, visibility and medium', () => {
    const { env, asked, provider, clock } = make();
    env.enterClock();
    const events = [];
    env.on('weather', () => events.push(1));
    env.setWeather(provider);
    expect(events).toHaveLength(1);
    expect(asked.sample.at(-1)).toBe(clock.timeMs);
    const s = env.state;
    expect(s.weather.aerosol.dustUgM3).toBe(presetSample('dusty', 0, 620).aerosol.dustUgM3);
    // a wind from the east (90 degrees) blows toward the west: -x
    expect(s.wind.x).toBeCloseTo(-10, 9);
    expect(s.wind.z).toBeCloseTo(0, 9);
    expect(s.visibilityM).toBe(s.weather.visibilityM);
    expect(s.medium).toEqual(atmosphereMedium(s.weather, { elevationM: 620 }));
    expect(env.at({ y: 0 }).visibilityM).toBe(s.visibilityM);
  });

  it('a wind from the north blows toward the south (+z)', () => {
    const { env, provider } = make();
    env.enterClock();
    env.setWeather({ ...provider, sample: (t) => ({ ...presetSample('clear', t, 620), wind: { dirDeg: 0, speedMs: 5, gustMs: 5 } }) });
    expect(env.state.wind.z).toBeCloseTo(5, 9);
    expect(env.state.wind.x).toBeCloseTo(0, 9);
  });

  it('freeze({ weather: id }) is that preset; freeze({ weather: sample }) is that sample', () => {
    const { env, provider } = make();
    env.setWeather(provider);
    env.freeze({ weather: 'monsoon' });
    expect(env.state.weather.storm.thunder).toBe(true);
    const mine = presetSample('virga', 0, 620);
    env.freeze({ weather: mine });
    expect(env.state.weather).toBe(mine);
  });

  it('back to a pinned look: the clear stub again', () => {
    const { env, provider } = make();
    env.enterClock();
    env.setWeather(provider);
    env.pin(false);
    expect(env.state.weather.source.surface).toBe('preset');
    expect(env.state.weather.clouds).toEqual([]);
  });
});

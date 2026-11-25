// The drive's weather on plan 01's renderer (plan 02, third stretch, decision 9; src/drive/env.js weatherOn): the
// drive reads plan 01's weather (env.state, rebuilt from the clock) with the stand-in's interface, the rain shorthand
// becomes plan 01's Rain preset with overrides, the #sky Rain slider reaches the drive, and until plan 01's phase 7 the
// rain rate, wetness and the sky's dimming are derived from the sample in one marked block. No network: plan 01's
// weather service gets a fetch that always fails, and presets never fetch.
import { describe, it, expect } from 'vitest';
import { createEnv, weatherOn, weatherStateFrom, shorthandWeather, rainRateOfSample, weatherFor, RAIN_PRESETS, DRY_VISIBILITY_M } from '../../../src/drive/env.js';
import { createEnvironment } from '../../../src/env/environment.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createEphemeris } from '../../../src/sky/ephemeris.js';
import { createWeatherService } from '../../../src/weather/service.js';
import { presetSample } from '../../../src/weather/presets.js';
import { atmosphereMedium } from '../../../src/weather/derive.js';

const LV = { origin: { lat: 36.1147, lon: -115.1728 }, base: 620, stationElevationM: 664, tz: 'America/Los_Angeles', icao: 'KLAS' };
const T = Date.UTC(2026, 10, 21, 20, 30);
const noNetwork = async () => { throw new TypeError('no network in unit tests'); };

/** Plan 01's clock, environment and weather service as the app wires them (src/weather/client.js), offline. */
function plan01() {
  const clock = createSimClock({ zone: LV.tz, now: () => T, timeMs: T });
  const ephemeris = createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: LV.base });
  const env = createEnvironment({ city: LV, clock, ephemeris, settings: { night: false } });
  const service = createWeatherService({ cityId: 'lv', city: LV, fetch: noNetwork, now: () => T,
    timers: { setInterval: () => 0, clearInterval() {} }, visible: () => false });
  env.setWeather({ sample: (t) => service.sample(t), preset: (id, t) => presetSample(id, t, service.groundM), medium: (s) => atmosphereMedium(s, { elevationM: LV.base }) });
  service.on('change', () => env.weatherChanged());
  env.enterClock();
  return { clock, env, service, app: { clock, env, weather: () => Promise.resolve(service), quality: null } };
}

describe('the drive weather state from plan 01 (weatherStateFrom)', () => {
  it('is dry, calm and clear without a sample, as the stand-in was', () => {
    const s = weatherStateFrom(null);
    expect(s).toMatchObject({ precipMmPerHour: 0, precipKind: 'none', wetness: 0, overcast: 0, skyDim: 1, windMps: 0, visibilityM: DRY_VISIBILITY_M, hasTemperature: false });
    expect(Object.keys(s).sort()).toEqual(Object.keys(weatherFor(0)).sort());
  });
  it('takes the rate from the sample\'s precipitation at the ground, and wetness from the rate by the stand-in\'s rule', () => {
    const rain = presetSample('rain', T, 664);
    expect(rainRateOfSample(rain)).toBe(3);
    expect(rainRateOfSample(presetSample('virga', T, 664))).toBe(0); // evaporates before the ground
    expect(rainRateOfSample({ precip: { kind: 'snow', rateMmH: 2 } })).toBe(0); // the drive has no snow
    expect(rainRateOfSample({ precip: { kind: 'drizzle', rateMmH: 0.4 } })).toBe(0.4);
    const s = weatherStateFrom({ weather: rain, visibilityM: 12000 }, { hasTemperature: true });
    expect(s.precipMmPerHour).toBe(3);
    expect(s.wetness).toBeCloseTo(weatherFor(3).wetness, 12);
    expect(s.puddles).toBe(weatherFor(3).puddles);
    expect(s.visibilityM).toBe(12000); // plan 01's visibility, not the stand-in's rule
    expect(s.windMps).toBe(5);
    expect(s.windFromDeg).toBe(150);
    expect(s.tempC).toBe(14);
    expect(s.hasTemperature).toBe(true);
  });
  it('rounds what live data moves every frame, so the state changes now and then', () => {
    const a = presetSample('rain', T, 664), b = presetSample('rain', T, 664);
    b.precip.rateMmH += 0.001; b.wind.speedMs += 0.01; b.wind.dirDeg += 0.2;
    expect(weatherStateFrom({ weather: a, visibilityM: 12003 })).toEqual(weatherStateFrom({ weather: b, visibilityM: 12001 }));
  });
});

describe('the rain shorthand in plan 01\'s weather (shorthandWeather)', () => {
  it('is plan 01\'s Rain preset with the stand-in preset\'s rate and wind, and nothing for clear', () => {
    expect(shorthandWeather('clear')).toBe(null);
    expect(shorthandWeather(0)).toBe(null);
    expect(shorthandWeather('nonsense')).toBe(null);
    for (const p of RAIN_PRESETS.slice(1)) {
      expect(shorthandWeather(p.id)).toEqual({ source: { kind: 'preset', id: 'rain' }, overrides: { rain: p.mmPerHour, windSpeed: p.windMps, windDir: 200 } });
    }
    expect(shorthandWeather(30).overrides).toEqual({ rain: 30, windSpeed: 7, windDir: 200 });
    expect(shorthandWeather(0.3).overrides.windSpeed).toBe(1);
  });
});

describe('env.weather on plan 01 (weatherOn) with plan 01\'s environment and weather service', () => {
  it('follows plan 01\'s weather: a preset, then the #sky Rain slider, with change events', async () => {
    const { env, service, app } = plan01();
    const w = weatherOn(app);
    await w.whenApplied();
    expect(w.state().precipMmPerHour).toBe(0); // live data that cannot load: plan 01 falls back to its clear preset
    const seen = [];
    w.on('change', (s) => seen.push(s.precipMmPerHour));
    service.setSource({ kind: 'preset', id: 'rain' });
    expect(w.state().precipMmPerHour).toBe(3);
    expect(w.state().wetness).toBeCloseTo(weatherFor(3).wetness, 12);
    expect(w.state().visibilityM).toBe(env.state.visibilityM);
    service.setOverride('rain', 20); // the Rain slider of #sky
    expect(w.state().precipMmPerHour).toBe(20);
    service.setOverride('rain', 0);
    expect(w.state()).toMatchObject({ precipMmPerHour: 0, wetness: 0, precipKind: 'none' });
    expect(seen).toEqual([3, 20, 0]);
    expect(w.hasTemperature).toBe(true);
    expect(w.state().tempC).toBe(14);
    w.dispose();
  });

  it('writes the shorthand into plan 01\'s weather, and release puts back what was there unless the visitor changed it', async () => {
    const { service, app } = plan01();
    service.setSource({ kind: 'history', year: 2020 });
    service.setOverride('haze', 0.3);
    const w = weatherOn(app);
    w.setPreset('heavy');
    const s = await w.whenApplied();
    expect(service.source).toEqual({ kind: 'preset', id: 'rain' });
    expect(service.overrides).toEqual({ rain: 12, windSpeed: 7, windDir: 200 });
    expect(s).toMatchObject({ preset: 'heavy', precipMmPerHour: 12, windMps: 7, windFromDeg: 200 });
    w.setRain(2.5);
    expect((await w.whenApplied()).precipMmPerHour).toBe(2.5);
    expect(w.state().preset).toBe(null);
    await w.release();
    expect(service.source).toEqual({ kind: 'history', year: 2020 });
    expect(service.overrides).toEqual({ haze: 0.3 });
    // the visitor moves the slider after a shorthand: their weather is kept on release
    w.setPreset('light');
    await w.whenApplied();
    service.setOverride('rain', 6);
    expect(w.state().preset).toBe(null);
    await w.release();
    expect(service.overrides.rain).toBe(6);
    // clear asks for nothing of plan 01 when no shorthand is in force
    const before = { source: service.source, overrides: service.overrides };
    w.setPreset('clear');
    await w.whenApplied();
    expect({ source: service.source, overrides: service.overrides }).toEqual(before);
  });

  it('is a pure function of the clock: the same moment and settings give the same state', async () => {
    const a = plan01(), b = plan01();
    for (const p of [a, b]) p.service.setSource({ kind: 'preset', id: 'monsoon' });
    a.clock.set(T + 3600000); a.env.update();
    b.clock.set(T - 7200000); b.env.update(); b.clock.set(T + 3600000); b.env.update();
    expect(weatherOn(a.app).state()).toEqual(weatherOn(b.app).state());
  });

  it('is what createEnv gives on plan 01, and its sky dimming still dims the ambient light (stand-in until phase 3)', async () => {
    const { env: p01, service, app } = plan01();
    const env = createEnv({ city: LV, app: { ...app, env: Object.assign(p01, { nodes: {} }) } });
    expect(env.weather.plan01).toBe(true);
    const clear = env.lighting.ambientLux();
    service.setSource({ kind: 'preset', id: 'rain' });
    expect(env.lighting.ambientLux()).toBeCloseTo(p01.state.sky.horizontalLux * weatherFor(3).skyDim, 6);
    expect(env.lighting.ambientLux()).toBeLessThan(clear);
  });
});

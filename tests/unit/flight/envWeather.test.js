// Plan 03, F2.8's as-flown weather and F5.3's input: while a recorded flight is attached, the adapter's at() answers
// from the weather the flight was flown in (the header's `weather`, written by the bake), hands it to plan 01's
// weather service the way #sky sets it, and gives the map's settings back when the journey ends.
import { describe, it, expect, vi } from 'vitest';
import { Vector3 } from 'three';
import { createSimClock } from '../../../src/sim/clock.js';
import { createTimeline } from '../../../src/sim/timeline.js';
import { createFlightEnv, recordedAir, cloudAt, planOneSettings, standardAtmosphere, CLEAR_VISIBILITY_M, WEATHER_FORMAT } from '../../../src/flight/env.js';
import { applyOverrides } from '../../../src/weather/overrides.js';
import { presetSample } from '../../../src/weather/presets.js';
import cities from '../../../data/cities.json' with { type: 'json' };
import wx from '../../../public/data/lv/flights/lv-wx.json' with { type: 'json' };
import day19 from '../../../public/data/lv/flights/lv-19-day.json' with { type: 'json' };
import dusk19 from '../../../public/data/lv/flights/lv-19-dusk.json' with { type: 'json' };

const city = cities.lv;
const ELEV = city.stationElevationM;
const FT = 0.3048;

/** A fake plan 01 weather service with #sky's public members (src/weather/service.js). */
function fakeService(groundM = ELEV) {
  const listeners = new Set();
  const svc = {
    groundM,
    _source: { kind: 'live' }, _overrides: {},
    get source() { return { ...svc._source }; },
    get overrides() { return { ...svc._overrides }; },
    setSource: vi.fn((s) => { svc._source = { ...s }; for (const fn of listeners) fn(); }),
    setOverride: vi.fn((k, v) => { const n = { ...svc._overrides }; if (v === null) delete n[k]; else n[k] = v; svc._overrides = n; for (const fn of listeners) fn(); }),
    clearOverrides: vi.fn(() => { svc._overrides = {}; }),
    on: (t, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return svc;
}

function fakeApp({ service = fakeService(), weather = null } = {}) {
  const T = Date.parse(wx.recordedStart);
  const clock = createSimClock({ zone: city.tz, now: () => T, timeMs: T });
  const timeline = createTimeline({ clock });
  const listeners = new Map();
  const env = {
    state: { timeMs: T, sun: { altDeg: 30 }, weather: weather ?? { tempC: 20, rh: 0.3, clouds: [], precip: { kind: 'none', rateMmH: 0 } }, wind: new Vector3(), visibilityM: 60000 },
    nodes: {}, lights: {},
    at: vi.fn((pos) => ({ rainRateMmH: 0, cloudDensity: 0, inCloud: false, visibilityM: 60000, tempC: 20 - 0.0065 * pos.y, wind: new Vector3(1, 0, 0) })),
    on: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    emit: (type) => { for (const fn of listeners.get(type) || []) fn(); },
  };
  const loop = { add: () => () => {}, invalidate: () => {} };
  const transport = { attachJourney: (j) => (j ? timeline.begin(j) : (timeline.active?.end(), null)) };
  const app = { city, cityId: 'lv', clock, timeline, env, loop, transport, invalidate: () => {}, events: { on() {}, emit() {} } };
  if (service) app.loadWeather = vi.fn(() => Promise.resolve(service));
  return { app, service, env };
}

/** A journey as session.js makes it: what the adapter reads is journey.track.meta. */
const journeyOf = (meta) => ({ id: meta.id, label: meta.id, durationS: meta.samples, recordedStartMs: Date.parse(meta.recordedStart), track: { meta } });

/** A scene position at a height above sea level over the city origin. */
const over = (fe, altM, x = 0, n = 0) => new Vector3(x, fe.frame.sceneY(altM, x, n), -n);

describe('the weather record', () => {
  it('every baked flight carries one in the format the adapter reads', () => {
    for (const h of [wx, day19, dusk19]) {
      expect(h.weather.format).toBe(WEATHER_FORMAT);
      expect(recordedAir(h)).not.toBe(null);
    }
    expect(recordedAir({ atmosphere: [] })).toBe(null);
    expect(recordedAir({ weather: { metar: 'old' } })).toBe(null);
  });

  it('lv-wx: in the overcast from its observed base to its estimated top, clear below and above', () => {
    const air = recordedAir(wx);
    const [L] = air.layers;
    expect(L.baseM).toBeCloseTo(ELEV + 500 * FT, 0);
    expect(air.at(L.baseM - 30).inCloud).toBe(false);
    expect(air.at(ELEV + 2000 * FT).inCloud).toBe(true);
    expect(air.at(L.topM + 30).inCloud).toBe(false);
    // the visibility: the reports' under the base (4 to 7 miles), the estimate inside, clear above
    expect(air.at(L.baseM - 30).visibilityM).toBeGreaterThan(9000);
    expect(air.at(L.baseM - 30).visibilityM).toBeLessThan(12000);
    expect(air.at(1500).visibilityM).toBe(110);
    expect(air.at(L.topM + 100).visibilityM).toBe(CLEAR_VISIBILITY_M);
    // no rain anywhere: the morning's rain had ended
    for (const z of [700, 1500, 3000]) expect(air.at(z).rainRateMmH).toBe(0);
  });

  it('temperature and wind from the header\'s atmosphere, pressure and humidity from the GFS column', () => {
    const air = recordedAir(wx);
    const a = air.at(ELEV);
    expect(a.tempC).toBeCloseTo(wx.atmosphere[0][1], 6);
    expect(a.pressureHPa).toBeCloseTo(wx.weather.aloft[0][1], 3);
    const lev = wx.weather.aloft.find((r) => r[1] === 850);
    expect(air.at(lev[0]).pressureHPa).toBeCloseTo(850, 3);
    expect(air.at(lev[0]).rh).toBeCloseTo(lev[3] / 100, 6);
    // cruise: the column's temperature, not the standard day's
    const cruise = air.at(9353);
    const row = wx.atmosphere.find((r) => Math.abs(r[0] - 9353) < 300) || wx.atmosphere.at(-1);
    expect(Math.abs(cruise.tempC - row[1])).toBeLessThan(3);
    expect(cruise.densityKgM3).toBeCloseTo((cruise.pressureHPa * 100) / (287.05287 * (cruise.tempC + 273.15)), 9);
    // wind: grid east and north in the header, x east and z south in the scene
    const r = wx.atmosphere.at(-1);
    const top = air.at(r[0] + 10);
    expect(top.wind.x).toBeCloseTo(r[2], 6);
    expect(top.wind.z).toBeCloseTo(-r[3], 6);
    // above the column: the standard atmosphere's shape from its top
    const hi = air.at(15000);
    expect(hi.pressureHPa / standardAtmosphere(15000).pressureHPa).toBeCloseTo(wx.weather.aloft.at(-1)[1] / standardAtmosphere(wx.weather.aloft.at(-1)[0]).pressureHPa, 6);
  });

  it('the five other flights: only their high cloud, crossed where the record says', () => {
    const air = recordedAir(day19);
    const ovc = air.layers.find((l) => l.cover === 'OVC');
    expect(ovc.baseM - ELEV).toBeCloseTo(23000 * FT, 0);
    expect(air.at(ovc.baseM + 100).inCloud).toBe(true);
    expect(air.at(5000).inCloud).toBe(false);
    const d = recordedAir(dusk19);
    for (let z = 700; z < 12000; z += 250) expect(d.at(z).inCloud).toBe(false); // a few clouds at 14,000 ft: passed between
  });

  it('cloudAt reads a plan 01 sample\'s layers too (cover in place of fraction)', () => {
    const layers = presetSample('overcast', 0, ELEV).clouds;
    expect(cloudAt(layers, layers[0].baseM + 100).inCloud).toBe(true);
    expect(cloudAt(layers, layers[0].baseM - 100, { belowBaseM: 40000 }).visibilityM).toBe(40000);
    expect(cloudAt([], 2000, { belowBaseM: 40000 }).visibilityM).toBe(40000);
  });
});

describe('the record as plan 01 weather settings', () => {
  it('lv-wx: the clear preset with an overcast at the reported base, the reported visibility, the surface wind, no rain', () => {
    const s = planOneSettings(wx.weather, ELEV);
    expect(s.source).toEqual({ kind: 'preset', id: 'clear' });
    expect(s.overrides.lowCloud).toBe(1);
    expect(s.overrides.highCloud).toBe(0);
    expect(s.overrides.cloudBase).toBeCloseTo(500 * FT, 1);
    expect(s.overrides.rain).toBe(0);
    // what plan 01 then makes of it: one low layer at the base, the visibility of the reports
    const sample = applyOverrides(presetSample('clear', 0, ELEV), s.overrides, { groundM: ELEV });
    expect(sample.clouds.length).toBe(1);
    expect(sample.clouds[0].baseM).toBeCloseTo(ELEV + 500 * FT, 1);
    expect(sample.clouds[0].cover).toBe(1);
    expect(sample.visibilityM / wx.weather.visibility.belowBaseM).toBeCloseTo(1, 1);
    expect(s.omitted.join(' ')).toMatch(/temperature/);
  });

  it('lv-19-day: the high overcast as plan 01\'s high cloud, the scattered mid-level layer named as left out', () => {
    const s = planOneSettings(day19.weather, ELEV);
    expect(s.overrides.lowCloud).toBe(0);
    expect(s.overrides.highCloud).toBe(1);
    expect(s.overrides.cloudBase).toBeUndefined();
    expect(s.overrides.haze).toBeUndefined(); // ten miles or more: the preset's own clear air
    expect(s.omitted.join(' ')).toMatch(/mid-level SCT/);
  });
});

describe('the adapter while a recorded flight flies', () => {
  it('at() answers from the record while the journey is attached, from plan 01 before and after', async () => {
    const { app, env } = fakeApp();
    const fe = createFlightEnv(app);
    const p = over(fe, ELEV + 2000 * FT, 3000, -2000);
    expect(fe.at(p).inCloud).toBe(false);
    expect(fe.at(p).source).toBe('plan01');
    fe.attachJourney(journeyOf(wx));
    const a = fe.at(p);
    expect(a.source).toBe('as-flown');
    expect(a.inCloud).toBe(true);
    expect(a.visibilityM).toBe(110);
    expect(fe.at(over(fe, ELEV + 300 * FT, 3000, -2000)).inCloud).toBe(false);
    expect(fe.sky().layers[0].cover).toBe('OVC');
    expect(fe.flightWeather.badge).toBe('overcast');
    fe.attachJourney(null);
    expect(fe.at(p).source).toBe('plan01');
    expect(fe.flightWeather).toBe(null);
    expect(env.at).toHaveBeenCalled();
  });

  it('tells weather listeners when a record comes and goes (the session rebuilds the pane then)', () => {
    const { app } = fakeApp();
    const fe = createFlightEnv(app);
    const fn = vi.fn();
    const off = fe.onWeather(fn);
    fe.attachJourney(journeyOf(wx));
    expect(fn).toHaveBeenCalledTimes(1);
    fe.attachJourney(null);
    expect(fn).toHaveBeenCalledTimes(2);
    app.env.emit('weather');
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    fe.attachJourney(journeyOf(wx));
    app.env.emit('weather');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('hands the record to plan 01\'s service and gives the map\'s settings back on leaving', async () => {
    const { app, service } = fakeApp();
    service._source = { kind: 'preset', id: 'hazy' };
    service._overrides = { windSpeed: 7 };
    const fe = createFlightEnv(app);
    fe.attachJourney(journeyOf(wx));
    await fe.whenWeatherApplied();
    expect(service.source).toEqual({ kind: 'preset', id: 'clear' });
    expect(service.overrides.lowCloud).toBe(1);
    expect(service.overrides.cloudBase).toBeCloseTo(152.4, 1);
    expect(fe.flightWeather.plan01.overrides.lowCloud).toBe(1);
    fe.attachJourney(null);
    await fe.whenWeatherApplied();
    expect(service.source).toEqual({ kind: 'preset', id: 'hazy' });
    expect(service.overrides).toEqual({ windSpeed: 7 });
  });

  it('a retimed flight keeps the weather as flown (plan 4.2)', async () => {
    const { app, service } = fakeApp();
    const fe = createFlightEnv(app);
    const h = fe.attachJourney(journeyOf(wx));
    await fe.whenWeatherApplied();
    h.setStart(Date.UTC(2026, 6, 4, 2));
    expect(fe.at(over(fe, ELEV + 2000 * FT)).inCloud).toBe(true);
    expect(service.overrides.lowCloud).toBe(1);
  });

  it('once the visitor picks other weather in #sky, that weather is flown and left in place on leaving', async () => {
    const { app, service, env } = fakeApp();
    const fe = createFlightEnv(app);
    fe.attachJourney(journeyOf(wx));
    await fe.whenWeatherApplied();
    // the visitor picks the Overcast preset: plan 01's sample has its layers
    service.setSource({ kind: 'preset', id: 'overcast' });
    env.state.weather = presetSample('overcast', 0, ELEV);
    env.state.visibilityM = env.state.weather.visibilityM;
    const sc = env.state.weather.clouds[0];
    expect(fe.at(over(fe, sc.baseM + 100)).inCloud).toBe(true);
    expect(fe.at(over(fe, ELEV + 2000 * FT)).inCloud).toBe(false); // 600 m above the ground: under the preset's base
    expect(fe.sky().source).toBe('plan01');
    expect(fe.flightWeather.visitorChose).toBe(true);
    fe.attachJourney(null);
    await fe.whenWeatherApplied();
    expect(service.source).toEqual({ kind: 'preset', id: 'overcast' });
  });

  it('a flight without a record, or an app without plan 01\'s weather, changes nothing in plan 01', async () => {
    const { app, service } = fakeApp();
    const fe = createFlightEnv(app);
    const meta = { ...wx, weather: null };
    fe.attachJourney(journeyOf(meta));
    await fe.whenWeatherApplied();
    expect(service.setSource).not.toHaveBeenCalled();
    expect(fe.at(over(fe, 1500)).source).toBe('plan01');
    const bare = fakeApp({ service: null });
    const fe2 = createFlightEnv(bare.app);
    fe2.attachJourney(journeyOf(wx));
    await fe2.whenWeatherApplied();
    expect(fe2.at(over(fe2, ELEV + 2000 * FT)).inCloud).toBe(true);
  });
});

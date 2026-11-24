// T5.3: the client weather service (plan 01, sections 5.4 and 6.3) with the real handler behind a fetch that answers
// from the recorded fixtures: nothing fetched until asked, the fallback chain function -> Open-Meteo -> preset, months
// fetched ahead so midnight and month ends never wait, live refresh while visible, history, overrides.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import cities from '../../../data/cities.json' with { type: 'json' };
import { createWeatherHandler } from '../../../api/_lib/handler.js';
import { createWeatherService, PREFETCH_MS } from '../../../src/weather/service.js';
import { presetSample } from '../../../src/weather/presets.js';
import { validateSample } from '../../../src/weather/schema.js';
import { loadFixture, fixtureFetch } from '../../helpers/weatherFixtures.js';
import { ROOT } from '../../helpers/staticServer.js';

const H = 3600000;
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };

/** A browser-side fetch: /api/weather goes to the real handler over `upstream`, data/ to public/, the rest upstream. */
function browserFetch({ upstream, now, api = 'ok' }) {
  const calls = [];
  const handle = createWeatherHandler({ cities, fetch: upstream, now, timeoutMs: 100 });
  const fn = async (url, init) => {
    calls.push(url);
    if (url.startsWith('/api/weather')) {
      if (api === 'throw') throw new TypeError('Failed to fetch');
      if (api === 'html') return new Response('<!doctype html><title>preview</title>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (api === 404) return new Response('not found', { status: 404 });
      return handle(new Request(`https://skyline.test${url}`));
    }
    if (url.startsWith('data/')) {
      const file = path.join(ROOT, 'public', url);
      return fs.existsSync(file) ? new Response(fs.readFileSync(file), { status: 200 }) : new Response('', { status: 404 });
    }
    return upstream(url, init);
  };
  fn.calls = calls;
  return fn;
}
const fakeTimers = () => { const t = { fns: [], setInterval: (fn) => { t.fns.push(fn); return t.fns.length; }, clearInterval() {}, tick() { for (const f of t.fns) f(); } }; return t; };

function make({ city = 'lv', fixture, fail, api, now, visible = () => true, upstream } = {}) {
  const clock = { t: now };
  const up = upstream || fixtureFetch(fixture, { fail });
  const fetch = browserFetch({ upstream: up, now: () => clock.t, api });
  const timers = fakeTimers();
  const service = createWeatherService({ cityId: city, city: cities[city], fetch, now: () => clock.t, timers, visible, timeoutMs: 200 });
  return { service, fetch, upstream: up, timers, clock };
}

const LIVE_NOW = Date.parse(loadFixture('lv', 'live').responses.aviationweather.body[0].receiptTime);

describe('fetching', () => {
  it('nothing is fetched until a sample is asked for', async () => {
    const { fetch } = make({ fixture: loadFixture('lv', 'live'), now: LIVE_NOW });
    await settle();
    expect(fetch.calls).toEqual([]);
  });

  it('the clear preset until data arrives, then the fused data, from the function', async () => {
    const { service, fetch } = make({ fixture: loadFixture('lv', 'live'), now: LIVE_NOW });
    const first = service.sample(LIVE_NOW);
    expect(first).toEqual(presetSample('clear', LIVE_NOW, cities.lv.stationElevationM));
    expect(service.status(LIVE_NOW).loading).toBe(true);
    await until(() => service.chunks.some((c) => c.status === 'ok'));
    const s = service.sample(LIVE_NOW);
    expect(validateSample(s)).toEqual([]);
    expect(s.source.surface).toBe('metar');
    expect(s.t).toBe(LIVE_NOW);
    const st = service.status(LIVE_NOW);
    expect(st).toMatchObject({ kind: 'live', dataKind: 'live', via: 'function', loading: false, unavailable: false, partial: false, station: 'KLAS' });
    expect(st.attribution.join(' ')).toMatch(/Open-Meteo\.com/);
    expect(fetch.calls).toEqual(['/api/weather?city=lv&live=1']);
  });

  it('the function unreachable (or an HTML page in its place): Open-Meteo from the browser, without reports', async () => {
    for (const api of ['throw', 404, 'html']) {
      const { service, fetch } = make({ fixture: loadFixture('lv', 'live'), now: LIVE_NOW, api });
      service.sample(LIVE_NOW);
      await until(() => service.chunks.some((c) => c.status === 'ok'));
      expect(service.status(LIVE_NOW)).toMatchObject({ via: 'open-meteo', partial: true, observedAtMs: null });
      expect(service.sample(LIVE_NOW).source.surface).toBe('model');
      expect(fetch.calls.filter((u) => u.includes('open-meteo.com')).length).toBe(2);
    }
  });

  it('Open-Meteo throttles the function (429): the browser asks Open-Meteo itself and keeps the function\'s reports', async () => {
    const fixture = loadFixture('lv', 'live');
    let n = 0;
    const base = fixtureFetch(fixture);
    // the function's request to Open-Meteo is the first; the browser's own comes after
    const upstream = async (url, init) => (url.includes('api.open-meteo.com') && n++ === 0 ? new Response('{}', { status: 429 }) : base(url, init));
    const { service } = make({ upstream, now: LIVE_NOW });
    service.sample(LIVE_NOW);
    await until(() => service.chunks.some((c) => c.status === 'ok'));
    const st = service.status(LIVE_NOW);
    expect(st.via).toBe('function+open-meteo');
    expect(st.station).toBe('KLAS');
    expect(service.sample(LIVE_NOW).source.surface).toBe('metar');
  });

  it('everything down: unavailable, and the sample stays the clear preset', async () => {
    const all = { 'open-meteo': 'throw', 'open-meteo-air': 'throw', aviationweather: 'throw', nws: 'throw', iem: 'throw' };
    const { service } = make({ fixture: loadFixture('lv', 'live'), now: LIVE_NOW, fail: all, api: 'throw' });
    service.sample(LIVE_NOW);
    await until(() => service.chunks.some((c) => c.status === 'failed'));
    expect(service.status(LIVE_NOW)).toMatchObject({ unavailable: true, loading: false });
    expect(service.sample(LIVE_NOW).source.surface).toBe('preset');
  });

  it('a past date loads its month, and the aerosol climatology when the feed did not exist', async () => {
    const { service, fetch } = make({ fixture: loadFixture('lv', '1975-07-14'), now: LIVE_NOW });
    const t = Date.UTC(1975, 6, 14, 0);
    service.sample(t);
    await until(() => service.chunks.some((c) => c.key === '1975-07' && c.status === 'ok'));
    const s = service.sample(t);
    await until(() => fetch.calls.includes('data/lv/aerosol.json'));
    await settle();
    const again = service.sample(t);
    expect(again.source.aerosol).toBe('climatology');
    expect(again.visibilityM).toBeCloseTo(35 * 1609.344, 0);
    expect(service.status(t)).toMatchObject({ dataKind: 'archive', station: 'KLAS', aerosol: 'climatology' });
    expect(s.tempC).toBeCloseTo(38.3, 6);
  });
});

// a synthetic archive: smooth hourly values for whatever days are asked, so a month boundary can be crossed
function syntheticUpstream() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'mesonet.agron.iastate.edu') return new Response('station,valid,metar\n', { status: 200 });
    if (u.hostname !== 'archive-api.open-meteo.com') return new Response('{}', { status: 404 });
    const from = Date.parse(`${u.searchParams.get('start_date')}T00:00:00Z`), to = Date.parse(`${u.searchParams.get('end_date')}T23:00:00Z`);
    const time = [], temp = [];
    for (let t = from; t <= to; t += H) { time.push(t / 1000); temp.push(20 + 8 * Math.sin((t / H) * (2 * Math.PI / 24))); }
    const n = time.length, fill = (v) => Array(n).fill(v);
    return new Response(JSON.stringify({ hourly: { time, temperature_2m: temp, dew_point_2m: fill(0), relative_humidity_2m: fill(20), surface_pressure: fill(940),
      cloud_cover: fill(0), cloud_cover_low: fill(0), cloud_cover_mid: fill(0), cloud_cover_high: fill(0), wind_speed_10m: fill(3), wind_direction_10m: fill(200),
      wind_gusts_10m: fill(5), precipitation: fill(0), rain: fill(0), showers: fill(0), snowfall: fill(0), weather_code: fill(0), boundary_layer_height: fill(1500) } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

describe('scrubbing', () => {
  it('across midnight UTC inside a month: no new request, no jump', async () => {
    const { service, fetch } = make({ upstream: syntheticUpstream(), now: LIVE_NOW });
    const mid = Date.UTC(2025, 6, 15);
    service.sample(mid - H);
    await until(() => service.chunks.some((c) => c.status === 'ok'));
    const api = () => fetch.calls.filter((u) => u.startsWith('/api/weather')).length;
    const before = api();
    let prev = service.sample(mid - 30 * 60000);
    for (let t = mid - 29 * 60000; t <= mid + 30 * 60000; t += 60000) {
      const s = service.sample(t);
      expect(s.source.surface).toBe('model');
      expect(Math.abs(s.tempC - prev.tempC)).toBeLessThan(0.05); // 8 degrees of daily swing: under 0.04 a minute
      prev = s;
    }
    expect(api()).toBe(before);
  });

  it('towards a month\'s end the next month is fetched ahead, so crossing it never falls back to the preset', async () => {
    const { service, fetch } = make({ upstream: syntheticUpstream(), now: LIVE_NOW });
    const edge = Date.UTC(2025, 7, 1);
    service.sample(edge - PREFETCH_MS + H);
    await until(() => ['2025-07', '2025-08'].every((k) => service.chunks.some((c) => c.key === k && c.status === 'ok')));
    expect(fetch.calls.filter((u) => u.startsWith('/api/weather'))).toEqual(['/api/weather?city=lv&month=2025-07', '/api/weather?city=lv&month=2025-08']);
    let prev = service.sample(edge - 2 * H);
    for (let t = edge - 2 * H + 60000; t <= edge + 2 * H; t += 60000) {
      const s = service.sample(t);
      expect(s.source.surface, new Date(t).toISOString()).toBe('model');
      expect(Math.abs(s.tempC - prev.tempC)).toBeLessThan(0.05);
      prev = s;
    }
  });
});

describe('live refresh', () => {
  it('every five minutes while in use and visible; not while hidden', async () => {
    let visible = true;
    const { service, fetch, timers, clock } = make({ fixture: loadFixture('lv', 'live'), now: LIVE_NOW, visible: () => visible });
    service.sample(clock.t);
    await until(() => service.chunks.some((c) => c.status === 'ok'));
    const count = () => fetch.calls.filter((u) => u === '/api/weather?city=lv&live=1').length;
    expect(count()).toBe(1);
    clock.t += 4 * 60000; service.sample(clock.t); timers.tick(); await settle();
    expect(count()).toBe(1);
    clock.t += 2 * 60000; service.sample(clock.t); timers.tick();
    await until(() => count() === 2);
    await until(() => service.chunks.find((c) => c.key === 'live').status === 'ok');
    visible = false;
    clock.t += 6 * 60000; service.sample(clock.t); timers.tick(); await settle();
    expect(count()).toBe(2);
    // not in use (nothing asked for a sample for ten minutes): no refresh either
    visible = true;
    clock.t += 11 * 60000; timers.tick(); await settle();
    expect(count()).toBe(2);
  });
});

describe('sources and overrides', () => {
  it('a preset: no request at all', async () => {
    const { service, fetch } = make({ fixture: loadFixture('lv', 'live'), now: LIVE_NOW });
    service.setSource({ kind: 'preset', id: 'monsoon' });
    expect(service.sample(LIVE_NOW).storm.thunder).toBe(true);
    expect(service.status(LIVE_NOW)).toMatchObject({ kind: 'preset', preset: 'monsoon' });
    await settle();
    expect(fetch.calls).toEqual([]);
  });

  it('this date in history: the clock\'s day and time, in the chosen year', async () => {
    const { service, fetch } = make({ fixture: loadFixture('lv', '1975-07-14'), now: LIVE_NOW });
    service.setSource({ kind: 'history', year: 1975 });
    const t = Date.UTC(2026, 6, 14, 0);
    service.sample(t);
    await until(() => service.chunks.some((c) => c.key === '1975-07' && c.status === 'ok'));
    const s = service.sample(t);
    expect(s.t).toBe(t);
    expect(s.visibilityM).toBeCloseTo(35 * 1609.344, 0);
    expect(service.status(t)).toMatchObject({ kind: 'history', year: 1975, dataTimeMs: Date.UTC(1975, 6, 14, 0) });
    expect(fetch.calls[0]).toBe('/api/weather?city=lv&month=1975-07');
    service.setSource({ kind: 'history', year: 1900 });
    expect(service.source.year).toBe(1940);
  });

  it('overrides on top of the data; clearing one gives back the data exactly; back to real clears all', async () => {
    const { service } = make({ fixture: loadFixture('lv', 'live'), now: LIVE_NOW });
    service.sample(LIVE_NOW);
    await until(() => service.chunks.some((c) => c.status === 'ok'));
    const data = service.sample(LIVE_NOW);
    service.setOverride('haze', 0.8);
    service.setOverride('windSpeed', 15);
    expect(service.sample(LIVE_NOW).aerosol.aod550).toBe(0.8);
    expect(service.status(LIVE_NOW).overridden.sort()).toEqual(['haze', 'windSpeed']);
    service.setOverride('haze', null);
    expect(service.sample(LIVE_NOW).aerosol.aod550).toBe(data.aerosol.aod550);
    service.setOverride('windSpeed', null);
    expect(service.sample(LIVE_NOW)).toEqual(data);
    service.setSource({ kind: 'preset', id: 'rain' });
    service.setOverride('lightning', 5);
    service.backToReal();
    expect(service.source).toEqual({ kind: 'live' });
    expect(service.overrides).toEqual({});
  });
});

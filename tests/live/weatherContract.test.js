// The daily contract test (plan 01, T5.6 and risk R6): calls the real upstreams through the same URL templates and
// normalizers the function uses, and, when SKYLINE_DEPLOY_URL names a deployment, the deployed /api/weather. It
// catches schema drift before visitors do. Requests go one at a time with the function's generic User-Agent.
//
//   pnpm test:live                                            the upstream half
//   SKYLINE_DEPLOY_URL=https://<deployment> pnpm test:live    both halves
//
// Only fields every global model provides are required (decision 11: Open-Meteo retires HRRR and NAM at the end of
// November 2026); the rest must be numbers or null.
import { describe, it, expect } from 'vitest';
import cities from '../../data/cities.json' with { type: 'json' };
import { openMeteoLive, openMeteoMonth, aviationWeatherUrl, nwsUrl, iemMonthUrl, monthOf } from '../../src/weather/sources.js';
import { normalizeOpenMeteo, normalizeAirQuality, parseAviationWeather, parseNws, parseIemCsv } from '../../src/weather/normalize.js';
import { createWeatherHandler, USER_AGENT, CACHE } from '../../api/_lib/handler.js';
import { validateSample } from '../../src/weather/schema.js';
import { fuse } from '../../src/weather/derive.js';

const BASE = (process.env.SKYLINE_DEPLOY_URL || '').replace(/\/+$/, '');
const headers = { 'user-agent': USER_AGENT };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, kind = 'json') {
  await sleep(1100); // one request at a time, and the Iowa archive's one-a-second throttle
  const res = await fetch(url, { headers });
  expect(res.status, url).toBe(200);
  return kind === 'csv' ? res.text() : res.json();
}
const REQUIRED = ['tempC', 'dewPointC', 'rh', 'pressureHPa', 'cloud', 'cloudLow', 'cloudMid', 'cloudHigh', 'windSpeedMs', 'windDirDeg', 'gustMs', 'precipMm', 'weatherCode'];
const OPTIONAL = ['visibilityM', 'capeJKg', 'liftedIndex', 'cinJKg', 'freezingLevelM', 'blhM', 'rainMm', 'showersMm', 'snowCm'];
function checkModel(hours, label) {
  expect(hours.length, label).toBeGreaterThan(20);
  for (const h of hours.slice(0, 48)) {
    for (const k of REQUIRED) expect(Number.isFinite(h[k]), `${label} ${k} at ${new Date(h.t).toISOString()}`).toBe(true);
    for (const k of OPTIONAL) expect(h[k] === null || Number.isFinite(h[k]), `${label} ${k}`).toBe(true);
    expect(h.cloud).toBeGreaterThanOrEqual(0);
    expect(h.cloud).toBeLessThanOrEqual(1);
  }
}

for (const cityId of ['lv', 'slc']) {
  const city = cities[cityId];
  describe(`upstreams for ${cityId}`, () => {
    it('Open-Meteo forecast and air quality (the live window)', async () => {
      const u = openMeteoLive(city);
      checkModel(normalizeOpenMeteo(await get(u.forecast)), 'forecast');
      const air = normalizeAirQuality(await get(u.air));
      expect(air.length).toBeGreaterThan(24);
      for (const a of air.slice(0, 24)) expect(a.aod550).toBeGreaterThanOrEqual(0);
    });
    it('Open-Meteo archive, historical forecast and air quality (a month)', async () => {
      const u = openMeteoMonth(city, '2023-08', Date.now());
      checkModel(normalizeOpenMeteo(await get(u.archive)), 'archive');
      const hf = normalizeOpenMeteo(await get(u.historicalForecast));
      expect(hf.length).toBeGreaterThan(24 * 28);
      expect(normalizeAirQuality(await get(u.air)).length).toBeGreaterThan(24 * 28);
      // ERA5's first hours (1 January 1940 before 07:00 UTC) have no gusts or accumulations: start a day in
      const old = normalizeOpenMeteo(await get(openMeteoMonth(city, '1940-01', Date.now()).archive));
      checkModel(old.slice(24), 'archive 1940');
    });
    it('aviationweather.gov and the NWS API: the last day of reports', async () => {
      const av = parseAviationWeather(await get(aviationWeatherUrl(city)));
      expect(av.length).toBeGreaterThan(10);
      for (const o of av) { expect(o.station).toBe(city.icao); expect(Number.isFinite(o.tempC)).toBe(true); }
      const nws = parseNws(await get(nwsUrl(city)));
      expect(nws.length).toBeGreaterThan(10);
    });
    it('the Iowa Environmental Mesonet: a month of archived reports, raw METAR kept', async () => {
      const obs = parseIemCsv(await get(iemMonthUrl(city, '1975-07', Date.now()), 'csv'));
      expect(obs.length).toBeGreaterThan(24 * 28);
      expect(obs.filter((o) => o.raw.includes(city.icao)).length).toBe(obs.length);
      expect(obs.some((o) => o.visibilityM !== null && !o.visibilityCensored)).toBe(true);
    });
    it('the function\'s handler over the real upstreams: complete, and every hour fuses to a valid sample', async () => {
      const handle = createWeatherHandler({ cities, timeoutMs: 15000 });
      for (const q of ['live=1', `month=${monthOf(Date.now() - 400 * 86400000)}`]) {
        await sleep(1100);
        const res = await handle(new Request(`https://skyline.test/api/weather?city=${cityId}&${q}`));
        const body = await res.json();
        expect(res.status, q).toBe(200);
        expect(body.meta.sources.filter((s) => !s.ok && s.id !== 'aviationweather'), q).toEqual([]); // the NWS API stands in for it
        expect(body.meta.partial, q).toBe(false);
        for (const h of body.data.model.slice(0, 48)) {
          expect(validateSample(fuse(body.data, h.t, { groundM: city.stationElevationM })), `${q} ${new Date(h.t).toISOString()}`).toEqual([]);
        }
      }
    });
  });
}

describe.skipIf(!BASE)('the deployed function (SKYLINE_DEPLOY_URL)', () => {
  it('live: the envelope, the live cache, attribution', async () => {
    await sleep(1100);
    const res = await fetch(`${BASE}/api/weather?city=lv&live=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, error: null, data: { city: 'lv' } });
    expect(body.data.model.length).toBeGreaterThan(100);
    expect(body.meta.attribution.join(' ')).toMatch(/Open-Meteo\.com/);
    expect([CACHE.live, CACHE.partial]).toContain(res.headers.get('cache-control'));
  });
  it('a closed month: the year-long cache when complete', async () => {
    await sleep(1100);
    const res = await fetch(`${BASE}/api/weather?city=slc&month=1975-07`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.observations.length).toBeGreaterThan(24 * 28);
    expect(res.headers.get('cache-control')).toBe(body.meta.partial ? CACHE.partial : CACHE.closedMonth);
  });
  it('hostile input is a 400', async () => {
    await sleep(1100);
    const res = await fetch(`${BASE}/api/weather?city=__proto__&live=1`);
    expect(res.status).toBe(400);
  });
});

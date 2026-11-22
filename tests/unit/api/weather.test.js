// T5.2: the weather function (plan 01, section 6.3), called directly with a fetch that answers from the recorded
// fixtures. Cache headers, partial responses, the upstream-failure matrix, the User-Agent, and hostile input: no
// request value reaches an upstream URL unvalidated.
import { describe, it, expect } from 'vitest';
import cities from '../../../data/cities.json' with { type: 'json' };
import { createWeatherHandler, validateQuery, userAgent, CACHE, USER_AGENT } from '../../../api/_lib/handler.js';
import { normalizeOpenMeteo, parseIemCsv } from '../../../src/weather/normalize.js';
import { loadFixture, fixtureFetch } from '../../helpers/weatherFixtures.js';

const NOW = Date.UTC(2026, 10, 22, 15, 30);
const call = async (query, { fixtures, fail, env, timeoutMs = 200, method = 'GET' } = {}) => {
  const fetch = fixtureFetch(fixtures || [], { fail });
  const handle = createWeatherHandler({ cities, fetch, now: () => NOW, env, timeoutMs });
  const res = await handle(new Request(`https://skyline.test/api/weather${query}`, { method }));
  return { res, body: method === 'HEAD' ? null : await res.json(), calls: fetch.calls };
};
const ok = (body) => Object.fromEntries(body.meta.sources.map((s) => [s.id, s.ok]));

describe('live', () => {
  it('model hours from a day back to a week ahead, the last day of reports, aerosols; the live cache', async () => {
    const { res, body } = await call('?city=lv&live=1', { fixtures: loadFixture('lv', 'live') });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE.live);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=900, stale-if-error=86400');
    expect(body.success).toBe(true);
    expect(body.error).toBe(null);
    expect(body.meta.partial).toBe(false);
    expect(ok(body)).toEqual({ aviationweather: true, 'open-meteo': true, 'open-meteo-air': true });
    const d = body.data;
    expect(d.city).toBe('lv');
    expect(d.toMs - d.fromMs).toBe(8 * 86400000);
    expect(d.model.length).toBeGreaterThan(150);
    expect(d.model.every((h) => h.t >= d.fromMs - 3600000 && h.t <= d.toMs + 3600000)).toBe(true);
    expect(d.observations.length).toBeGreaterThan(15);
    expect(d.observations[0].station).toBe('KLAS');
    expect(d.aerosol.length).toBeGreaterThan(50);
    expect(body.meta.attribution).toEqual(expect.arrayContaining([expect.stringMatching(/Open-Meteo\.com/), expect.stringMatching(/Copernicus Atmosphere/),
      expect.stringMatching(/National Weather Service/)]));
  });

  it('aviationweather down: the NWS API answers, and the response is still complete', async () => {
    const { res, body } = await call('?city=slc&live=1', { fixtures: loadFixture('slc', 'live'), fail: { aviationweather: 503 } });
    expect(res.headers.get('cache-control')).toBe(CACHE.live);
    expect(body.meta.partial).toBe(false);
    expect(ok(body)).toMatchObject({ aviationweather: false, nws: true });
    expect(body.meta.sources.find((s) => s.id === 'aviationweather').reason).toBe('503');
    expect(body.data.observations.length).toBeGreaterThan(5);
  });

  it('upstream-failure matrix: each source fails alone, the rest is returned, partial and briefly cached', async () => {
    const cases = [
      [{ 'open-meteo': 500 }, 'model'], [{ 'open-meteo': 429 }, 'model'], [{ 'open-meteo-air': 'throw' }, 'aerosol'],
      [{ aviationweather: 500, nws: 'throw' }, 'observations'], [{ 'open-meteo': 'hang' }, 'model'],
    ];
    for (const [fail, lost] of cases) {
      const { res, body } = await call('?city=lv&live=1', { fixtures: loadFixture('lv', 'live'), fail });
      expect(res.status, JSON.stringify(fail)).toBe(200);
      expect(body.success).toBe(true);
      expect(body.meta.partial).toBe(true);
      expect(res.headers.get('cache-control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
      expect(body.data[lost === 'model' ? 'model' : lost].length).toBe(0);
      for (const kept of ['model', 'aerosol', 'observations'].filter((k) => k !== lost)) expect(body.data[kept].length, `${kept} kept`).toBeGreaterThan(0);
    }
  });

  it('a 429 from Open-Meteo says so, so the browser can ask Open-Meteo itself; a hang is a timeout', async () => {
    const { body } = await call('?city=lv&live=1', { fixtures: loadFixture('lv', 'live'), fail: { 'open-meteo': 429 } });
    expect(body.meta.sources.find((s) => s.id === 'open-meteo')).toMatchObject({ ok: false, reason: '429' });
    const hung = await call('?city=lv&live=1', { fixtures: loadFixture('lv', 'live'), fail: { 'open-meteo': 'hang' }, timeoutMs: 50 });
    expect(hung.body.meta.sources.find((s) => s.id === 'open-meteo')).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('every source down: 502, success false, not cached', async () => {
    const all = { 'open-meteo': 500, 'open-meteo-air': 500, aviationweather: 500, nws: 500 };
    const { res, body } = await call('?city=lv&live=1', { fixtures: loadFixture('lv', 'live'), fail: all });
    expect(res.status).toBe(502);
    expect(body).toMatchObject({ success: false, data: null, error: 'every source failed' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('month', () => {
  it('14 July 1975: the archive and the Iowa reports only, normalized as the fixtures; closed long ago, cached a year', async () => {
    const fx = loadFixture('lv', '1975-07-14');
    const { res, body, calls } = await call('?city=lv&month=1975-07', { fixtures: fx });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=31536000');
    expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual(['archive-api.open-meteo.com', 'mesonet.agron.iastate.edu']);
    expect(body.data.fromMs).toBe(Date.UTC(1975, 6, 1));
    expect(body.data.toMs).toBe(Date.UTC(1975, 7, 1));
    expect(body.data.model).toEqual(normalizeOpenMeteo(fx.responses['open-meteo'].body));
    expect(body.data.observations).toEqual(JSON.parse(JSON.stringify(parseIemCsv(fx.responses.iem.body))));
    expect(body.data.aerosol).toEqual([]);
    expect(body.meta.partial).toBe(false);
    expect(body.meta.attribution).toEqual(expect.arrayContaining([expect.stringMatching(/ERA5/), expect.stringMatching(/Iowa Environmental Mesonet/)]));
    const url = new URL(calls.find((c) => c.url.includes('archive-api')).url);
    expect([url.searchParams.get('start_date'), url.searchParams.get('end_date')]).toEqual(['1975-07-01', '1975-07-31']);
  });

  it('August 2023 adds the historical forecast and aerosols', async () => {
    const { body, calls } = await call('?city=lv&month=2023-08', { fixtures: loadFixture('lv', '2023-08-20') });
    expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual(['air-quality-api.open-meteo.com', 'archive-api.open-meteo.com',
      'historical-forecast-api.open-meteo.com', 'mesonet.agron.iastate.edu']);
    expect(body.data.model[0].visibilityM).toBe(22100);
    expect(body.data.aerosol.length).toBe(24);
  });

  it('cache by the month\'s age: closed over 90 days ago a year; this month and recent ones a day', async () => {
    const fx = loadFixture('lv', '2023-07-06');
    const header = async (m) => (await call(`?city=lv&month=${m}`, { fixtures: fx })).res.headers.get('cache-control');
    expect(await header('2026-07')).toBe('public, s-maxage=31536000'); // ended 1 August, 113 days before
    expect(await header('2026-09')).toBe('public, s-maxage=86400'); // ended 1 October, 52 days before
    expect(await header('2026-11')).toBe('public, s-maxage=86400');
    // a month that has not ended asks only up to today
    const { calls } = await call('?city=lv&month=2026-11', { fixtures: fx });
    expect(new URL(calls.find((c) => c.url.includes('archive-api')).url).searchParams.get('end_date')).toBe('2026-11-22');
  });

  it('a failed source in a closed month: partial and the short cache, never the year-long one (decision 5)', async () => {
    const { res, body } = await call('?city=lv&month=1975-07', { fixtures: loadFixture('lv', '1975-07-14'), fail: { iem: 'throw' } });
    expect(body.meta.partial).toBe(true);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
    expect(body.data.model.length).toBe(24);
  });

  it('January 1940 at Las Vegas: no reports is not a failure', async () => {
    const { res, body } = await call('?city=lv&month=1940-01', { fixtures: loadFixture('lv', '1940-01-15') });
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=31536000');
    expect(body.data.observations).toEqual([]);
    expect(body.meta.partial).toBe(false);
  });
});

describe('User-Agent', () => {
  it('the app name only, unless the deployment sets WEATHER_CONTACT', async () => {
    expect(USER_AGENT).toBe('interactive-skyline-weather/1.0');
    const plain = await call('?city=lv&month=1975-07', { fixtures: loadFixture('lv', '1975-07-14') });
    for (const c of plain.calls) expect(c.headers['user-agent']).toBe('interactive-skyline-weather/1.0');
    const withContact = await call('?city=lv&live=1', { fixtures: loadFixture('lv', 'live'), env: { WEATHER_CONTACT: 'ops@example.org', HOME: '/Users/someone', USER: 'someone' } });
    for (const c of withContact.calls) expect(c.headers['user-agent']).toBe('interactive-skyline-weather/1.0 (ops@example.org)');
  });
  it('a contact cannot inject header lines or bytes', () => {
    expect(userAgent({ WEATHER_CONTACT: 'a@b.c\r\nX-Evil: 1' })).toBe('interactive-skyline-weather/1.0 (a@b.cX-Evil: 1)');
    expect(userAgent({ WEATHER_CONTACT: 'x'.repeat(500) }).length).toBeLessThan(160);
    expect(userAgent({})).toBe(USER_AGENT);
  });
});

describe('validation: no request value reaches an upstream URL unvalidated', () => {
  const HOSTILE = [
    '', '?city=lv', '?live=1', '?city=lv&live=1&month=1975-07', '?city=nyc&live=1', '?city=LV&live=1', '?city=lv%00&live=1',
    '?city=__proto__&live=1', '?city=constructor&live=1', '?city=hasOwnProperty&live=1', '?city=toString&live=1',
    '?city=../../etc/passwd&live=1', '?city=lv%2F..%2F&live=1', '?city=lv&city=slc&live=1', '?city=lv&live=1&live=1',
    '?city=lv&live=0', '?city=lv&live=true', '?city=lv&live=1%0A', '?city=lv&month=1975-7', '?city=lv&month=1975-13',
    '?city=lv&month=1975-00', '?city=lv&month=1939-12', '?city=lv&month=2026-12', '?city=lv&month=2099-01',
    '?city=lv&month=1975-07%0AHost:evil', '?city=lv&month=1975-07-14', '?city=lv&month=+1975-07', '?city=lv&month=%201975-07',
    '?city=lv&month=1975-07&month=1976-07', `?city=${'l'.repeat(5000)}&live=1`, '?city=lv&month=19750-07',
    '?city=lv&month=1975-07%26station%3DKJFK', '?city=lv%26latitude%3D0&live=1', '?city=lv;rm&live=1', '?city[]=lv&live=1',
  ];
  for (const q of HOSTILE) {
    it(`400, nothing fetched: ${q.slice(0, 70) || '(empty)'}`, async () => {
      const { res, body, calls } = await call(q);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(calls).toEqual([]);
    });
  }

  it('POST and other methods: 405', async () => {
    const { res, calls } = await call('?city=lv&live=1', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('valid requests reach only the allow-listed hosts, with values from cities.json', async () => {
    const hosts = new Set(['api.open-meteo.com', 'archive-api.open-meteo.com', 'historical-forecast-api.open-meteo.com', 'air-quality-api.open-meteo.com',
      'aviationweather.gov', 'api.weather.gov', 'mesonet.agron.iastate.edu']);
    for (const [q, fx] of [['?city=lv&live=1&extra=../../x', loadFixture('lv', 'live')], ['?city=slc&month=2023-02&utm=%0A', loadFixture('slc', '2023-02-22')]]) {
      const { calls } = await call(q, { fixtures: fx, fail: { aviationweather: 500 } });
      const city = cities[q.includes('slc') ? 'slc' : 'lv'];
      expect(calls.length).toBeGreaterThan(2);
      for (const { url } of calls) {
        const u = new URL(url);
        expect(hosts.has(u.hostname), url).toBe(true);
        expect(u.protocol).toBe('https:');
        expect(url).not.toMatch(/extra|utm|\.\.|%0A/i);
        if (u.searchParams.has('latitude')) expect([u.searchParams.get('latitude'), u.searchParams.get('longitude')]).toEqual([city.origin.lat.toFixed(4), city.origin.lon.toFixed(4)]);
        if (u.hostname === 'mesonet.agron.iastate.edu') expect(u.searchParams.get('station')).toBe(city.iemStation);
        if (u.hostname === 'aviationweather.gov') expect(url).toBe(`https://aviationweather.gov/api/data/metar?ids=${city.icao}&format=json&hours=24`);
        if (u.hostname === 'api.weather.gov') expect(u.pathname).toBe(`/stations/${city.icao}/observations`);
      }
    }
  });

  it('validateQuery: the accepted forms', () => {
    const v = (q) => validateQuery(new URLSearchParams(q), cities, NOW);
    expect(v('city=lv&live=1')).toEqual({ cityId: 'lv', live: true });
    expect(v('city=slc&month=1940-01')).toEqual({ cityId: 'slc', month: '1940-01' });
    expect(v('city=slc&month=2026-11')).toEqual({ cityId: 'slc', month: '2026-11' });
  });
});

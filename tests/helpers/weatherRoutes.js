// Weather for e2e specs without the network (plan 01, phase 5): /api/weather answered by the real handler over the
// recorded fixtures (or a synthetic archive), and Open-Meteo answered from the fixtures for the browser's fallback.
import cities from '../../data/cities.json' with { type: 'json' };
import { createWeatherHandler } from '../../api/_lib/handler.js';
import { fixtureFetch, sourceOf } from './weatherFixtures.js';

const H = 3600000;

/** A synthetic archive: smooth hourly values for whatever days are asked, so any month can be crossed. */
export function syntheticUpstream() {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === 'mesonet.agron.iastate.edu') return new Response('station,valid,metar\n', { status: 200 });
    if (u.hostname !== 'archive-api.open-meteo.com') return new Response('{}', { status: 404 });
    const from = Date.parse(`${u.searchParams.get('start_date')}T00:00:00Z`), to = Date.parse(`${u.searchParams.get('end_date')}T23:00:00Z`);
    const time = [], temp = [];
    for (let t = from; t <= to; t += H) { time.push(t / 1000); temp.push(20 + 8 * Math.sin((t / H) * (2 * Math.PI / 24))); }
    const n = time.length, fill = (v) => Array(n).fill(v);
    return new Response(JSON.stringify({ hourly: { time, temperature_2m: temp, dew_point_2m: fill(0), relative_humidity_2m: fill(20), surface_pressure: fill(870),
      cloud_cover: fill(10), cloud_cover_low: fill(0), cloud_cover_mid: fill(0), cloud_cover_high: fill(10), wind_speed_10m: fill(3), wind_direction_10m: fill(200),
      wind_gusts_10m: fill(5), precipitation: fill(0), rain: fill(0), showers: fill(0), snowfall: fill(0), weather_code: fill(0), boundary_layer_height: fill(1500) } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/**
 * Route the page's weather requests. `api`: 'ok' (the handler over `upstream`), a status, 'abort' or 'hang'.
 * `direct`: what the browser's own Open-Meteo requests get: 'ok' (the fixtures), 'abort' or 'hang'.
 * Returns the list of requested URLs.
 */
export async function routeWeather(page, { fixtures = [], upstream = null, api = 'ok', direct = 'abort' } = {}) {
  const requested = [];
  const up = upstream || fixtureFetch(fixtures);
  const handle = createWeatherHandler({ cities, fetch: up, timeoutMs: 2000 });
  const local = fixtureFetch(fixtures);
  await page.route(/\/api\/weather/, async (route) => {
    requested.push(route.request().url());
    if (api === 'abort') return route.abort();
    if (api === 'hang') return; // never answered
    if (typeof api === 'number') return route.fulfill({ status: api, body: 'unavailable' });
    const res = await handle(new Request(route.request().url()));
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
  });
  await page.route(/open-meteo\.com|aviationweather\.gov|api\.weather\.gov|mesonet\.agron\.iastate\.edu/, async (route) => {
    requested.push(route.request().url());
    if (direct === 'abort') return route.abort();
    if (direct === 'hang') return;
    const url = route.request().url();
    const res = sourceOf(url) ? await local(url) : new Response('', { status: 404 });
    return route.fulfill({ status: res.status, headers: { ...Object.fromEntries(res.headers), 'access-control-allow-origin': '*' }, body: await res.text() });
  });
  return requested;
}

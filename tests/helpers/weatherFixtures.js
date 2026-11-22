// The recorded weather responses (tests/fixtures/weather/, written by scripts/fetch_weather_fixtures.py) and a fake
// fetch that answers from them. No test touches the network.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './staticServer.js';

export const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures/weather');

/** The newest recording of `<city>-<label>` (labels are a day 'YYYY-MM-DD' or 'live'). */
export function loadFixture(city, label) {
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.startsWith(`${city}-${label}.rec-`) && f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`no weather fixture for ${city} ${label}`);
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, files[files.length - 1]), 'utf8'));
}
export const fixtureLabels = (city) => [...new Set(fs.readdirSync(FIXTURE_DIR).filter((f) => f.startsWith(`${city}-`))
  .map((f) => f.slice(city.length + 1).split('.rec-')[0]))].sort();

/** Which recorded source answers a URL. */
export function sourceOf(url) {
  const u = new URL(url);
  if (u.hostname === 'archive-api.open-meteo.com' || u.hostname === 'api.open-meteo.com') return 'open-meteo';
  if (u.hostname === 'historical-forecast-api.open-meteo.com') return 'open-meteo-historical';
  if (u.hostname === 'air-quality-api.open-meteo.com') return 'open-meteo-air';
  if (u.hostname === 'aviationweather.gov') return 'aviationweather';
  if (u.hostname === 'api.weather.gov') return 'nws';
  if (u.hostname === 'mesonet.agron.iastate.edu') return 'iem';
  return null;
}

/**
 * A fetch that answers from one or more fixtures, by source. `fail` maps a source to a status (or 'throw', or
 * 'hang') for the failure matrix. Every requested URL is kept in `calls`.
 */
export function fixtureFetch(fixtures, { fail = {} } = {}) {
  const list = Array.isArray(fixtures) ? fixtures : [fixtures];
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers || {}).entries()) });
    const src = sourceOf(url);
    const how = fail[src];
    if (how === 'throw') throw new TypeError('fetch failed');
    if (how === 'hang') {
      return new Promise((_, reject) => {
        const sig = init.signal;
        if (sig) sig.addEventListener('abort', () => reject(sig.reason || new DOMException('aborted', 'AbortError')));
      });
    }
    if (typeof how === 'number') return new Response(JSON.stringify({ error: true, reason: 'test' }), { status: how, headers: { 'content-type': 'application/json' } });
    const r = list.map((f) => f.responses[src]).find(Boolean);
    if (!r) return new Response('not recorded', { status: 404 });
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: 200, headers: { 'content-type': r.contentType || 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

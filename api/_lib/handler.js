// The weather function's logic (plan 01, section 6.3; task T5.2), apart from the platform so the tests can call it
// with a mocked fetch and clock. api/weather.js wires it to Vercel; vite.config.js to `pnpm dev`.
//
//   GET /api/weather?city=lv&live=1        observations for the last day, model hours from a day back to a week
//                                          ahead, aerosols
//   GET /api/weather?city=lv&month=1975-07 one calendar month (UTC) of hourly model data and archived observations
//
// Validation first: `city` must be a key of data/cities.json, `month` a real month from 1940-01 to this one, `live`
// exactly "1", one of the two, each given once. Anything else is a 400 and nothing is fetched. Upstream URLs are
// built from fixed templates (src/weather/sources.js) out of the city's entry, never out of the request.
import { openMeteoLive, openMeteoMonth, aviationWeatherUrl, nwsUrl, iemMonthUrl, monthRange, monthOf, ATTRIBUTION,
  LIVE_BACK_MS, LIVE_AHEAD_MS } from '../../src/weather/sources.js';
import { normalizeOpenMeteo, normalizeAirQuality, mergeModel, parseAviationWeather, parseNws, parseIemCsv } from '../../src/weather/normalize.js';

export const CACHE = {
  live: 'public, max-age=60, s-maxage=300, stale-while-revalidate=900, stale-if-error=86400',
  closedMonth: 'public, s-maxage=31536000',
  openMonth: 'public, s-maxage=86400',
  partial: 'public, s-maxage=300, stale-while-revalidate=3600',
  none: 'no-store',
};
/** A month closed this long ago is final (reanalysis is revised for a few months). */
export const FINAL_AFTER_MS = 90 * 86400000;
export const USER_AGENT = 'interactive-skyline-weather/1.0';

/** The User-Agent for upstream requests: the app's name, and a contact only if the deployment sets WEATHER_CONTACT. */
export function userAgent(env = {}) {
  const contact = typeof env.WEATHER_CONTACT === 'string' ? env.WEATHER_CONTACT.replace(/[^\x20-\x7e]/g, '').replace(/[()]/g, '').trim().slice(0, 120) : '';
  return contact ? `${USER_AGENT} (${contact})` : USER_AGENT;
}

/**
 * Check the query. Returns { cityId, live: true } or { cityId, month } or { error }.
 * @param {URLSearchParams} params
 */
export function validateQuery(params, cities, nowMs) {
  const one = (k) => { const all = params.getAll(k); return all.length === 1 ? all[0] : all.length ? undefined : null; };
  const city = one('city'), live = one('live'), month = one('month');
  if (city === undefined || live === undefined || month === undefined) return { error: 'each parameter may be given once' };
  if (typeof city !== 'string' || !/^[a-z]{2,8}$/.test(city) || !Object.hasOwn(cities, city)) return { error: 'unknown city' };
  if ((live === null) === (month === null)) return { error: 'give either live=1 or month=YYYY-MM' };
  if (live !== null) return live === '1' ? { cityId: city, live: true } : { error: 'live must be 1' };
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || +m[2] < 1 || +m[2] > 12) return { error: 'month must be YYYY-MM' };
  if (month < '1940-01' || month > monthOf(nowMs)) return { error: 'month must lie between 1940-01 and this month' };
  return { cityId: city, month };
}

const json = (status, body, cache) => new Response(status === 204 ? null : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
});

/**
 * @param {{ cities: object, fetch?: typeof fetch, now?: () => number, env?: Record<string, string>, timeoutMs?: number }} o
 * @returns {(request: Request) => Promise<Response>}
 */
export function createWeatherHandler({ cities, fetch: doFetch = globalThis.fetch, now = Date.now, env = {}, timeoutMs = 4000 }) {
  const ua = userAgent(env);

  /** One upstream request with a timeout; resolves to { ok, body } or { ok: false, reason }. */
  async function get(url, kind) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    try {
      const res = await doFetch(url, { signal: ctl.signal, headers: { 'user-agent': ua, accept: kind === 'csv' ? 'text/csv' : 'application/json' } });
      if (!res.ok) return { ok: false, reason: String(res.status) };
      const body = kind === 'csv' ? await res.text() : await res.json();
      return { ok: true, body };
    } catch (err) {
      return { ok: false, reason: err && (err.name === 'TimeoutError' || ctl.signal.aborted) ? 'timeout' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function handle(request) {
    const t0 = now();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { success: false, data: null, error: 'method not allowed', meta: null }, CACHE.none);
    }
    const q = validateQuery(new URL(request.url).searchParams, cities, t0);
    if (q.error) return json(400, { success: false, data: null, error: q.error, meta: null }, CACHE.none);
    const city = cities[q.cityId];
    const sources = [];
    const note = (id, r) => { sources.push({ id, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), fetchedAtMs: now() }); return r; };
    let model = [], aerosol = [], observations = [], fromMs, toMs;
    const failed = { model: false, aerosol: false, observations: false };

    if (q.live) {
      fromMs = t0 - LIVE_BACK_MS;
      toMs = t0 + LIVE_AHEAD_MS;
      const om = openMeteoLive(city);
      const observe = async () => {
        const av = note('aviationweather', await get(aviationWeatherUrl(city), 'json'));
        if (av.ok) { const o = parseAviationWeather(av.body); if (o.length) return o; }
        const nws = note('nws', await get(nwsUrl(city), 'json'));
        return nws.ok ? parseNws(nws.body) : null;
      };
      const [fc, air, obs] = await Promise.all([get(om.forecast, 'json'), get(om.air, 'json'), observe()]);
      note('open-meteo', fc);
      note('open-meteo-air', air);
      if (fc.ok) model = normalizeOpenMeteo(fc.body).filter((h) => h.t >= fromMs - 3600000 && h.t <= toMs + 3600000); else failed.model = true;
      if (air.ok) aerosol = normalizeAirQuality(air.body); else failed.aerosol = true;
      if (obs) observations = obs.filter((o) => o.t >= fromMs); else failed.observations = true;
    } else {
      [fromMs, toMs] = monthRange(q.month);
      const om = openMeteoMonth(city, q.month, t0);
      const skip = Promise.resolve(null);
      const [arc, hf, air, iem] = await Promise.all([
        get(om.archive, 'json'),
        om.historicalForecast ? get(om.historicalForecast, 'json') : skip,
        om.air ? get(om.air, 'json') : skip,
        get(iemMonthUrl(city, q.month, t0), 'csv'), // the only request to the Iowa archive: it throttles to one a second
      ]);
      note('open-meteo', arc);
      if (hf) note('open-meteo-historical', hf);
      if (air) note('open-meteo-air', air);
      note('iem', iem);
      if (arc.ok) model = mergeModel(normalizeOpenMeteo(arc.body), hf && hf.ok ? normalizeOpenMeteo(hf.body) : null); else failed.model = true;
      if (hf && !hf.ok) failed.model = true;
      if (air) { if (air.ok) aerosol = normalizeAirQuality(air.body); else failed.aerosol = true; }
      if (iem.ok) observations = parseIemCsv(iem.body).filter((o) => o.t >= fromMs && o.t < toMs); else failed.observations = true;
    }

    const partial = Object.values(failed).some(Boolean);
    const attribution = [];
    if (model.length) attribution.push(ATTRIBUTION['open-meteo']);
    if (model.length && q.month) attribution.push(ATTRIBUTION.era5);
    if (aerosol.length) attribution.push(ATTRIBUTION['open-meteo-air']);
    const obsSource = sources.filter((s) => s.ok && ['aviationweather', 'nws', 'iem'].includes(s.id)).pop();
    if (observations.length && obsSource) attribution.push(ATTRIBUTION[obsSource.id]);
    const meta = { sources, attribution, generatedAtMs: now(), partial };
    if (sources.every((s) => !s.ok)) {
      return json(502, { success: false, data: null, error: 'every source failed', meta }, CACHE.none);
    }
    const cache = partial ? CACHE.partial : q.live ? CACHE.live : t0 - toMs > FINAL_AFTER_MS ? CACHE.closedMonth : CACHE.openMonth;
    return json(200, { success: true, data: { city: q.cityId, fromMs, toMs, model, observations, aerosol }, error: null, meta }, cache);
  };
}


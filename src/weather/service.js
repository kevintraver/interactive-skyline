// The weather in the browser (plan 01, sections 5.4 and 6.3; task T5.3): fetches what the clock needs, keeps it in
// memory, fuses it hour by hour (derive.js) and interpolates between hours, applies the source (live data, this date
// in history, a preset) and the overrides. Nothing is fetched until something asks for a sample.
//
// The fallback chain: the function (/api/weather) -> Open-Meteo directly from the browser (when the function is
// unreachable, or says Open-Meteo throttled it) -> the clear preset. Live data is refreshed every five minutes while
// the tab is visible and it is in use. History is fetched by month; the month ahead is fetched as the clock nears it,
// so scrubbing across midnight UTC, or into the next month, never waits.
import { fuse } from './derive.js';
import { lerpSample } from './interpolate.js';
import { presetSample, presetLabel } from './presets.js';
import { applyOverrides } from './overrides.js';
import { normalizeOpenMeteo, normalizeAirQuality, mergeModel } from './normalize.js';
import { openMeteoLive, openMeteoMonth, monthOf, monthRange, LIVE_BACK_MS, LIVE_AHEAD_MS, ATTRIBUTION } from './sources.js';

const H = 3600000, MIN = 60000;
/** The earliest instant with data: the archive begins in 1940. */
export const FIRST_MS = Date.UTC(1940, 0, 1);
/** Fetch the neighbouring month when the clock is this close to it. */
export const PREFETCH_MS = 36 * H;
/** Refresh live data this often while it is in use and the tab is visible. */
export const REFRESH_MS = 5 * MIN;
/** A failed request is tried again after this long, when something asks again. */
export const RETRY_MS = MIN;

/**
 * @param {{ cityId: string, city: object, fetch?: typeof fetch, now?: () => number, apiBase?: string,
 *   climatologyUrl?: string, timers?: { setInterval: Function, clearInterval: Function }, visible?: () => boolean,
 *   timeoutMs?: number }} o
 */
export function createWeatherService({ cityId, city, fetch: doFetch = (...a) => globalThis.fetch(...a), now = Date.now, apiBase = '/api/weather',
  climatologyUrl = `data/${cityId}/aerosol.json`, timers = globalThis, visible = () => typeof document === 'undefined' || document.visibilityState === 'visible',
  timeoutMs = 6000 }) {
  const groundM = city.stationElevationM ?? city.base;
  const chunks = new Map();
  let source = { kind: 'live' }, overrides = {}, climatology = null, climState = 'idle', lastUse = { t: null, at: 0 };
  const listeners = new Set();
  const emit = () => { for (const fn of [...listeners]) fn(); };

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { signal: ctl.signal });
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open-Meteo straight from the browser (CORS open): model hours and aerosols for a chunk. */
  async function direct(key) {
    const t = now();
    if (key === 'live') {
      const u = openMeteoLive(city);
      const [fc, air] = await Promise.all([getJson(u.forecast), getJson(u.air)]);
      return { model: fc.ok ? normalizeOpenMeteo(fc.body) : [], aerosol: air.ok ? normalizeAirQuality(air.body) : [], ok: fc.ok, airOk: air.ok };
    }
    const u = openMeteoMonth(city, key, t);
    const [arc, hf, air] = await Promise.all([getJson(u.archive), u.historicalForecast ? getJson(u.historicalForecast) : null, u.air ? getJson(u.air) : null]);
    return {
      model: arc.ok ? mergeModel(normalizeOpenMeteo(arc.body), hf && hf.ok ? normalizeOpenMeteo(hf.body) : null) : [],
      aerosol: air && air.ok ? normalizeAirQuality(air.body) : [], ok: arc.ok, airOk: !air || air.ok,
    };
  }

  async function load(key) {
    const old = chunks.get(key);
    const chunk = { key, status: 'loading', series: old && old.series, meta: old && old.meta, via: old && old.via, from: 0, to: 0,
      loadedAt: old ? old.loadedAt : 0, failedAt: 0, hourly: new Map() };
    if (old && old.status === 'ok') chunk.status = 'refreshing';
    chunks.set(key, chunk);
    const t = now();
    const [from, to] = key === 'live' ? [t - LIVE_BACK_MS, t + LIVE_AHEAD_MS] : monthRange(key);
    const res = await getJson(`${apiBase}?city=${encodeURIComponent(cityId)}&${key === 'live' ? 'live=1' : `month=${key}`}`);
    let series = null, meta = null, via = 'function';
    if (res.ok && res.body && res.body.success && res.body.data) {
      series = res.body.data;
      meta = res.body.meta;
      const om = (meta.sources || []).find((s) => s.id === 'open-meteo');
      // throttled at the function's shared address (section 6.3): ask Open-Meteo from this browser instead
      if ((om && !om.ok) || !series.model.length) {
        const d = await direct(key);
        if (d.ok) {
          series = { ...series, model: d.model, aerosol: series.aerosol.length ? series.aerosol : d.aerosol };
          via = 'function+open-meteo';
        }
      }
    } else {
      const d = await direct(key);
      if (d.ok) {
        series = { city: cityId, fromMs: from, toMs: to, model: d.model, observations: [], aerosol: d.aerosol };
        meta = { sources: [{ id: 'open-meteo', ok: true }, { id: 'open-meteo-air', ok: d.airOk }], attribution: [ATTRIBUTION['open-meteo'],
          ...(key !== 'live' ? [ATTRIBUTION.era5] : []), ...(d.aerosol.length ? [ATTRIBUTION['open-meteo-air']] : [])], partial: true };
        via = 'open-meteo';
      }
    }
    if (chunks.get(key) !== chunk) return; // replaced meanwhile
    if (series && series.model.length) {
      Object.assign(chunk, { status: 'ok', series, meta, via, from: series.fromMs ?? from, to: series.toMs ?? to, loadedAt: now(), hourly: new Map() });
    } else if (old && old.status === 'ok') {
      Object.assign(chunk, old, { failedAt: now(), refreshFailed: true }); // keep what we had
    } else {
      Object.assign(chunk, { status: 'failed', failedAt: now() });
    }
    emit();
  }

  /** Which chunks hold time t: the live window near now, else the month (and the next or previous one near its edge). */
  function keysFor(t) {
    const n = now();
    if (t < FIRST_MS || t > n + LIVE_AHEAD_MS) return [];
    if (t >= n - LIVE_BACK_MS) return ['live'];
    const keys = [monthOf(t)];
    const [from, to] = monthRange(keys[0]);
    if (to - t < PREFETCH_MS && to < n) keys.push(monthOf(to));
    if (t - from < PREFETCH_MS && from > FIRST_MS) keys.push(monthOf(from - 1));
    return keys;
  }

  /** Start loading whatever t needs. */
  function need(t) {
    for (const key of keysFor(t)) {
      const c = chunks.get(key);
      if (!c || (c.status === 'failed' && now() - c.failedAt > RETRY_MS)) load(key);
    }
  }

  function loadClimatology() {
    if (climState !== 'idle') return;
    climState = 'loading';
    getJson(climatologyUrl).then((r) => {
      climState = r.ok ? 'ok' : 'failed';
      if (r.ok) {
        climatology = r.body;
        for (const c of chunks.values()) c.hourly = new Map();
        emit();
      }
    });
  }

  /** The chunk whose data covers t, preferring the live window. */
  function chunkAt(t) {
    const live = chunks.get('live');
    if (live && live.series && live.status !== 'failed' && t >= live.series.model[0].t - H && t <= live.series.model[live.series.model.length - 1].t + H) return live;
    const m = chunks.get(monthOf(t));
    return m && m.series && m.status !== 'failed' ? m : null;
  }

  /** The fused sample at the full hour h, cached per chunk. */
  function hourly(h) {
    const c = chunkAt(h);
    if (!c) return null;
    if (!c.hourly.has(h)) {
      const a = c.series.aerosol;
      if (!a.length || h < a[0].t - H || h > a[a.length - 1].t + H) loadClimatology();
      c.hourly.set(h, fuse(c.series, h, { groundM, climatology }));
    }
    return c.hourly.get(h);
  }

  /** The data at time t (live or archive), fused and interpolated between hours, before overrides; null if none yet. */
  function dataAt(t) {
    need(t);
    const h0 = Math.floor(t / H) * H;
    const a = hourly(h0), b = hourly(h0 + H);
    if (!a) return b;
    if (!b) return a;
    const s = lerpSample(a, b, (t - h0) / H);
    return s === a || s === b ? { ...s, t } : s;
  }

  /** "This date in history": the same day and time of day in the chosen year (29 February becomes the 28th). */
  function historyTime(t, year) {
    const d = new Date(t);
    let day = d.getUTCDate();
    if (d.getUTCMonth() === 1 && day === 29 && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1) day = 28;
    return Date.UTC(year, d.getUTCMonth(), day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }

  /** The time whose data the current source shows at clock time t (null for a preset). */
  const dataTime = (t) => (source.kind === 'history' ? historyTime(t, source.year) : source.kind === 'live' ? t : null);

  const service = {
    /** The sample at clock time t: the source's, overrides applied. Never null: the clear preset until data arrives. */
    sample(t) {
      lastUse = { t, at: now() };
      let base;
      if (source.kind === 'preset') base = presetSample(source.id, t, groundM);
      else {
        const dt = dataTime(t);
        const d = dataAt(dt);
        base = d ? { ...d, t } : presetSample('clear', t, groundM);
      }
      return applyOverrides(base, overrides, { groundM });
    },
    /** The data alone (no source, no overrides) at time t, or null. */
    data: (t) => dataAt(t),
    need: (t) => need(dataTime(t) ?? t),
    get source() { return { ...source }; },
    setSource(s) {
      if (s.kind === 'preset') source = { kind: 'preset', id: s.id };
      else if (s.kind === 'history') source = { kind: 'history', year: Math.max(1940, Math.min(new Date(now()).getUTCFullYear() - 1, Math.round(s.year ?? new Date(now()).getUTCFullYear() - 1))) };
      else source = { kind: 'live' };
      emit();
    },
    get overrides() { return { ...overrides }; },
    setOverride(key, value) {
      const next = { ...overrides };
      if (value === null || value === undefined) delete next[key]; else next[key] = value;
      overrides = next;
      emit();
    },
    clearOverrides() { if (Object.keys(overrides).length) { overrides = {}; emit(); } },
    /** Back to real: live data, no overrides. */
    backToReal() { source = { kind: 'live' }; overrides = {}; emit(); },
    get groundM() { return groundM; },
    presetLabel,

    /** What the chip and the source line say about time t (section 4.2). */
    status(t) {
      const out = { kind: source.kind, dataKind: null, loading: false, unavailable: false, stale: false, partial: false, via: null,
        observedAtMs: null, station: null, sources: [], attribution: [], overridden: Object.keys(overrides), aerosol: null, preset: source.kind === 'preset' ? source.id : null,
        year: source.kind === 'history' ? source.year : null, dataTimeMs: null };
      if (source.kind === 'preset') return out;
      const dt = dataTime(t);
      out.dataTimeMs = dt;
      out.dataKind = dt >= now() - LIVE_BACK_MS ? 'live' : 'archive';
      const keys = keysFor(dt);
      const c = chunkAt(dt);
      const pending = keys.map((k) => chunks.get(k)).filter(Boolean);
      if (!c) {
        out.loading = !keys.length ? false : pending.length < keys.length || pending.some((p) => p.status === 'loading');
        out.unavailable = !out.loading;
        return out;
      }
      out.via = c.via;
      out.partial = !!(c.meta && c.meta.partial);
      out.stale = c.key === 'live' && (now() - c.loadedAt > 3 * REFRESH_MS || !!c.refreshFailed);
      out.sources = (c.meta && c.meta.sources) || [];
      out.attribution = [...((c.meta && c.meta.attribution) || [])];
      const obs = c.series.observations.filter((o) => o.t <= dt + 40 * MIN && o.t >= dt - 3 * H);
      if (obs.length) { const o = obs[obs.length - 1]; out.observedAtMs = o.t; out.station = o.station || city.icao; }
      const s = hourly(Math.floor(dt / H) * H);
      out.aerosol = s ? s.source.aerosol : null;
      if (out.aerosol === 'climatology' && !out.attribution.includes(ATTRIBUTION['open-meteo-air'])) out.attribution.push(ATTRIBUTION['open-meteo-air']);
      return out;
    },
    on(type, fn) { if (type !== 'change') return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    /** For tests: the chunks and their states. */
    get chunks() { return [...chunks.values()].map((c) => ({ key: c.key, status: c.status, via: c.via, loadedAt: c.loadedAt })); },
    dispose() { timers.clearInterval(timer); listeners.clear(); },
  };

  // refresh live data every five minutes while it is in use and the tab is visible
  const timer = timers.setInterval(() => {
    const live = chunks.get('live');
    if (!live || live.status !== 'ok' || !visible()) return;
    const inUse = lastUse.t !== null && now() - lastUse.at < 2 * REFRESH_MS && lastUse.t >= now() - LIVE_BACK_MS;
    if (inUse && now() - live.loadedAt >= REFRESH_MS) load('live');
  }, MIN);

  return service;
}



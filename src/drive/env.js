// The drive's environment port (plan 02, section 11.1): the adapter of plan 01's section 11.10 (third stretch, decisions
// 4, 5 and 9). The clock is app.clock (one clock for the app), the ephemeris is app.env.ephemeris, the ambient light is
// env.state.sky.horizontalLux, and `plan01`, `nodes` and `state` reach plan 01's environment itself; the members keep
// the drive's names and shapes. The weather is plan 01's (decision 9, weatherOn below: env.state's sample, with rain and
// wetness still derived in the drive until plan 01's phase 7). Pure maths but for the adapter itself: no DOM, no three.
import { zonedToUtc } from '../core/time.js';

export const RATE_MIN = 0.25;
export const RATE_MAX = 16;

function clampRate(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, v));
}

/** The calendar date (y, m 1-12, d) of an instant in a time zone. */
export function localDate(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(ms));
  const get = (type) => +parts.find((p) => p.type === type).value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

// ---------------------------------------------------------------- the clear sky's illuminance by the sun's elevation
// Plan 01's env.state gives the horizontal illuminance for the moment it was built (frame step 40). The parts update at
// step 20, after a seek before plan 01's environment has caught up, and ask for the illuminance at the sun's elevation
// of the frame: for an elevation other than env.state's, the adapter (ambientLux below) answers from this clear-sky
// table, which the look's dusk curve (look.js) also reads.
// Horizontal illuminance from the sun and twilight sky under a clear sky, by the sun's elevation: Paul Schlyter,
// "Radiometry and photometry in astronomy", section 10, table "Solar illumination on horizontal surface at various
// solar altitudes", http://stjarnhimlen.se/comp/radfaq.html (read 2026-11-22). Pairs of [elevation deg, log10 lux],
// exactly as tabulated.
const AMBIENT_TABLE = [
  [-18, -3.19], [-17.5, -3.09], [-17, -3.0], [-16.5, -2.92], [-16, -2.84], [-15.5, -2.77], [-15, -2.69], [-14.5, -2.62],
  [-14, -2.54], [-13.5, -2.44], [-13, -2.34], [-12.5, -2.22], [-12, -2.09], [-11.5, -1.94], [-11, -1.77], [-10.5, -1.58],
  [-10, -1.38], [-9.5, -1.16], [-9, -0.93], [-8.5, -0.7], [-8, -0.46], [-7.5, -0.21], [-7, 0.04], [-6.5, 0.29],
  [-6, 0.53], [-5.5, 0.78], [-5, 1.02], [-4.5, 1.25], [-4, 1.48], [-3.5, 1.69], [-3, 1.9], [-2.5, 2.09], [-2, 2.28],
  [-1.5, 2.45], [-1, 2.61], [-0.5, 2.75], [0, 2.88], [0.5, 3.0], [1, 3.1], [1.5, 3.2], [2, 3.28], [2.5, 3.36], [3, 3.43],
  [3.5, 3.49], [4, 3.55], [4.5, 3.6], [5, 3.66], [5.5, 3.7], [6, 3.75], [6.5, 3.79], [7, 3.84], [7.5, 3.87], [8, 3.91],
  [8.5, 3.95], [9, 3.98], [9.5, 4.02], [10, 4.05], [11, 4.1], [12, 4.16], [13, 4.2], [14, 4.25], [15, 4.28], [20, 4.44],
  [25, 4.56], [30, 4.67], [35, 4.75], [40, 4.83], [45, 4.89], [50, 4.94], [60, 5.01], [70, 5.06], [80, 5.09], [90, 5.11],
];
/** Moonless clear night sky, starlight and airglow, lux (same source, section 10, first table). Added throughout. */
export const NIGHT_SKY_LUX = 2e-3;

/**
 * Horizontal illuminance (lux) from sun, sky and a moonless night sky, for a sun elevation in degrees (refracted,
 * as ephemeris.sun reports it). Log-linear in the table; below -18 deg the sun's share keeps the table's last
 * slope and vanishes against the night sky. Monotonic in elevation, which switching.js relies on.
 * A shader would only need this as a uniform, computed on the CPU.
 */
export function ambientLux(sunElevationDeg) {
  const el = Math.min(90, Number(sunElevationDeg));
  if (!Number.isFinite(el)) return NIGHT_SKY_LUX;
  const T = AMBIENT_TABLE;
  let lg;
  if (el <= T[0][0]) lg = T[0][1] + ((el - T[0][0]) * (T[1][1] - T[0][1])) / (T[1][0] - T[0][0]);
  else {
    let i = 0;
    while (el > T[i + 1][0]) i++;
    lg = T[i][1] + ((el - T[i][0]) * (T[i + 1][1] - T[i][1])) / (T[i + 1][0] - T[i][0]);
  }
  return 10 ** lg + NIGHT_SKY_LUX;
}

// ---------------------------------------------------------------- the rain's rules
// The drive's rain shorthand (four presets the visitor picks, or a rate) and the rules everything follows from the rain
// rate by (weatherFor): a pure function of the rate, with no history. Plan 01's weather carries the rate; the rules
// derive what plan 01 does not have until its phase 7 (wetness, puddles, the sky's dimming; see derivedRain below).
//
// The rules (R in mm/h):
//  wetness      1 - exp(-R / 2). ASSUMED: a road's texture and drainage take about the first 1-2 mm/h before a
//               continuous film forms, so light rain leaves it damp with the wheel paths wet (0.39) and 4 mm/h and up
//               cover it (0.86, 1.00 at 12).
//  visibilityM  16 km x R^-0.6 (16 km at 1 mm/h, 7 km at 4, 3.6 km at 12), 80 km dry as before. ASSUMED: a fit to
//               the usual ranges reported for rain (around 10 km and more in light rain, a few km in heavy rain);
//               the drive uses it as the lamps' e-folding length (exp(-d / visibility), plan 02, 11.1).
//  skyDim       daylight as a share of the clear sky's: 1 dry, 0.45 x R^-0.37 in rain (0.45 at 1 mm/h, 0.27 at 4,
//               0.18 at 12). ASSUMED, within the range of CIE overcast against clear skies (an overcast sky gives
//               roughly a tenth to a half of clear-sky daylight); rain needs cloud, so any rain starts at 0.45.
//  overcast     0 dry, 1 in rain: how far the sky goes grey.
//  puddles      clamp((R - 4) / 8, 0, 1): standing water in the wheel paths only in heavy rain. ASSUMED.
//  wind         from 200 degrees (south-south-west, the usual quarter of Las Vegas's winter storms: ASSUMED) at 2, 4
//               and 7 m/s for the three rain presets; still when clear.
//  tempC        none here: the temperature is plan 01's weather's (weatherStateFrom).

/** The presets, in the order the time popover shows them. */
export const RAIN_PRESETS = Object.freeze([
  Object.freeze({ id: 'clear', label: 'Clear', mmPerHour: 0, windMps: 0 }),
  Object.freeze({ id: 'light', label: 'Light rain', mmPerHour: 1, windMps: 2 }),
  Object.freeze({ id: 'moderate', label: 'Rain', mmPerHour: 4, windMps: 4 }),
  Object.freeze({ id: 'heavy', label: 'Heavy rain', mmPerHour: 12, windMps: 7 }),
]);
/** Visibility when dry (m): what the lamps were given before the weather existed. */
export const DRY_VISIBILITY_M = 80000;
const WIND_FROM_DEG = 200;
const MAX_RATE = 100;

/** The weather state for a rain rate (mm/h), by the rules above. Pure. windMps defaults to the nearest preset's. */
export function weatherFor(mmPerHour, { windMps, windFromDeg = WIND_FROM_DEG, preset = null } = {}) {
  const R = Math.min(MAX_RATE, Math.max(0, Number(mmPerHour) || 0));
  const raining = R > 0;
  let wind = windMps;
  if (!Number.isFinite(wind)) {
    let best = RAIN_PRESETS[0];
    for (const p of RAIN_PRESETS) if (Math.abs(p.mmPerHour - R) < Math.abs(best.mmPerHour - R)) best = p;
    wind = raining ? Math.max(best.windMps, 1) : 0;
  }
  return Object.freeze({
    preset,
    precipMmPerHour: R,
    precipKind: raining ? 'rain' : 'none',
    wetness: raining ? 1 - Math.exp(-R / 2) : 0,
    puddles: Math.min(1, Math.max(0, (R - 4) / 8)),
    visibilityM: raining ? 16000 * R ** -0.6 : DRY_VISIBILITY_M,
    skyDim: raining ? Math.min(1, 0.45 * R ** -0.37) : 1,
    overcast: raining ? 1 : 0,
    windMps: wind,
    windSpeed: wind,
    windFromDeg: raining ? windFromDeg : 0,
    dust: 0,
    tempC: null,
    hasTemperature: false,
  });
}

// ---------------------------------------------------------------- the weather on plan 01 (third stretch, decision 9)
// env.weather (state(), setPreset, setRain, on('change'), presets, hasTemperature) over plan 01's weather: env.state.weather (the sample of plan 01 section 6.4, from live data, a date
// in history or a preset, with the #sky overrides applied), env.state.visibilityM and the sample's wind. Everything
// is read from env.state, which plan 01 rebuilds from the clock at frame step 40, so it is a pure function of
// simulation time. The drive's shorthand (?rain=, the drive's popover, the test hooks setPreset and setRain) is
// written into plan 01's weather as its Rain preset with two overrides, so the #sky rows show it and can change it.

/** The rain shorthand's wind: from 200 degrees, at the presets' speeds (see the rules above). */
export const SHORTHAND_WIND_FROM_DEG = WIND_FROM_DEG;

/**
 * The drive's rain shorthand as plan 01 weather settings: null for clear (the drive imposes nothing), else plan 01's
 * Rain preset (overcast low cloud, 12 km visibility) with the rate and the presets' wind as overrides.
 * @param {string | number} choice  a RAIN_PRESETS id or a rate in mm/h
 * @returns {{ source: { kind: 'preset', id: string }, overrides: Record<string, number> } | null}
 */
export function shorthandWeather(choice) {
  let R, wind;
  if (typeof choice === 'number') {
    if (!Number.isFinite(choice)) return null;
    R = Math.min(MAX_RATE, Math.max(0, choice));
    let best = RAIN_PRESETS[0];
    for (const p of RAIN_PRESETS) if (Math.abs(p.mmPerHour - R) < Math.abs(best.mmPerHour - R)) best = p;
    wind = Math.max(best.windMps, 1);
  } else {
    const p = RAIN_PRESETS.find((x) => x.id === choice);
    if (!p) return null;
    R = p.mmPerHour; wind = p.windMps;
  }
  if (!(R > 0)) return null;
  return { source: { kind: 'preset', id: 'rain' }, overrides: { rain: R, windSpeed: wind, windDir: SHORTHAND_WIND_FROM_DEG } };
}

// ==== PLAN 01 PHASE 7 STAND-IN: BEGIN =================================================================================
// Plan 01's env.state.rain, env.state.wetness and env.at().rainRateMmH / .wetness are stubs (dry) until its phase 7
// (plan 01 section 11.1). Until then the drive derives them here, and only here, from the weather sample itself: the
// rain rate is the sample's precipitation when it reaches the ground, and wetness, puddles and the sky's dimming
// follow from it by the rules above (weatherFor). When phase 7 lands: delete this block, read
// env.state.rain.rateMmH and env.state.wetness.{film,puddles} (or env.at(position)) in weatherStateFrom, and take the
// sky's dimming from plan 01's light (env.state.sky.horizontalLux) instead of skyDim.
const RAINING = new Set(['rain', 'drizzle', 'hail']);
/** The rate at the ground (mm/h) of a plan 01 weather sample: virga, snow and none give 0 (the drive has no snow). */
export function rainRateOfSample(sample) {
  const p = sample?.precip;
  if (!p || !RAINING.has(p.kind)) return 0;
  return Math.min(MAX_RATE, Math.max(0, Number(p.rateMmH) || 0));
}
function derivedRain(sample) {
  const R = Math.round(rainRateOfSample(sample) * 100) / 100;
  const w = weatherFor(R, { windMps: 0 });
  return { R, wetness: w.wetness, puddles: w.puddles, skyDim: w.skyDim, overcast: w.overcast };
}
// ==== PLAN 01 PHASE 7 STAND-IN: END ===================================================================================

/**
 * The drive's weather state (weatherFor's shape) from plan 01's env.state. Values are rounded (rate
 * 0.01 mm/h, wind 0.1 m/s and 1 degree, visibility 10 m, temperature 0.1 degree) so that live data, interpolated every
 * frame, changes the state now and then rather than on every frame. Pure.
 * @param {object | null} envState  plan 01's env.state (null or without weather: clear and calm)
 * @param {{ preset?: string | null, hasTemperature?: boolean }} [o]
 */
export function weatherStateFrom(envState, { preset = null, hasTemperature = false } = {}) {
  const sample = envState?.weather || null;
  const rain = derivedRain(sample);
  const wind = sample?.wind || { speedMs: 0, dirDeg: 0 };
  const vis = Number.isFinite(envState?.visibilityM) ? envState.visibilityM : sample?.visibilityM;
  const tempC = Number.isFinite(sample?.tempC) ? Math.round(sample.tempC * 10) / 10 : null;
  return Object.freeze({
    preset,
    precipMmPerHour: rain.R,
    precipKind: rain.R > 0 ? 'rain' : 'none',
    wetness: rain.wetness,
    puddles: rain.puddles,
    visibilityM: Number.isFinite(vis) ? Math.max(10, Math.round(vis / 10) * 10) : DRY_VISIBILITY_M,
    skyDim: rain.skyDim,
    overcast: rain.overcast,
    windMps: Math.round((wind.speedMs || 0) * 10) / 10,
    windSpeed: Math.round((wind.speedMs || 0) * 10) / 10,
    windFromDeg: Math.round(wind.dirDeg || 0) % 360,
    dust: 0,
    tempC: hasTemperature ? tempC : null,
    hasTemperature: hasTemperature && tempC !== null,
  });
}

const sameSettings = (a, b) => !!a && !!b && JSON.stringify(a.source) === JSON.stringify(b.source)
  && JSON.stringify(Object.entries(a.overrides).sort()) === JSON.stringify(Object.entries(b.overrides).sort());

/**
 * env.weather (see above). `app` is the drive's plan 01 context: env (plan 01's environment)
 * and weather() (a promise of plan 01's weather service, src/weather/service.js, loaded on demand; absent in tests).
 *   state()                 the drive's weather state now (weatherStateFrom of env.state), cached per env.state
 *   setPreset(id), setRain(mm)  the shorthand, into plan 01's weather (asynchronous: whenApplied() resolves after)
 *   release()               put back plan 01's weather as it was before the first shorthand, unless the visitor has
 *                           changed it since (the weather part calls it when it goes)
 *   on('change', fn)        fn(state) when the state's values change
 */
export function weatherOn(app) {
  const env = app.env;
  const listeners = new Set();
  let service = null, loaded = false, chosen = null; // chosen: the shorthand in force (id or rate), null for none
  let saved = null, imposed = null; // plan 01's settings before the first shorthand, and what the shorthand set
  let seen = undefined, current = weatherStateFrom(null);
  let queue = Promise.resolve();
  const request = typeof app.weather === 'function' ? app.weather : null;
  const ready = request ? Promise.resolve().then(request).then((s) => { service = s || null; loaded = !!s; refresh(); return service; }).catch(() => null) : Promise.resolve(null);

  const settingsNow = () => (service ? { source: service.source, overrides: service.overrides } : null);
  const presetNow = () => (chosen !== null && sameSettings(settingsNow(), imposed) ? (typeof chosen === 'number' ? null : chosen) : null);

  function refresh() {
    const s = env?.state ?? null;
    seen = s;
    const next = weatherStateFrom(s, { preset: presetNow(), hasTemperature: loaded });
    const same = Object.keys(next).every((k) => next[k] === current[k]);
    if (same) return;
    current = next;
    for (const fn of [...listeners]) fn(current);
  }
  const offWeather = env?.on ? env.on('weather', refresh) : () => {};

  async function apply(choice) {
    const svc = await ready;
    if (!svc) return;
    const want = shorthandWeather(choice);
    if (!want) { restore(); return; }
    if (!saved || !sameSettings(settingsNow(), imposed)) saved = settingsNow();
    svc.setSource(want.source);
    svc.clearOverrides();
    for (const [k, v] of Object.entries(want.overrides)) svc.setOverride(k, v);
    imposed = settingsNow();
    chosen = choice;
    refresh();
  }
  function restore() {
    if (service && saved && sameSettings(settingsNow(), imposed)) {
      service.setSource(saved.source);
      service.clearOverrides();
      for (const [k, v] of Object.entries(saved.overrides)) service.setOverride(k, v);
    }
    saved = null; imposed = null; chosen = null;
    refresh();
  }
  const enqueue = (fn) => (queue = queue.then(fn).catch(() => {}));

  const weather = {
    /** Plan 01's weather is behind this port. */
    plan01: true,
    /** A real temperature once plan 01's weather has loaded (the cabin shows it then). */
    get hasTemperature() { return loaded; },
    presets: RAIN_PRESETS,
    state() {
      if ((env?.state ?? null) !== seen) refresh();
      return current;
    },
    setPreset(id) { if (RAIN_PRESETS.some((p) => p.id === id)) enqueue(() => apply(id)); return weather; },
    setRain(mmPerHour) {
      const R = Number(mmPerHour);
      if (!Number.isFinite(R)) return weather;
      const p = RAIN_PRESETS.find((x) => x.mmPerHour === R);
      enqueue(() => apply(p ? p.id : R));
      return weather;
    },
    /** Resolves once every shorthand asked for so far is in plan 01's weather (and env.state follows it). */
    whenApplied: () => Promise.all([ready, queue]).then(() => { refresh(); return current; }),
    release() { enqueue(restore); return queue; },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() { offWeather(); listeners.clear(); },
  };
  return weather;
}

/**
 * The drive's clock on plan 01's SimClock (section 11.2), with the drive clock's interface: now(), playing, rate, seek,
 * play, pause, setRate (clamped to the drive's RATE_MIN..RATE_MAX), on(tick | seek | rate | play | pause). Time moves
 * only in the app's frame loop (step 0): advance() here does nothing, so the drive never moves the app's clock twice.
 * @param {import('../contracts.d.ts').SimClock} clock
 */
export function clockOn(clock) {
  return {
    now: () => clock.timeMs,
    get playing() { return clock.playing; },
    get rate() { return clock.rate; },
    seek(ms) { if (Number.isFinite(ms)) clock.set(ms); },
    play() { clock.play(); },
    pause() { clock.pause(); },
    setRate(value) { const next = clampRate(value); if (next !== clock.rate) clock.setRate(next); },
    /** The app's frame loop advances the clock (plan 01, frame step 0). */
    advance() {},
    on(type, fn) {
      if (type === 'tick' || type === 'seek' || type === 'rate') return clock.on(type, (e) => fn({ simMs: e.simMs, dtSimMs: e.dtSimMs }));
      if (type === 'play' || type === 'pause') {
        let was = clock.playing;
        return clock.on('state', (e) => {
          const now = clock.playing;
          if (now !== was && (now ? type === 'play' : type === 'pause')) fn({ simMs: e.simMs, dtSimMs: 0 });
          was = now;
        });
      }
      throw new Error(`clock: unknown event "${type}"`);
    },
  };
}

/**
 * The drive's ephemeris on plan 01's (section 11.4): sun(ms) as { azimuth, elevation } in degrees (apparent),
 * timeOfSunElevation(el, dayMs, evening) when the apparent elevation is `el` on the local calendar day of dayMs (NaN when
 * the sun does not reach it that day), solarNoon(dayMs).
 * @param {{ at(ms: number): { sun: { azDeg: number, altDeg: number } }, timeOfSunAltitude: Function, events?: Function }} eph
 * @param {string} zone the city's IANA zone
 */
export function ephemerisOn(eph, zone) {
  const dayStart = (ms) => { const d = localDate(ms, zone); return zonedToUtc({ year: d.y, month: d.m, day: d.d }, zone); };
  return {
    sun(simMs) { const s = eph.at(simMs).sun; return { azimuth: s.azDeg, elevation: s.altDeg }; },
    timeOfSunElevation(elevationDeg, dayMs, evening = true) {
      // plan 01's search is on the geometric altitude, sun() reports the apparent one: search again for the geometric
      // altitude that is the asked apparent one less the refraction there, until the apparent one is reached (the
      // refraction changes with the altitude; a few rounds)
      const search = (alt) => {
        try { const t = eph.timeOfSunAltitude(alt, dayStart(dayMs), evening ? 'setting' : 'rising'); return Number.isFinite(t) ? t : NaN; } catch { return NaN; } // an altitude it refuses
      };
      let t = search(elevationDeg), alt = elevationDeg;
      for (let k = 0; k < 6 && Number.isFinite(t); k++) {
        const s = eph.at(t).sun;
        const miss = s.altDeg - elevationDeg;
        if (!Number.isFinite(miss) || Math.abs(miss) < 1e-5) break;
        alt -= miss;
        const next = search(alt);
        if (!Number.isFinite(next)) break;
        t = next;
      }
      return t;
    },
    solarNoon(dayMs) {
      const e = eph.events ? eph.events(dayStart(dayMs)) : null;
      return e && Number.isFinite(e.noon) ? e.noon : NaN;
    },
  };
}

/**
 * The drive's environment port over plan 01's (section 11.10).
 * @param {{ city: object, app: object }} opts  city is an entry of data/cities.json (origin, tz); app is plan 01's
 *   contract (app.clock, app.env, app.quality, app.weather)
 */
export function createEnv({ city, app } = {}) {
  if (!city?.origin) throw new Error('env: city with an origin is required');
  if (!app?.env || !app?.clock) throw new Error("env: plan 01's clock and environment are required");
  const env = app.env;
  const clock = clockOn(app.clock);
  const ephemeris = ephemerisOn(env.ephemeris, city.tz || app.clock.zone || 'UTC');
  const weather = weatherOn(app);
  const q = app.quality;
  return {
    city,
    clock,
    ephemeris,
    /** Plan 01's environment (section 11.4): state, nodes, lights, at(), freeze() ... */
    plan01: env,
    /** env.nodes (section 11.5): exposure, emissive(), pointSource(), switchOn ... */
    nodes: env.nodes,
    get state() { return env.state; },
    quality: {
      get preset() { return q?.level ?? 'high'; },
      get caps() { return q?.caps ?? null; },
      get renderScale() { return q?.renderScale ?? 1; },
      onChange: (fn) => (q?.on ? q.on('change', fn) : () => {}),
    },
    lighting: {
      /**
       * Horizontal illuminance (lux): plan 01's env.state.sky.horizontalLux for the sun now (with no argument, or the
       * current sun's elevation), else the clear-sky table for that elevation (see ambientLux); x the rain's sky dimming.
       */
      ambientLux(sunElevationDeg) {
        const s = env.state, dim = weather.state().skyDim ?? 1;
        const now = s && (sunElevationDeg === undefined || Math.abs(sunElevationDeg - s.sun.altDeg) < 0.05);
        return (now ? s.sky.horizontalLux : ambientLux(sunElevationDeg)) * dim;
      },
    },
    weather,
  };
}

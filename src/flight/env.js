// The one adapter between the flight and the rest of the app (plan 03, section 5.1 principle 3; task F0.2 as narrowed
// by the decisions of 23 Nov 2026). Nothing else under src/flight/ reaches into the app context, sim/, env/ or
// render/: it all comes through here under stable names, so when plan 01 renames or adds something, one file changes.
//
// Plan 01's clock, timeline, environment, pipeline, quality and loop exist, so they are passed through as they are.
// Stand-ins remain only for what plan 01 has not delivered yet (the decisions' table):
//   air at a point   plan 01's env.at() gives temperature, wind, cloud and rain; the flight also wants pressure and
//                    density aloft, which come from the standard atmosphere. Where plan 01 is silent (before its first
//                    state, or a field it lacks) the air is clear and standard.
//   shadows          plan 01's camera-following shadows are not merged; null until app.shadows exists.
//   temperature aloft  plan 01's env.at() (a stand-in itself) lapses the surface temperature by the scene's y, which
//                    is the height above the field only near the city: the frame drops with the Earth's curve, so at
//                    cruise 400 km out the scene's y is 4.5 km at 9.3 km above sea level, and the air came out 27 C
//                    too warm (no frost on the window, 24 Nov 2026). The adapter re-lapses by the difference.
//   as-flown air    a recorded flight carries the weather it was flown in (the header's `weather`, written by
//                    scripts/lib/flight_weather.py: the airport's reports, cloud layers with observed bases and
//                    estimated tops, the GFS column). While its journey is attached, at() answers from that record:
//                    temperature and wind from the header's `atmosphere`, pressure and humidity from the column, cloud,
//                    visibility and rain from the layers. A flight without one keeps the behaviour above.
//                    Plan 4.2: the weather stays as flown when the flight is retimed, until the visitor picks another
//                    source in plan 01's #sky (then at() reads plan 01's state, its cloud layers included).
//   cloud            plan 01's sky here draws no cloud and its fog ignores the weather, so while a journey is attached
//                    the flight draws the honest minimum round itself (src/flight/clouds.js: a white-out inside a
//                    layer, the visibility under it, the layer's top and base as decks) from sky(); it is added to the
//                    scene with the journey and taken out with it.
//   plan 01's weather  the record is handed to plan 01's weather service the way #sky and the drive set it (source and
//                    overrides: src/weather/service.js setSource, setOverride), and the map's settings are put back
//                    when the journey ends, unless the visitor changed them meanwhile. Plan 01's overrides have no
//                    temperature, dew point, cloud top or mid-level cloud: planOneSettings() says what is left out.
//   exposure        plan 01's prior is written for a camera standing in the lit city. While a journey is attached or
//                    the night ground is shown (Orbit has no journey) the adapter gives plan 01's look the flight's own
//                    prior terms (src/render/look.js setPriorTerms,
//                    src/flight/exposure.js): the lamps' light at the eye (the night ground's lightAt, handed in by
//                    provideGroundLight), a floor for the eye's adaptation, a share of plan 01's city terms near the
//                    ground, and the key on lit terrain at a grazing Sun. The default is put back when it ends.
// `standIns` lists what is stood in for, so the debug hooks and "About this flight" can say so.
import { Vector3 } from 'three';
import { createFrame } from '../world/frame.js';
import { altitudeOf } from '../core/earth.js';
import { presetSample } from '../weather/presets.js';
import { KOSCHMIEDER, rayleighExtinction, FREE_TROPOSPHERE_AOD, DUST_MEE_M2_PER_G } from '../weather/medium.js';
import { haze } from '../render/materials/shared.js';
import { flightPriorTerms } from './exposure.js';

// International Standard Atmosphere (ICAO Doc 7488), to 20 km. Heights are taken as geopotential: at cruise the
// difference from geometric height is 0.2%, far below what the window shows.
const T0 = 288.15, P0 = 101325, LAPSE = 0.0065, R_AIR = 287.05287, GAMMA = 1.4, G0 = 9.80665, TROPOPAUSE = 11000;
const T11 = T0 - LAPSE * TROPOPAUSE;
const EXP = G0 / (LAPSE * R_AIR);
const P11 = P0 * (T11 / T0) ** EXP;

/**
 * The standard atmosphere at a height above sea level (m).
 * @returns {{ tempC: number, tempK: number, pressureHPa: number, densityKgM3: number, soundMs: number, sigma: number }}
 */
export function standardAtmosphere(altM) {
  const h = Math.min(altM, 20000);
  const tempK = h <= TROPOPAUSE ? T0 - LAPSE * h : T11;
  const p = h <= TROPOPAUSE ? P0 * (tempK / T0) ** EXP : P11 * Math.exp((-G0 * (h - TROPOPAUSE)) / (R_AIR * T11));
  const densityKgM3 = p / (R_AIR * tempK);
  return { tempC: tempK - 273.15, tempK, pressureHPa: p / 100, densityKgM3, soundMs: Math.sqrt(GAMMA * R_AIR * tempK), sigma: densityKgM3 / 1.225 };
}

export const CLEAR_VISIBILITY_M = 80000;
export const WEATHER_FORMAT = 'skyline-flight-weather/1';
/** In cloud inside a layer at least this covered (broken), as the bake's lib/flight_weather.py IN_CLOUD_COVER. */
export const IN_CLOUD_COVER = 0.5;
/** Visibility inside a layer by genus, m: the bake's estimate (flight_weather.py IN_CLOUD_VISIBILITY_M), used for a
 * plan 01 sample, which has no in-cloud visibility of its own. */
export const IN_CLOUD_VISIBILITY_M = Object.freeze({ st: 110, sc: 110, cu: 110, tcu: 110, cb: 110, ac: 230, as: 230, ci: 3000, cs: 3000 });
/** Plan 01's low cloud: a base less than this above the ground and not cirrus (src/weather/overrides.js). */
const LOW_TOP_AGL = 3700;
const HIGH_GENERA = new Set(['ci', 'cs']);

const lerp = (a, b, f) => a + (b - a) * f;
/** Linear in z through rows sorted by z (column `k`); held beyond the ends. Rows whose value is null are skipped. */
function rowValue(rows, z, k) {
  let prev = null;
  for (const r of rows) {
    if (r[k] === null || r[k] === undefined) continue;
    if (z <= r[0]) return prev ? lerp(prev[k], r[k], (z - prev[0]) / (r[0] - prev[0])) : r[k];
    prev = r;
  }
  return prev ? prev[k] : null;
}

/** The layer a height is in, or null. */
const layerAt = (layers, altM) => layers.find((l) => altM >= l.baseM && altM <= l.topM) || null;

/**
 * Cloud, visibility and rain at a height from cloud layers ({ genus, baseM, topM, fraction | cover }): in cloud inside
 * a broken or overcast layer; visibility below the lowest base `belowBaseM` (null: clear), inside a thick layer the
 * record's (or the genus estimate), clear elsewhere; rain below the top of the lowest thick layer.
 */
export function cloudAt(layers, altM, { belowBaseM = null, inCloudM = IN_CLOUD_VISIBILITY_M, rainMmH = 0 } = {}) {
  const cover = (l) => l.fraction ?? l.cover ?? 0;
  const L = layerAt(layers, altM);
  const inCloud = !!L && cover(L) >= IN_CLOUD_COVER;
  const lowest = layers.length ? Math.min(...layers.map((l) => l.baseM)) : Infinity;
  let visibilityM = CLEAR_VISIBILITY_M;
  if (inCloud) visibilityM = inCloudM[L.genus] ?? 110;
  else if (altM < lowest && Number.isFinite(belowBaseM)) visibilityM = belowBaseM;
  const thick = layers.filter((l) => cover(l) >= IN_CLOUD_COVER);
  const rainTop = thick.length ? thick[0].topM : layers.length ? layers[0].topM : Infinity;
  return { inCloud, cloudDensity: L ? cover(L) : 0, layer: L, visibilityM, rainRateMmH: rainMmH > 0 && altM <= rainTop ? rainMmH : 0 };
}

/**
 * The air of a flight's header (`meta`: atmosphere rows and the `weather` record) at a height above sea level, or
 * null when the header has no record. Wind is in scene axes (x east, z south; the header's are grid east and north).
 */
export function recordedAir(meta) {
  const w = meta?.weather;
  if (!w || w.format !== WEATHER_FORMAT) return null;
  const atm = Array.isArray(meta.atmosphere) ? meta.atmosphere : [];
  const aloft = Array.isArray(w.aloft) ? w.aloft : [];
  const layers = (w.layers || []).map((l) => ({ ...l }));
  const below = w.visibility && !w.visibility.belowBaseCensored && Number.isFinite(w.visibility.belowBaseM) ? w.visibility.belowBaseM : null;
  const inCloudM = { ...IN_CLOUD_VISIBILITY_M, ...(w.visibility?.inCloudM || {}) };
  const rainMmH = w.precipitation?.kind === 'rain' || w.precipitation?.kind === 'drizzle' ? Math.max(0, w.precipitation.rateMmH || 0) : 0;
  const top = aloft.length ? aloft[aloft.length - 1] : null, bottom = aloft.length ? aloft[0] : null;
  /** Pressure, hPa: log-linear between the column's levels, the standard atmosphere's shape beyond them. */
  function pressureAt(z) {
    if (!aloft.length) return standardAtmosphere(z).pressureHPa;
    if (z <= bottom[0]) return bottom[1] * standardAtmosphere(z).pressureHPa / standardAtmosphere(bottom[0]).pressureHPa;
    if (z >= top[0]) return top[1] * standardAtmosphere(z).pressureHPa / standardAtmosphere(top[0]).pressureHPa;
    for (let i = 1; i < aloft.length; i++) {
      const a = aloft[i - 1], b = aloft[i];
      if (z <= b[0]) return Math.exp(lerp(Math.log(a[1]), Math.log(b[1]), (z - a[0]) / (b[0] - a[0])));
    }
    return top[1];
  }
  return {
    record: w,
    layers,
    belowBaseM: below,
    badge: w.badge,
    /** @param {number} altM height above sea level */
    at(altM, out = {}) {
      const std = standardAtmosphere(altM);
      const tempC = atm.length ? rowValue(atm, altM, 1) : std.tempC;
      const e = atm.length ? rowValue(atm, altM, 2) : 0, n = atm.length ? rowValue(atm, altM, 3) : 0;
      const pressureHPa = pressureAt(altM);
      const rh = aloft.length ? rowValue(aloft, altM, 3) : null;
      const c = cloudAt(layers, altM, { belowBaseM: below, inCloudM, rainMmH });
      out.altitudeM = altM;
      out.tempC = tempC;
      out.pressureHPa = pressureHPa;
      out.densityKgM3 = (pressureHPa * 100) / (R_AIR * (tempC + 273.15));
      out.rh = rh === null ? null : rh / 100;
      out.wind = (out.wind && out.wind.isVector3 ? out.wind : new Vector3()).set(e, 0, -n);
      out.cloudDensity = c.cloudDensity;
      out.inCloud = c.inCloud;
      out.rainRateMmH = c.rainRateMmH;
      out.visibilityM = c.visibilityM;
      out.source = 'as-flown';
      return out;
    },
  };
}

/** Aerosol optical depth that gives a visual range at the ground with the clear preset's layer (the inverse of
 * plan 01's visibilityFromAerosol), or null when the preset's own air is already that clear. */
function hazeFor(visibilityM, groundM) {
  const a = presetSample('clear', 0, groundM).aerosol;
  const beta = KOSCHMIEDER / visibilityM - rayleighExtinction(groundM);
  if (!(beta > DUST_MEE_M2_PER_G * a.dustUgM3 * 1e-6)) return null;
  return FREE_TROPOSPHERE_AOD + beta * a.layerHeightM;
}

/**
 * The as-flown record as plan 01 weather settings, the way #sky sets them: the clear preset with overrides for the
 * low and high cloud (amount, the low base), the haze that gives the reported visibility, the surface wind and the
 * rain. `omitted` lists what plan 01's overrides cannot say (they have no temperature, dew point, cloud top or
 * mid-level cloud).
 * @returns {{ source: { kind: 'preset', id: string }, overrides: Record<string, number>, omitted: string[] }}
 */
export function planOneSettings(record, groundM) {
  const layers = record.layers || [];
  const agl = (l) => l.baseM - groundM;
  const low = layers.filter((l) => agl(l) < LOW_TOP_AGL && !HIGH_GENERA.has(l.genus));
  const high = layers.filter((l) => HIGH_GENERA.has(l.genus));
  const mid = layers.filter((l) => !low.includes(l) && !high.includes(l));
  const overrides = {
    lowCloud: low.reduce((m, l) => Math.max(m, l.fraction), 0),
    highCloud: high.reduce((m, l) => Math.max(m, l.fraction), 0),
  };
  const omitted = ['temperature and dew point (no override: the preset\'s)', 'cloud tops (plan 01 gives each genus its own depth)'];
  if (low.length) {
    overrides.cloudBase = Math.max(150, Math.min(4500, agl(low[0])));
    if (low.length > 1) omitted.push(`${low.length - 1} more low layer(s): one low base only`);
  }
  if (high.length) omitted.push('the high cloud\'s base (plan 01 places it at 9,000 m)');
  for (const l of mid) omitted.push(`mid-level ${l.cover} at ${Math.round(agl(l))} m above the ground (no mid-level override)`);
  const s = record.surface || {};
  if (Number.isFinite(s.windKt)) overrides.windSpeed = Math.round(s.windKt * 0.514444 * 10) / 10;
  if (Number.isFinite(s.windDir)) overrides.windDir = Math.round(s.windDir) % 360;
  const p = record.precipitation;
  overrides.rain = p && (p.kind === 'rain' || p.kind === 'drizzle') ? p.rateMmH : 0;
  const v = record.visibility;
  if (v && !v.belowBaseCensored && Number.isFinite(v.belowBaseM)) {
    const aod = hazeFor(v.belowBaseM, groundM);
    if (aod !== null) overrides.haze = Math.round(Math.min(1.5, aod) * 100) / 100;
  }
  return { source: { kind: 'preset', id: 'clear' }, overrides, omitted };
}

const sameSettings = (a, b) => !!a && !!b && JSON.stringify(a.source) === JSON.stringify(b.source)
  && JSON.stringify(Object.entries(a.overrides).sort()) === JSON.stringify(Object.entries(b.overrides).sort());

/**
 * @param {object} app the app context (src/app/context.js) with what main.js adds: clock, timeline, env, pipeline,
 *   quality, loop, events, transport. Tests pass a plain object with the same members.
 */
export function createFlightEnv(app) {
  const { city, env } = app;
  const frame = createFrame(city);
  const standIns = [];
  if (!app.shadows) standIns.push('shadows');
  standIns.push('temperature aloft');
  const LAPSE = 0.0065;

  // ---- the as-flown weather of the attached flight, and plan 01's weather while it flies
  let flight = null; // { air: recordedAir(meta), meta } while a recorded flight with a record is attached
  const wxListeners = new Set();
  const tellWeather = () => { for (const fn of [...wxListeners]) fn(); };
  const plan01 = { saved: null, imposed: null, settings: null, queue: Promise.resolve(), service: null };
  const groundM = city.stationElevationM ?? city.base ?? 0;
  /** Plan 01's weather service, loaded on demand (src/weather/index.js app.loadWeather); null where there is none. */
  const service = () => (app.weather && typeof app.weather.setSource === 'function' ? Promise.resolve(app.weather)
    : typeof app.loadWeather === 'function' ? Promise.resolve().then(() => app.loadWeather()).catch(() => null) : Promise.resolve(null));
  const settingsOf = (svc) => (svc ? { source: svc.source, overrides: svc.overrides } : null);
  /** True once the visitor has picked another source or override in #sky while a recorded flight flies (plan 4.2). */
  const visitorChose = () => !!(plan01.service && plan01.imposed && !sameSettings(settingsOf(plan01.service), plan01.imposed));
  const enqueue = (fn) => (plan01.queue = plan01.queue.then(fn).catch(() => {}));
  function impose(record) {
    enqueue(async () => {
      const svc = await service();
      if (!svc || !flight || flight.air.record !== record) return;
      plan01.service = svc;
      const want = planOneSettings(record, svc.groundM ?? groundM);
      if (!plan01.saved || !sameSettings(settingsOf(svc), plan01.imposed)) plan01.saved = settingsOf(svc);
      svc.setSource(want.source);
      svc.clearOverrides();
      for (const [k, v] of Object.entries(want.overrides)) svc.setOverride(k, v);
      plan01.imposed = settingsOf(svc);
      plan01.settings = want;
    });
  }
  function release() {
    enqueue(() => {
      const svc = plan01.service;
      if (svc && plan01.saved && sameSettings(settingsOf(svc), plan01.imposed)) {
        svc.setSource(plan01.saved.source);
        svc.clearOverrides();
        for (const [k, v] of Object.entries(plan01.saved.overrides)) svc.setOverride(k, v);
      }
      plan01.saved = plan01.imposed = plan01.settings = null;
    });
  }
  /** Plan 01's sample as layers and the visibility below them (when the visitor chose its weather while flying). */
  function plan01Sky() {
    const w = env.state?.weather;
    const layers = (w?.clouds || []).map((c) => ({ genus: c.genus, baseM: c.baseM, topM: c.topM, fraction: c.cover }));
    const rain = w?.precip && (w.precip.kind === 'rain' || w.precip.kind === 'drizzle') ? w.precip.rateMmH || 0 : 0;
    return { layers, belowBaseM: Number.isFinite(env.state?.visibilityM) ? env.state.visibilityM : null, rain };
  }

  // ---- the cloud drawn round the aircraft while a journey is attached (src/flight/clouds.js, loaded on first use)
  const cloud = { mod: null, clouds: null, off: null, want: false, loading: null };
  function showClouds(on) {
    cloud.want = on;
    if (!app.scene || !app.camera || !app.loop) return;
    if (on && !cloud.clouds) {
      cloud.loading ||= import('./clouds.js').then((m) => { cloud.clouds = m.createClouds({ fe, scene: app.scene, haze }); showClouds(cloud.want); })
        .catch(() => { cloud.loading = null; });
      return;
    }
    if (!cloud.clouds) return;
    if (on && !cloud.off) {
      app.scene.add(cloud.clouds.group);
      // after the mode has placed the camera (order 20), before the environment (40) and the render (60)
      cloud.off = app.loop.add({ update: () => cloud.clouds.update(app.camera) }, 25);
      cloud.clouds.update(app.camera);
      fe.invalidate();
    } else if (!on && cloud.off) {
      cloud.off();
      cloud.off = null;
      cloud.clouds.group.removeFromParent();
      fe.invalidate();
    }
  }

  // ---- the exposure while flying (exposure.js, through plan 01's look.setPriorTerms while a journey is attached)
  // on while a journey is attached or the flight's night ground is shown (Orbit flies with no journey on the timeline)
  const exposure = { ground: null, on: false, journey: false, shown: false };
  const eye = () => (app.camera ? app.camera.position : null);
  function priorTermsWhileFlying(terms) {
    const p = eye();
    const g = exposure.ground && p ? exposure.ground.lightAt(p) : null;
    return flightPriorTerms(terms, { lampLux: g ? g.lampLux : 0, heightAboveGroundM: g && Number.isFinite(g.heightAboveGroundM) ? g.heightAboveGroundM : Infinity,
      keyIsSun: terms.keyBody === 'sun', cityFactor: env.nodes?.cityFactor?.value ?? 1 });
  }
  function exposeForFlight(on = exposure.journey || exposure.shown) {
    if (!app.look || typeof app.look.setPriorTerms !== 'function' || on === exposure.on) return;
    exposure.on = on;
    app.look.setPriorTerms(on ? priorTermsWhileFlying : null);
  }

  const fe = {
    city,
    cityId: app.cityId,
    frame,
    clock: app.clock,
    timeline: app.timeline,
    transport: app.transport,
    loop: app.loop,
    events: app.events,
    pipeline: app.pipeline,
    quality: app.quality,
    shadows: app.shadows ?? null,
    standIns,
    /** Ask for a frame (the loop draws on demand). */
    invalidate: () => (app.invalidate || app.loop.invalidate)(),

    // ---- the environment (plan 01, section 11.4)
    /** Plan 01's state at the clock's time (rebuilt at frame step 40); null before its first update. */
    get state() { return env.state; },
    nodes: env.nodes,
    lights: env.lights,
    /** Sun, Moon and sky light at a scene position (plan 01's). */
    lightAt: (pos) => env.lightAt(pos),
    /**
     * The air at a scene position. While a recorded flight with a weather record is attached (and the visitor has not
     * picked other weather in #sky): the record's, recordedAir(). Otherwise plan 01's env.at() (temperature, wind,
     * cloud, rain, visibility) with the height above sea level, pressure and density added from the standard
     * atmosphere, and cloud from plan 01's sample's layers; clear and standard where plan 01 has nothing to say.
     */
    at(pos) {
      const altitudeM = altitudeOf(pos, city);
      if (flight && !visitorChose()) return flight.air.at(altitudeM);
      const std = standardAtmosphere(altitudeM);
      const local = env.state && typeof env.at === 'function' ? env.at(pos) : null;
      const pick = (k, fallback) => (local && local[k] !== undefined && local[k] !== null ? local[k] : fallback);
      const out = {
        altitudeM,
        // plan 01 lapsed by the scene's y; the true height above the field is altitudeM - base (see the header)
        tempC: local && Number.isFinite(local.tempC) ? local.tempC - LAPSE * (altitudeM - (city.base ?? 0) - Math.max(0, pos.y)) : std.tempC,
        pressureHPa: std.pressureHPa,
        densityKgM3: std.densityKgM3,
        rh: Number.isFinite(env.state?.weather?.rh) ? env.state.weather.rh : null,
        wind: pick('wind', new Vector3()),
        cloudDensity: pick('cloudDensity', 0),
        inCloud: pick('inCloud', false),
        rainRateMmH: pick('rainRateMmH', 0),
        visibilityM: pick('visibilityM', CLEAR_VISIBILITY_M),
        source: local ? 'plan01' : 'standard',
      };
      // plan 01's env.at() has no cloud yet (its phase 6): the sample's own layers say where cloud is
      if (local && !out.inCloud && env.state?.weather?.clouds?.length) {
        const sky = plan01Sky();
        const c = cloudAt(sky.layers, altitudeM, { belowBaseM: sky.belowBaseM, rainMmH: Math.max(out.rainRateMmH, sky.rain) });
        Object.assign(out, { inCloud: c.inCloud, cloudDensity: c.cloudDensity, visibilityM: Math.min(out.visibilityM, c.visibilityM), rainRateMmH: c.rainRateMmH });
      }
      return out;
    },
    /**
     * The cloud the flight draws round itself (the veil inside a layer and the decks above and below): the layers and
     * the visibility under them, from the record or plan 01's sample, and where they came from.
     * @returns {{ layers: { genus: string, baseM: number, topM: number, fraction: number }[], belowBaseM: number | null, source: string }}
     */
    sky() {
      if (flight && !visitorChose()) return { layers: flight.air.layers, belowBaseM: flight.air.belowBaseM, source: 'as-flown' };
      const s = plan01Sky();
      return { layers: s.layers, belowBaseM: s.belowBaseM, source: env.state?.weather ? 'plan01' : 'standard' };
    },
    /** The attached flight's weather: its record, its badge, what was handed to plan 01 and whether the visitor has
     * since chosen other weather; null without a recorded flight that has one. */
    get flightWeather() {
      if (!flight) return null;
      return { record: flight.air.record, badge: flight.air.badge, plan01: plan01.settings, visitorChose: visitorChose() };
    },
    /** What the cloud round the aircraft drew last (clouds.js stats), or null while none is shown. */
    get clouds() { return cloud.off && cloud.clouds ? cloud.clouds.stats() : null; },
    /** Resolves once the cloud module has loaded (or at once without a scene). */
    whenCloudsReady: () => cloud.loading || Promise.resolve(),
    /** Resolves once the flight's weather has reached plan 01's service (or been given back). */
    whenWeatherApplied: () => plan01.queue,

    /**
     * The night ground hands itself in here ({ lightAt(eye) -> { lampLux, heightAboveGroundM } }, ground/index.js), so
     * the exposure while flying can ask for the lamps' light at the eye. Returns { shown(on), off() }: the ground says
     * when it is shown (the flight's prior is on then, in Orbit too) and takes itself back.
     */
    provideGroundLight(source) {
      exposure.ground = source;
      return {
        shown(on) { if (exposure.ground !== source) return; exposure.shown = !!on; exposeForFlight(); },
        off() { if (exposure.ground !== source) return; exposure.ground = null; exposure.shown = false; exposeForFlight(); },
      };
    },
    /** Whether the flight's prior is in use, and its terms of the last frame (plan 01's look.current.priorTerms). */
    get exposure() { return { on: exposure.on, terms: exposure.on ? app.look?.current?.priorTerms ?? null : null }; },

    /** Call fn when the weather the flight flies in changes: plan 01's data or settings (env 'weather'), or a recorded
     * flight's own record coming or going. Returns a function that stops it. */
    onWeather(fn) {
      wxListeners.add(fn);
      const off = typeof env.on === 'function' ? env.on('weather', fn) : () => {};
      return () => { wxListeners.delete(fn); off(); };
    },

    /** Begin a journey: through the transport bar when it is mounted (it shows the markers), else on the timeline.
     * A recorded flight's weather record comes with it (and goes with null). */
    attachJourney(journey) {
      const meta = journey?.track?.meta ?? null;
      const air = meta ? recordedAir(meta) : null;
      const had = flight;
      flight = air ? { air, meta } : null;
      if (air) impose(air.record);
      else if (had) release();
      const h = app.transport ? app.transport.attachJourney(journey) : app.timeline.begin(journey);
      showClouds(!!journey);
      exposure.journey = !!journey;
      exposeForFlight();
      if (had || air) tellWeather();
      return h;
    },

    // ---- the map's time, handed to the flight and given back (one clock, as the drive does in src/drive/index.js)
    /** Enter plan 01's clock state: the sky follows the clock, so a scrub moves the Sun. */
    enterClock: () => env.enterClock(),
    /** What the map had: pinned or the clock state, its night look, the instant, the rate, playing, live. */
    saveMapTime() {
      const { clock } = app;
      return { mode: env.mode, night: !!app.settings?.night, timeMs: clock.timeMs, rate: clock.rate, playing: clock.playing, live: clock.live };
    },
    /** Put back what saveMapTime() returned. Pinning pauses the clock, as a pinned map has it. */
    restoreMapTime(m) {
      const { clock } = app;
      clock.pause();
      if (m.live) clock.goLive();
      else {
        clock.set(m.timeMs);
        if (clock.rate !== m.rate) clock.setRate(m.rate);
      }
      if (m.mode === 'pinned') { if (env.mode !== 'pinned' || !!app.settings?.night !== m.night) env.pin(m.night); return; }
      if (m.playing && !m.live) clock.play();
    },
  };
  return fe;
}

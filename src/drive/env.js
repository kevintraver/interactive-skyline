// The drive's environment port (plan 02, section 11.1), in one file, on both renderers.
//
// Classic renderer (the reference until the GLSL path is deleted): stand-ins for plan 01's EnvPort, pure maths, no DOM
// and no three: the clock, the ephemeris (NOAA), quality (fixed 'high'), the weather (rain presets the visitor picks;
// see the weather stand-in below), and lighting's units and ambientLux tied to the classic fixed exposure.
//
// Plan 01's renderer (third stretch, decisions 4, 5 and 9): the adapter of plan 01's section 11.10 (createEnv with
// `app`). The clock is app.clock (one clock for the app), the ephemeris is app.env.ephemeris, the ambient light is
// env.state.sky.horizontalLux, and `plan01`, `nodes` and `state` reach plan 01's environment itself. The members keep
// the drive's names and shapes, so a part reads the same port on either renderer. The weather is still the stand-in
// below on both (decision 9 moves it to env.state when the weather part is ported).
import { zonedToUtc } from '../core/time.js';

export const RATE_MIN = 0.25;
export const RATE_MAX = 16;

const RAD = Math.PI / 180;
const DAY_MS = 86400000;

/**
 * Simulation clock. Time only moves in advance(), which the app's frame loop calls once a frame,
 * so a paused clock or a hidden tab never drifts.
 * @param {{ nowMs?: number, playing?: boolean, rate?: number }} [opts]
 */
export function createClock({ nowMs = Date.now(), playing = false, rate = 1 } = {}) {
  let simMs = nowMs;
  let isPlaying = !!playing;
  let r = clampRate(rate);
  const listeners = { tick: new Set(), seek: new Set(), rate: new Set(), play: new Set(), pause: new Set() };
  const emit = (type, dtSimMs = 0) => {
    for (const fn of [...listeners[type]]) fn({ simMs, dtSimMs });
  };

  return {
    /** Simulation time, UTC ms. */
    now: () => simMs,
    get playing() { return isPlaying; },
    /** Simulation seconds per real second. */
    get rate() { return r; },
    seek(ms) {
      if (!Number.isFinite(ms)) return;
      const dt = ms - simMs;
      simMs = ms;
      emit('seek', dt);
    },
    play() { if (!isPlaying) { isPlaying = true; emit('play'); } },
    pause() { if (isPlaying) { isPlaying = false; emit('pause'); } },
    setRate(value) {
      const next = clampRate(value);
      if (next !== r) { r = next; emit('rate'); }
    },
    /** Move time by dtRealMs * rate when playing. Emits 'tick' only when time moved. */
    advance(dtRealMs) {
      if (!isPlaying || !(dtRealMs > 0)) return;
      const dt = dtRealMs * r;
      simMs += dt;
      emit('tick', dt);
    },
    /**
     * @param {'tick'|'seek'|'rate'|'play'|'pause'} type
     * @param {(e: { simMs: number, dtSimMs: number }) => void} fn
     * @returns {() => void} unsubscribe
     */
    on(type, fn) {
      const set = listeners[type];
      if (!set) throw new Error(`clock: unknown event "${type}"`);
      set.add(fn);
      return () => set.delete(fn);
    },
  };
}

function clampRate(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, v));
}

/** Sun position terms shared by elevation and the equation of time (NOAA's spreadsheet, after Meeus). */
function solarTerms(simMs) {
  const jd = simMs / DAY_MS + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
  const omega = (125.04 - 1934.136 * T) * RAD;
  const appLong = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliq = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliq = (meanObliq + 0.00256 * Math.cos(omega)) * RAD;
  const decl = Math.asin(Math.sin(obliq) * Math.sin(appLong));
  const y = Math.tan(obliq / 2) ** 2;
  const L0r = L0 * RAD;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr)); // minutes
  return { decl, eqTime };
}

/** NOAA's atmospheric refraction correction, degrees, for a geometric elevation in degrees. */
function refraction(el) {
  if (el > 85) return 0;
  const t = Math.tan(el * RAD);
  let arcsec;
  if (el > 5) arcsec = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
  else if (el > -0.575) arcsec = 1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711)));
  else arcsec = -20.772 / t;
  return arcsec / 3600;
}

/**
 * The sun seen from a place, with refraction, by NOAA's solar position algorithm (the one behind
 * its solar calculator and spreadsheets). Good to about 0.1 degree within a few centuries of 2000.
 * @returns {{ azimuth: number, elevation: number }} degrees; azimuth clockwise from north
 */
export function sunPosition(simMs, lat, lon) {
  const { decl, eqTime } = solarTerms(simMs);
  const minutes = (((simMs % DAY_MS) + DAY_MS) % DAY_MS) / 60000;
  const tst = (((minutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * RAD;
  const latR = lat * RAD;
  const cz = Math.min(1, Math.max(-1, Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha)));
  const zen = Math.acos(cz);
  const el = 90 - zen / RAD;
  const den = Math.cos(latR) * Math.sin(zen);
  let azimuth;
  if (Math.abs(den) < 1e-12) azimuth = lat > 0 ? 180 : 0;
  else {
    const a = Math.acos(Math.min(1, Math.max(-1, (Math.sin(latR) * Math.cos(zen) - Math.sin(decl)) / den))) / RAD;
    azimuth = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  return { azimuth, elevation: el + refraction(el) };
}

/** The calendar date (y, m 1-12, d) of an instant in a time zone. */
export function localDate(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(ms));
  const get = (type) => +parts.find((p) => p.type === type).value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * Sun ephemeris at a city's origin.
 * @param {{ origin: { lat: number, lon: number }, tz: string }} city
 */
export function createEphemeris(city) {
  const { lat, lon } = city.origin;
  const tz = city.tz || 'UTC';
  const sun = (simMs) => sunPosition(simMs, lat, lon);

  /** UTC ms of solar noon on the local calendar day containing dayMs. */
  function solarNoon(dayMs) {
    const { y, m, d } = localDate(dayMs, tz);
    let noon = Date.UTC(y, m - 1, d, 12) - lon * 4 * 60000;
    for (let k = 0; k < 2; k++) noon = Date.UTC(y, m - 1, d, 12) - (lon * 4 + solarTerms(noon).eqTime) * 60000;
    return noon;
  }

  /**
   * When the sun crosses `elevationDeg` (refracted, as sun() reports it) on the local day of dayMs:
   * the evening crossing between solar noon and the following lower transit, or the morning one
   * before noon. NaN when the sun does not reach that elevation that day.
   */
  function timeOfSunElevation(elevationDeg, dayMs, evening = true) {
    const noon = solarNoon(dayMs);
    // elevation falls monotonically from noon to the lower transit 12 h later
    let a = evening ? noon : noon - DAY_MS / 2;
    let b = evening ? noon + DAY_MS / 2 : noon;
    const f = (t) => sun(t).elevation - elevationDeg;
    let fa = f(a);
    const fb = f(b);
    if (fa * fb > 0) return NaN;
    while (b - a > 1) {
      const mid = (a + b) / 2;
      const fm = f(mid);
      if ((fm > 0) === (fa > 0)) { a = mid; fa = fm; } else b = mid;
    }
    return Math.round((a + b) / 2);
  }

  return { sun, timeOfSunElevation, solarNoon };
}

// ---------------------------------------------------------------- lighting stand-ins
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

/**
 * Scene value per SI unit at today's fixed exposure (ACES filmic, toneMappingExposure 1, src/app/context.js).
 * STAND-INS: plan 01's exposure replaces them, and with it the need for one number per unit.
 *
 * Why the three are equal: three's physical lights already speak photometry. A PointLight or SpotLight of
 * intensity I gives irradiance I / d^2 (decay 2), and a Lambert surface sends albedo x E / pi back (BRDF_Lambert
 * is diffuse / pi; hemisphere and directional intensities are irradiances). So 1 cd must map to the same scene
 * value as 1 lux at 1 m, and 1 lux on a surface of albedo rho must look like rho / pi cd/m^2 drawn as emissive.
 * One scale k then serves all three: candela = lux = nit = k.
 *
 * Why k = 0.1: the scale is set against the app's NIGHT look, the only one the drive's lights matter in.
 *  - The night look's ground: hemisphere 0.38 (sky 0x33426e, ground 0x4a3a2a, luminance about 0.05) plus the moon
 *    stand-in 0.2 (0x93a8d9, luminance 0.38) at 32 deg give a horizontal irradiance of about 0.06, so asphalt
 *    (albedo about 0.15) shows about 0.003 (src/sky/legacySky.js, NIGHT). With k = 0.1 that reads as 0.03 cd/m^2,
 *    about three times a full-moon-lit road: the night look is a bright, moonlit stylisation, and this keeps it so.
 *  - A lit window in src/night.js is about 0.75 x 0.75 = 0.56 of emissive: 5.6 cd/m^2, the low end of a lit
 *    window seen from outside (assumed 5-50 cd/m^2).
 *  - A lit freeway (about 10-20 lux on asphalt: 0.3-0.6 cd/m^2) lands at 0.03-0.06, ten to twenty times the
 *    moonlit ground and the same order as the existing street glow (0.07-0.26 x 0xffa858) it will replace.
 *  - Our low-beam pool (about 8 lux at 10 m, 0.25 cd/m^2; under 1 lux at 30 m, 0.02 cd/m^2): 0.025 near the
 *    car, fading to the moonlit ground's level by about 30 m, as headlamps on an unlit road do against moonlight.
 *  - A retroreflective guide sign at 150 m (10-60 cd/m^2, section 7.4): 1-6 of scene radiance, the brightest thing
 *    in view, ACES compresses it to near white: the flare of a guide sign, ahead of the windows.
 * By day the sun is 2.7 and the hemisphere 0.8, about 2 of horizontal irradiance for a real 50,000 lux, so these
 * units are 2,000x off in daylight; the dusk blend must fade the drive's lights in with the night look, not
 * expect the units to do it.
 */
export const LIGHTING_UNITS = Object.freeze({
  /** scene emissive radiance per cd/m^2 */
  nit: 0.1,
  /** scene light intensity (three's PointLight / SpotLight `intensity`) per candela */
  candela: 0.1,
  /** scene irradiance (illuminance maps, pools) per lux */
  lux: 0.1,
});

// ---------------------------------------------------------------- weather stand-in
// Plan 01's weather service (live samples, a wet layer, rain, dust) replaces this. Until then the visitor picks one
// of four presets and everything follows from its rain rate by the rules below: a pure function of the preset (or of
// the rate the test hook sets), with no history, so choosing Rain gives the wet road at once. Clear is the default
// and is exactly the dry state the drive had before.
//
// The rules (R in mm/h):
//  wetness      1 - exp(-R / 2). ASSUMED: a road's texture and drainage take about the first 1-2 mm/h before a
//               continuous film forms, so light rain leaves it damp with the wheel paths wet (0.39) and 4 mm/h and up
//               cover it (0.86, 1.00 at 12).
//  visibilityM  16 km x R^-0.6 (16 km at 1 mm/h, 7 km at 4, 3.6 km at 12), 80 km dry as before. ASSUMED: a fit to
//               the usual ranges reported for rain (around 10 km and more in light rain, a few km in heavy rain);
//               the drive uses it as the lamps' e-folding length (exp(-d / visibility), plan 02, 11.1) and as the
//               5% contrast distance of the fog (skyblend.js).
//  skyDim       daylight as a share of the clear sky's: 1 dry, 0.45 x R^-0.37 in rain (0.45 at 1 mm/h, 0.27 at 4,
//               0.18 at 12). ASSUMED, within the range of CIE overcast against clear skies (an overcast sky gives
//               roughly a tenth to a half of clear-sky daylight); rain needs cloud, so any rain starts at 0.45.
//  overcast     0 dry, 1 in rain: how far the sky goes grey (skyblend.js setSkyWeather).
//  puddles      clamp((R - 4) / 8, 0, 1): standing water in the wheel paths only in heavy rain. ASSUMED.
//  wind         from 200 degrees (south-south-west, the usual quarter of Las Vegas's winter storms: ASSUMED) at 2, 4
//               and 7 m/s for the three rain presets; still when clear.
//  tempC        none: the stand-in has no temperature (hasTemperature false), so the cabin shows none.

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

/**
 * The weather stand-in: env.weather. state() is cached (the lamps read it every frame).
 *   setPreset(id)          one of RAIN_PRESETS' ids; unknown ids are ignored
 *   setRain(mmPerHour)     any rate (a test hook): the state follows by the same rules, preset null
 *   on('change', fn)       fn(state) after every change of state; on('lightning') never fires here
 */
export function createWeather({ preset = 'clear' } = {}) {
  const listeners = new Set();
  let current = weatherFor(0, { preset: 'clear' });
  const set = (next) => {
    const same = Object.keys(next).every((k) => next[k] === current[k]);
    current = next;
    if (!same) for (const fn of [...listeners]) fn(current);
  };
  const weather = {
    hasTemperature: false,
    presets: RAIN_PRESETS,
    state: () => current,
    setPreset(id) {
      const p = RAIN_PRESETS.find((x) => x.id === id);
      if (p) set(weatherFor(p.mmPerHour, { windMps: p.windMps, preset: p.id }));
      return weather;
    },
    setRain(mmPerHour) {
      const R = Number(mmPerHour);
      if (!Number.isFinite(R)) return weather;
      const p = RAIN_PRESETS.find((x) => x.mmPerHour === R);
      set(p ? weatherFor(p.mmPerHour, { windMps: p.windMps, preset: p.id }) : weatherFor(R));
      return weather;
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return weather.setPreset(preset);
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
 * timeOfSunElevation(el, dayMs, evening) on the local calendar day of dayMs (NaN when the sun does not reach it that
 * day), solarNoon(dayMs).
 * @param {{ at(ms: number): { sun: { azDeg: number, altDeg: number } }, timeOfSunAltitude: Function, events?: Function }} eph
 * @param {string} zone the city's IANA zone
 */
export function ephemerisOn(eph, zone) {
  const dayStart = (ms) => { const d = localDate(ms, zone); return zonedToUtc({ year: d.y, month: d.m, day: d.d }, zone); };
  return {
    sun(simMs) { const s = eph.at(simMs).sun; return { azimuth: s.azDeg, elevation: s.altDeg }; },
    timeOfSunElevation(elevationDeg, dayMs, evening = true) {
      let t = null;
      try { t = eph.timeOfSunAltitude(elevationDeg, dayStart(dayMs), evening ? 'setting' : 'rising'); } catch { t = null; } // an altitude it refuses
      return Number.isFinite(t) ? t : NaN;
    },
    solarNoon(dayMs) {
      const e = eph.events ? eph.events(dayStart(dayMs)) : null;
      return e && Number.isFinite(e.noon) ? e.noon : NaN;
    },
  };
}

/**
 * The drive's environment port.
 * @param {{ city: object, app?: object, nowMs?: number, playing?: boolean, rate?: number }} opts
 *   city is an entry of data/cities.json (origin, tz). With `app` (plan 01's renderer) the port adapts plan 01's clock
 *   and environment (app.clock, app.env); without it, the classic renderer's stand-ins.
 */
export function createEnv({ city, app = null, nowMs, playing, rate } = {}) {
  if (!city?.origin) throw new Error('env: city with an origin is required');
  if (app) return adapterEnv(city, app);
  const clock = createClock({ nowMs, playing, rate });
  const ephemeris = createEphemeris(city);
  const weather = createWeather();
  return {
    city,
    legacy: true,
    clock,
    ephemeris,
    quality: { preset: 'high', onChange: () => () => {} },
    lighting: {
      units: LIGHTING_UNITS,
      /**
       * Horizontal illuminance (lux) for a sun elevation in degrees (with no argument, the sun now), under today's
       * weather: the clear sky's (ambientLux) x the rain's sky dimming (weather skyDim, 1 dry), so the street lamps,
       * the vehicles' lamps and the headlights, which switch on this, come on earlier under a dark rainy sky.
       */
      ambientLux: (sunElevationDeg) => ambientLux(sunElevationDeg ?? ephemeris.sun(clock.now()).elevation) * (weather.state().skyDim ?? 1),
    },
    weather,
  };
}

/** Plan 01's environment behind the drive's port (section 11.10). */
function adapterEnv(city, app) {
  const env = app.env;
  const clock = clockOn(app.clock);
  const ephemeris = ephemerisOn(env.ephemeris, city.tz || app.clock.zone || 'UTC');
  const weather = createWeather();
  const q = app.quality;
  return {
    city,
    legacy: false,
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
      /** Only at the classic display, where the exposure is held at 1 (decision 6); in the shipped look use env.nodes. */
      units: LIGHTING_UNITS,
      /**
       * Horizontal illuminance (lux): plan 01's env.state.sky.horizontalLux for the sun now (with no argument, or the
       * current sun's elevation), else the clear-sky table for that elevation; x the rain's sky dimming, as above.
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

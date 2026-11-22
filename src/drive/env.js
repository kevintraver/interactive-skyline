// Stand-ins for plan 01's EnvPort (plan 02, section 11.1): only what the drive's first phase needs.
// Each member is deleted as plan 01 lands its real one. Pure maths, no DOM and no three.
//
// Present here: clock, ephemeris, quality (fixed 'high'), weather (always dry).
// Plan 01 adds: transport (the shared timeline UI, attachJourney, slotAbove), lighting (units,
// ambientLux, sunDirection, shadow focus, colour from CCT or spectrum), exposure, atmosphere,
// pipeline (render stages, setActiveCamera), quality.caps and renderScale, and weather.on
// with real states.

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

/**
 * The EnvPort stand-in.
 * @param {{ city: object, nowMs?: number, playing?: boolean, rate?: number }} opts
 *   city is an entry of data/cities.json (origin, tz)
 */
export function createEnv({ city, nowMs, playing, rate } = {}) {
  if (!city?.origin) throw new Error('env: city with an origin is required');
  return {
    city,
    clock: createClock({ nowMs, playing, rate }),
    ephemeris: createEphemeris(city),
    quality: { preset: 'high', onChange: () => () => {} },
    weather: {
      state: () => ({ precipMmPerHour: 0, precipKind: 'none', wetness: 0, puddles: 0, windFromDeg: 0, windSpeed: 0, visibilityM: 80000, dust: 0, tempC: 20 }),
      on: () => () => {},
    },
  };
}

// env: the environment facade other subsystems and plans read (plan 01, section 11.4; task T1.7). It composes the
// simulation clock and the ephemeris into `env.state` at frame step 40. Weather, sky glow, rain and lightning are
// stubs with the values of section 11.1 until their phases land; the light values are rough clear-sky estimates
// (phase 3 replaces them with the atmosphere's).
//
// Weather (phase 5): src/weather/ loads on demand and hands the facade a provider (setWeather). In the clock state the
// weather is the provider's sample at the clock's time (the clear preset until data arrives); the pinned looks stay
// clear. `state.medium` is the atmosphere's medium derived from it (section 7.5), which phase 3 writes into its uniforms;
// it comes from the provider too (so no weather code is in the boot bundle) and is null until the provider has loaded.
//
// Two states (sections 4.2 and 5.6, decision 3 after review):
//   pinned  the default: today's two looks. `settings.night` is the persisted boolean; the state is the classic
//           afternoon (the Sun at azimuth 245, altitude 32, as the app has always drawn it) or the reference night.
//   clock   entered from #sky, the time keys, a ?t= link or freeze(): the Sun and Moon come from the ephemeris at
//           the clock's time, and `settings.night` reads "the Sun is more than 6 degrees down" and is not saved.
import { Vector3, Color } from 'three';
import { phaseOf, dirFromAzAlt } from '../sky/ephemeris.js';
import { colorTemperatureToLinearSrgb, luxFromMagnitude, cdM2FromMagArcsec2, magArcsec2FromCdM2, ev100FromIlluminance } from '../core/units.js';
import { PINNED_NIGHT } from '../app/settings.js';
import { parseTimeParam } from '../sim/clock.js';
import { createEnvNodes } from './nodes.js';

/** 23 March 2026 23:08 UTC: astronomy-engine puts the Sun at azimuth 245.00, altitude 32.05 over Las Vegas. */
export const CLASSIC_AFTERNOON = Date.UTC(2026, 2, 23, 23, 8);
/** 19 March 2026 05:00 UTC (10 pm PDT on the 18th): new Moon, the Sun 37 degrees down. */
export const REFERENCE_NIGHT = Date.UTC(2026, 2, 19, 5, 0);
/** Today's fixed light: the afternoon Sun by day, and the stand-in moon at night, from the same direction. */
export const PINNED_SUN = [245, 32];
/** The Sun this far down (true altitude) or further is night for settings.night, night-only extras and the theme. */
export const NIGHT_BELOW_DEG = -6;

const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;

/** Kasten and Young (1989) relative air mass for an apparent altitude in degrees. */
export function airMass(altDeg) {
  if (altDeg <= -1) return Infinity;
  return 1 / (Math.sin(Math.max(altDeg, -0.9) * DEG) + 0.50572 * (Math.max(altDeg, -0.9) + 6.07995) ** -1.6364);
}
/** Illuminance from a body of magnitude `mag` through a clear sky (0.2 mag per air mass), on a surface facing it. */
const throughAir = (mag, altDeg) => (altDeg > -1 ? luxFromMagnitude(mag) * 10 ** (-0.4 * 0.2 * airMass(altDeg)) : 0);

// Horizontal illuminance in twilight, clear sky: the Explanatory Supplement's table (section 8.2), log-interpolated.
const TWILIGHT_LUX = [[-18, 0.000645], [-12, 0.00806], [-9, 0.116], [-6, 3.41], [-3, 79.1], [0, 759], [5, 4540]];
function skyLux(sunAltDeg) {
  if (sunAltDeg <= -18) return 0.000645;
  if (sunAltDeg >= 5) return 4540 + ((Math.min(sunAltDeg, 90) - 5) / 85) * 15000; // diffuse daylight, about 20 klx at the zenith
  for (let i = 1; i < TWILIGHT_LUX.length; i++) {
    const [a1, e1] = TWILIGHT_LUX[i];
    if (sunAltDeg <= a1) {
      const [a0, e0] = TWILIGHT_LUX[i - 1];
      return 10 ** (Math.log10(e0) + ((sunAltDeg - a0) / (a1 - a0)) * (Math.log10(e1) - Math.log10(e0)));
    }
  }
  return 4540;
}
// limiting magnitude from zenith brightness: the Schaefer-based points of section 8.2 (T4.2 makes it exact)
const LIMITING = [[16.7, 2.83], [18, 3.97], [20, 5.49], [22, 6.62]];
function limitingMag(mag) {
  if (mag <= 16.7) return 2.83 - (16.7 - mag) * 0.9;
  for (let i = 1; i < LIMITING.length; i++) {
    if (mag <= LIMITING[i][0]) {
      const [m0, l0] = LIMITING[i - 1], [m1, l1] = LIMITING[i];
      return l0 + ((mag - m0) / (m1 - m0)) * (l1 - l0);
    }
  }
  return 6.62;
}
const BORTLE = [[21.75, 1], [21.6, 2], [21.3, 3], [20.8, 4], [20.3, 5], [19.25, 6], [18.5, 7], [18, 8]];
const bortle = (mag) => (BORTLE.find(([m]) => mag >= m) || [0, 9])[1];

const luminance1 = (rgb) => {
  const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return new Color(rgb[0] / y, rgb[1] / y, rgb[2] / y);
};
const tempColors = new Map();
/** Linear sRGB with luminance 1 for a colour temperature, rounded to 100 K and cached. */
const colorOf = (kelvin) => {
  const k = Math.round(kelvin / 100) * 100;
  if (!tempColors.has(k)) tempColors.set(k, luminance1(colorTemperatureToLinearSrgb(k)));
  return tempColors.get(k).clone();
};

/** The clear preset: a complete WeatherSample (section 6.4) until phase 5 brings data. */
export function clearWeather(t) {
  return {
    t, source: { surface: 'preset', clouds: 'preset', aerosol: 'preset' },
    tempC: 20, dewPointC: -2, rh: 0.22, pressureHPa: 1013,
    wind: { dirDeg: 0, speedMs: 0, gustMs: 0 }, windAloft: [],
    visibilityM: 80000, visibilityCensored: true,
    aerosol: { aod550: 0.06, angstrom: 1.3, dustUgM3: 0, pm25UgM3: 5, layerHeightM: 1500 },
    clouds: [], precip: { rateMmH: 0, kind: 'none', convective: false, virgaBaseM: null },
    storm: { thunder: false, flashRatePerMin: 0, cells: 0, capeJKg: null }, dustWall: null, wxCodes: [],
  };
}

/** The default seed: a hash of the UTC date, so a given day always looks the same (section 6.4). */
const dateSeed = (ms) => { const d = new Date(ms); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };

/**
 * @param {{ city: object, clock: import('../contracts.d.ts').SimClock, ephemeris: ReturnType<import('../sky/ephemeris.js').createEphemeris>,
 *   settings: Record<string, unknown>, seed?: number }} o
 */
export function createEnvironment({ city, clock, ephemeris, settings, seed = null }) {
  let mode = 'pinned', frozen = {}, derivedNight = null;
  const wx = { provider: null, request: null };
  const listeners = new Map();
  const emit = (type, payload) => { for (const fn of [...(listeners.get(type) || [])]) fn(payload); };

  function lightBody(azDeg, altDeg, trueAltDeg, mag, kelvin, angularRadiusRad) {
    return { dir: dirFromAzAlt(azDeg, altDeg), azDeg, altDeg, trueAltDeg, illuminanceLux: throughAir(mag, altDeg),
      color: colorOf(kelvin), angularRadiusRad, aboveHorizon: altDeg > -angularRadiusRad / DEG };
  }

  /** Build a state from celestial positions. `sunAzAlt` overrides the Sun (pinned day, freeze). */
  function build(timeMs, { sunAzAlt = null, standInMoon = false, pinned = false } = {}) {
    const cel = ephemeris.at(timeMs);
    const s = cel.sun, m = cel.moon;
    const [sAz, sAlt] = sunAzAlt || [s.azDeg, s.altDeg];
    const sTrue = sunAzAlt ? sunAzAlt[1] : s.trueAltDeg;
    const sun = lightBody(sAz, sAlt, sTrue, s.magnitude, 2000 + 3800 * smoothstep(0, 30, sAlt), s.angularRadiusRad);
    sun.illuminanceLux *= 1 - s.eclipsedFraction;
    const moon = { ...lightBody(m.azDeg, m.altDeg, m.trueAltDeg, m.magnitude, 4100, m.angularRadiusRad), phaseFraction: m.phaseFraction };

    // the key light (section 7.6): the Sun while it is up, the Moon once the Sun is more than 6 degrees down,
    // neither in between; the weights cross-fade over 2 degrees of solar altitude
    const sunWeight = smoothstep(-0.833, 1.167, sAlt);
    const moonWeight = smoothstep(-6, -8, sTrue) * smoothstep(-0.5, 1.5, m.altDeg);
    let key;
    if (standInMoon) key = { body: 'moon', dir: dirFromAzAlt(...PINNED_SUN), illuminanceLux: 0.1, color: colorOf(4100), weight: 1 };
    else if (sunWeight > 0) key = { body: 'sun', dir: sun.dir.clone(), illuminanceLux: sun.illuminanceLux * sunWeight, color: sun.color.clone(), weight: sunWeight };
    else if (moonWeight > 0) key = { body: 'moon', dir: moon.dir.clone(), illuminanceLux: moon.illuminanceLux * moonWeight, color: moon.color.clone(), weight: moonWeight };
    else key = { body: 'none', dir: sun.dir.clone(), illuminanceLux: 0, color: sun.color.clone(), weight: 0 };

    const ambientLux = skyLux(sTrue) + (moon.aboveHorizon ? 0.2 * moon.illuminanceLux * Math.max(0, Math.sin(m.altDeg * DEG)) : 0);
    const horizontalLux = ambientLux + sun.illuminanceLux * Math.max(0, Math.sin(sAlt * DEG))
      + moon.illuminanceLux * Math.max(0, Math.sin(m.altDeg * DEG));
    // natural sky only until phase 4 adds the city's glow
    const zenithCdM2 = Math.max(ambientLux / (2 * Math.PI), cdM2FromMagArcsec2(21.6));
    const mag = magArcsec2FromCdM2(zenithCdM2);
    const switchOn = smoothstep(2, -6, sAlt); // the night uniform's own ramp (T1.4)
    let weather = frozen.weather && typeof frozen.weather === 'object' ? frozen.weather : null;
    if (!weather && !pinned) {
      // a preset id from freeze(), else the provider's sample; ask for the provider if it has not loaded yet
      if (wx.provider) weather = typeof frozen.weather === 'string' ? wx.provider.preset(frozen.weather, timeMs) : wx.provider.sample(timeMs);
      else if (wx.request) wx.request();
    }
    if (!weather) weather = clearWeather(timeMs);
    const wind = weather.wind, toward = (wind.dirDeg + 180) * DEG; // world axes: +x east, -z north
    return {
      timeMs, seed: frozen.seed ?? seed ?? dateSeed(timeMs),
      sun, moon, key,
      sky: { ambientLux, horizontalLux, zenithCdM2, magArcsec2: mag, bortle: bortle(mag), limitingMag: limitingMag(mag), phase: phaseOf(sTrue) },
      exposure: { ev100: frozen.ev100 ?? ev100FromIlluminance(Math.max(horizontalLux, 1e-4)), scale: 1 },
      lights: { cityFactor: frozen.lights ?? 1, windows: switchOn, street: switchOn, signs: switchOn },
      weather, wind: new Vector3(Math.sin(toward) * wind.speedMs, 0, -Math.cos(toward) * wind.speedMs), visibilityM: weather.visibilityM,
      medium: wx.provider && wx.provider.medium ? wx.provider.medium(weather) : null,
      rain: { rateMmH: 0, fallSpeedMs: 0, streakM: 0 }, wetness: { film: 0, puddles: 0 }, lightning: { flash: 0, last: null },
    };
  }

  const pinnedState = (night) => (night
    ? build(REFERENCE_NIGHT, { standInMoon: true, pinned: true })
    : build(CLASSIC_AFTERNOON, { sunAzAlt: PINNED_SUN, pinned: true }));

  const frozenTime = () => {
    if (frozen.time === undefined) return null;
    if (typeof frozen.time === 'number') return frozen.time;
    const p = parseTimeParam(frozen.time, clock.zone);
    return p && p.timeMs !== undefined ? p.timeMs : clock.timeMs;
  };

  const env = {
    /** 'pinned' or 'clock' (sections 4.2 and 5.6). */
    get mode() { return mode; },
    state: null,
    /** In the clock state: whether the Sun is more than 6 degrees down. */
    get night() { return mode === 'clock' ? !!derivedNight : !!settings.night; },
    ephemeris: { at: ephemeris.at, timeOfSunAltitude: ephemeris.timeOfSunAltitude, events: ephemeris.events },

    /** Frame step 40: rebuild the state. */
    update() {
      if (mode === 'pinned') {
        if (!env.state || env.state.pinnedNight !== !!settings.night) env.state = Object.assign(pinnedState(!!settings.night), { pinnedNight: !!settings.night });
        return env.state;
      }
      const t = frozenTime() ?? clock.timeMs;
      env.state = build(t, { sunAzAlt: frozen.sunAzAlt || null });
      const night = env.state.sun.trueAltDeg < NIGHT_BELOW_DEG;
      if (night !== derivedNight) {
        const first = derivedNight === null;
        derivedNight = night;
        if (!first || night !== settings[PINNED_NIGHT]) emit('night', night);
      }
      return env.state;
    },

    /** Enter the clock state: settings.night becomes derived from the Sun and is no longer saved. */
    enterClock() {
      if (mode === 'clock') return;
      const pinned = !!settings.night;
      mode = 'clock';
      derivedNight = null;
      Object.defineProperty(settings, PINNED_NIGHT, { value: pinned, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(settings, 'night', {
        configurable: true, enumerable: true,
        get: () => env.night,
        set: (v) => env.pin(!!v), // writing it always selects a pinned look (section 5.6)
      });
      env.update();
      emit('mode', mode);
    },

    /** Back to a pinned look (day if `night` is false): settings.night is a plain, persisted boolean again. */
    pin(night) {
      if (mode === 'pinned') { settings.night = !!night; return; }
      mode = 'pinned';
      frozen = {};
      delete settings.night;
      delete settings[PINNED_NIGHT];
      settings.night = !!night;
      derivedNight = null;
      clock.pause();
      env.state = null;
      env.update();
      emit('mode', mode);
    },

    /** Pin anything for tests and screenshots (enters the clock state). time: ISO string or ms. */
    freeze(o = {}) {
      frozen = { ...frozen, ...o };
      if (mode !== 'clock') env.enterClock();
      else env.update();
    },
    unfreeze() { frozen = {}; if (mode === 'clock') env.update(); },

    /** Phase 5: the weather provider ({ sample(t), preset(id, t), medium(sample) }, src/weather/client.js) and how to ask for it. */
    setWeather(provider) { wx.provider = provider; env.weatherChanged(); },
    setWeatherRequest(fn) { wx.request = fn; },
    /** The provider's data or settings changed: rebuild the state in the clock state, and tell 'weather' listeners. */
    weatherChanged() {
      if (mode === 'clock' && env.state) env.update();
      else if (env.state && wx.provider && wx.provider.medium) env.state.medium = wx.provider.medium(env.state.weather); // pinned: still clear
      emit('weather');
    },
    get frozen() { return { ...frozen }; },

    lights: createLightRegistry(),
    nightlights: {
      radiance: () => 0, baseRadiance: () => 0, upwardLuminance: () => 0, groundEmission: () => 0,
      texture: null, toUV: () => null, setDrawnMask() {}, setLampCells() {},
    },
    exposure: { setMeteringMask() {} },
    /** CPU query anywhere in the world (stubs until phases 5 to 7). */
    at(pos) {
      const s = env.state;
      return { rainRateMmH: 0, wetness: { film: 0, puddles: 0 }, cloudDensity: 0, inCloud: false, dustExtinctionPerM: 0,
        visibilityM: s.visibilityM, artificialLux: 0, tempC: s.weather.tempC - 0.0065 * Math.max(0, pos.y), wind: s.wind.clone() };
    },
    lightAt() {
      const s = env.state;
      return { sunLux: s.sun.illuminanceLux, sunColor: s.sun.color.clone(), moonLux: s.moon.illuminanceLux, moonColor: s.moon.color.clone(),
        ambientLux: s.sky.ambientLux };
    },
    lightning: { strikesBetween: () => [], on: () => () => {} },
    precipitation: { setShelter() {}, setIlluminators() {} },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
  };
  env.nodes = createEnvNodes(env);
  return env;
}

/** The light registry's interface (section 5.4) with plain bookkeeping; sky glow consumes it from phase 4. */
function createLightRegistry() {
  const emitters = new Map(), buildings = new Map();
  const reg = {
    version: 0,
    register(e) {
      const list = Array.isArray(e) ? e : [e];
      for (const x of list) emitters.set(x.id, x);
      reg.version++;
      return () => { for (const x of list) emitters.delete(x.id); reg.version++; };
    },
    setBuildingState(id, s) { buildings.set(id, s); reg.version++; },
    totals() {
      const byBuilding = new Map();
      let lumens = 0;
      for (const e of emitters.values()) {
        if (e.buildingId && buildings.get(e.buildingId)?.visible === false) continue;
        const lm = e.intensityCd * 4 * Math.PI;
        lumens += lm;
        if (e.buildingId) byBuilding.set(e.buildingId, (byBuilding.get(e.buildingId) || 0) + lm);
      }
      return { lumens, byBuilding };
    },
  };
  return reg;
}

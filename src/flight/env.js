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
// `standIns` lists what is stood in for, so the debug hooks and "About this flight" can say so.
import { Vector3 } from 'three';
import { createFrame } from '../world/frame.js';
import { altitudeOf } from '../core/earth.js';

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

const CLEAR_VISIBILITY_M = 80000;

/**
 * @param {object} app the app context (src/app/context.js) with what main.js adds: clock, timeline, env, pipeline,
 *   quality, loop, events, transport. Tests pass a plain object with the same members.
 */
export function createFlightEnv(app) {
  const { city, env } = app;
  const frame = createFrame(city);
  const standIns = [];
  if (!app.shadows) standIns.push('shadows');

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
     * The air at a scene position: plan 01's env.at() (temperature, wind, cloud, rain, visibility) with the height
     * above sea level, pressure and density added from the standard atmosphere. Clear and standard where plan 01 has
     * nothing to say.
     */
    at(pos) {
      const altitudeM = altitudeOf(pos, city);
      const std = standardAtmosphere(altitudeM);
      const local = env.state && typeof env.at === 'function' ? env.at(pos) : null;
      const pick = (k, fallback) => (local && local[k] !== undefined && local[k] !== null ? local[k] : fallback);
      return {
        altitudeM,
        tempC: pick('tempC', std.tempC),
        pressureHPa: std.pressureHPa,
        densityKgM3: std.densityKgM3,
        wind: pick('wind', new Vector3()),
        cloudDensity: pick('cloudDensity', 0),
        inCloud: pick('inCloud', false),
        rainRateMmH: pick('rainRateMmH', 0),
        visibilityM: pick('visibilityM', CLEAR_VISIBILITY_M),
      };
    },

    /** Begin a journey: through the transport bar when it is mounted (it shows the markers), else on the timeline. */
    attachJourney(journey) {
      return app.transport ? app.transport.attachJourney(journey) : app.timeline.begin(journey);
    },
  };
  return fe;
}

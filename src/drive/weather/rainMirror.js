// Rain's rules (plan 02, phase 8) in JavaScript: where each drawn drop is at a simulation time, how fast drops fall
// and drift, what a streak's light is, and the rain seen from the car (for the windshield's follow-up, D8.2). Pure:
// no three.js, no DOM. rain.js computes the same per vertex, fed from here.
//
// Drops. A cube of side BOX_M around a point a little ahead of the eye, tiled through the world: drop i has a fixed
// base position (a hash of i) and moves with its class's velocity (wind plus its fall speed), so its place is
//   local = mod(base x BOX_M + v_class x t - centre, BOX_M) - BOX_M / 2       (t: simulation seconds)
// a pure function of simulation time, anchored to the world (driving through it gives the right relative motion; a
// paused frame holds still and scrubbing repeats). The products v x t are taken modulo BOX_M on the CPU in double
// precision (rainOffsets), so the GPU only ever sees small numbers.
// Streaks. Each drop is drawn as the path it covers relative to the camera during SHUTTER_S of simulation time (times
// the rate up to 4x), which at 60 frames a second joins one frame's streak to the next: the rain moves smoothly and
// never strobes at the frame rate.
// Numbers:
//  fall speed    Atlas, Srivastava and Sekhon (Rev. Geophys. 1973): v(D) = 9.65 - 10.3 exp(-0.6 D) m/s, D in mm,
//                for the four classes CLASS_MM (0.8, 1.2, 1.8, 2.6 mm: 3.3, 4.6, 6.2, 7.5 m/s).
//  how many      Marshall and Palmer (J. Meteor. 1948), N(D) = 8000 exp(-Lambda D) m^-3 mm^-1, Lambda = 4.1 R^-0.21:
//                the drawn count follows their number of drops over 1 mm (about R^0.9), DROPS_AT_1MM at 1 mm/h
//                (ASSUMED: what reads as light rain in a 24 m cube), at most MAX_DROPS.
//  wind          drops drift with the wind (from windFromDeg, at windMps).
//  light         a drop sends back toward a lamp beside the eye about BACKSCATTER of what it intercepts per steradian
//                (ASSUMED); by day it shows the brighter sky above against the horizon behind it, DAY_CONTRAST of the
//                sky's radiance over its own small solid angle (ASSUMED). Both are then raised by STREAK_GAIN: a
//                real drop crossing a pixel in a fraction of a frame is barely seen by a camera, while the eye does
//                see rain (ASSUMED, set by eye).

export const BOX_M = 24;
/** The cube's centre is this far ahead of the eye (m), along the view. */
export const AHEAD_M = 7;
export const CLASS_MM = Object.freeze([0.8, 1.2, 1.8, 2.6]);
export const fallSpeed = (dMm) => 9.65 - 10.3 * Math.exp(-0.6 * dMm);
export const CLASS_SPEED = Object.freeze(CLASS_MM.map(fallSpeed));
export const DROPS_AT_1MM = 1400;
export const MAX_DROPS = 12000;
export const SHUTTER_S = 1 / 60;
export const BACKSCATTER = 0.08;
export const DAY_CONTRAST = 0.5;
export const STREAK_GAIN = 20;

/** Marshall-Palmer drops per cubic metre with a diameter over dMm, at R mm/h. */
export function dropsOver(R, dMm = 1) {
  if (!(R > 0)) return 0;
  const lambda = 4.1 * R ** -0.21;
  return (8000 / lambda) * Math.exp(-lambda * dMm);
}

/** How many drops to draw at R mm/h. */
export function dropCount(R) {
  if (!(R > 0)) return 0;
  return Math.min(MAX_DROPS, Math.round((DROPS_AT_1MM * dropsOver(R)) / dropsOver(1)));
}

/** The wind as a scene velocity (x east, y up, z south), m/s, for a wind from `fromDeg` (clockwise from north). */
export function windVector(windMps, fromDeg) {
  const toward = ((fromDeg + 180) * Math.PI) / 180;
  return [windMps * Math.sin(toward), 0, -windMps * Math.cos(toward)];
}

/** The velocity of class c's drops in the scene (m/s). */
export function dropVelocity(state, c) {
  const w = windVector(state.windMps ?? state.windSpeed ?? 0, state.windFromDeg ?? 0);
  return [w[0], -CLASS_SPEED[c], w[2]];
}

/** A deterministic hash of an integer to [0, 1) (mulberry32's mix). */
export function hash01(n) {
  let t = (n + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Drop i's seed: base position in [0, 1)^3 and its class's slot (w: class + jitter, in [0, 1)). */
export function dropSeed(i) {
  return [hash01(4 * i), hash01(4 * i + 1), hash01(4 * i + 2), hash01(4 * i + 3)];
}

const mod = (a, m) => ((a % m) + m) % m;

/**
 * Per class, the term (v_class x t - centre) modulo BOX_M, in double precision: the shader adds base x BOX_M to it
 * and takes the modulus again. centre is the cube's centre in the scene.
 * @returns {number[][]} four [x, y, z]
 */
export function rainOffsets(simMs, state, centre, box = BOX_M) {
  const t = simMs / 1000;
  return CLASS_MM.map((_, c) => {
    const v = dropVelocity(state, c);
    return [0, 1, 2].map((k) => mod(mod(v[k] * t, box) - mod(centre[k], box), box));
  });
}

/** Drop i's position relative to the cube's centre (as the shader computes it). */
export function dropLocal(seed, offsets, box = BOX_M) {
  const c = Math.min(3, Math.floor(seed[3] * 4));
  return [0, 1, 2].map((k) => mod(seed[k] * box + offsets[c][k], box) - box / 2);
}

/**
 * Every drawn drop's scene position at a simulation time, for tests: { positions: Float64Array(3n), count }.
 * @param {{ simMs: number, state: object, centre: number[], count?: number }} o
 */
export function dropPositions({ simMs, state, centre, count = dropCount(state.precipMmPerHour) }) {
  const off = rainOffsets(simMs, state, centre);
  const positions = new Float64Array(3 * count);
  for (let i = 0; i < count; i++) {
    const l = dropLocal(dropSeed(i), off);
    positions[3 * i] = centre[0] + l[0]; positions[3 * i + 1] = centre[1] + l[1]; positions[3 * i + 2] = centre[2] + l[2];
  }
  return { positions, count };
}

/** The streak's shutter in simulation seconds at a clock rate. */
export const shutterAt = (rate = 1) => SHUTTER_S * Math.min(4, Math.max(1, rate || 1));

/**
 * The rain seen from the car, for the windshield (D8.2): the drops' velocity relative to the car in the car's frame
 * (x right, y up, z forward; m/s), for the mass-weighted class (1.8 mm), and the water's volume flux.
 * @param {object} state env.weather.state()
 * @param {{ forward: {x,y,z}, right: {x,y,z}, up: {x,y,z}, speed: number }} pose  pose.speed in m/s
 * @returns {{ raining: boolean, velocityCar: number[], speedMps: number, fallMps: number, rateMmPerHour: number,
 *   volumeFlux: number }} volumeFlux: m^3 of water per m^2 of horizontal area per second (R / 3.6e6)
 */
export function relativeRain(state, pose) {
  const R = state?.precipMmPerHour || 0;
  const v = dropVelocity(state || {}, 2);
  const f = pose.forward, r = pose.right, u = pose.up, s = pose.speed || 0;
  const rel = [v[0] - f.x * s, v[1] - f.y * s, v[2] - f.z * s];
  const dot = (a, b) => a[0] * b.x + a[1] * b.y + a[2] * b.z;
  const velocityCar = [dot(rel, r), dot(rel, u), dot(rel, f)];
  return { raining: R > 0, velocityCar, speedMps: Math.hypot(...rel), fallMps: CLASS_SPEED[2], rateMmPerHour: R, volumeFlux: R / 3.6e6 };
}

/**
 * The visitor's low beam, as the rain and the spray need it: a smooth lobe close to beam.js's low-beam map (peak
 * LOW_PEAK_CD per lamp 2 degrees right and 1.75 down, a sharp top edge, about 14 degrees of half spread across),
 * as a share of the peak. c: the direction in the car frame (x right, y up, z forward).
 */
export const LOW_PEAK_CD = 22832;
export function lowBeamShare(c) {
  if (!(c[2] > 0)) return 0;
  const h = (Math.atan2(c[0], c[2]) * 180) / Math.PI;
  const v = (Math.atan2(c[1], Math.hypot(c[0], c[2])) * 180) / Math.PI;
  const dv = v + 1.75;
  return Math.exp(-(((h - 2) / 14) ** 2)) * Math.exp(-((dv / (dv < 0 ? 4.5 : 1)) ** 2));
}

/**
 * A streak's summed light at the eye (cd/m^2 x the light scale x pixel solid angle: divide by the pixel angle squared
 * for the sum of its pixel values), as the shader computes it.
 * @param {{ dMm: number, distanceM: number, lampLux: number, skyRadiance: number, units: number }} o
 *   lampLux: illuminance on the drop from the lamps (lux); skyRadiance: the sky's (cd/m^2 x the light scale); units: the
 *   light scale of a lux
 */
export function streakLight({ dMm, distanceM, lampLux, skyRadiance, units }) {
  const A = Math.PI * (dMm / 2000) ** 2;
  const night = (lampLux * A * BACKSCATTER * units) / (distanceM * distanceM);
  const day = (skyRadiance * DAY_CONTRAST * A) / (distanceM * distanceM);
  return STREAK_GAIN * (night + day);
}

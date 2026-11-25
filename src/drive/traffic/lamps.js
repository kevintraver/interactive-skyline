// Vehicle lamps: photometry and switching (plan 02, D6.4 and section 7.7). Pure: no three.js. The light-sprite
// layer (lampLayer.js) draws each lamp with these intensities and patterns; the light ribbons (ribbon.js and its
// shader) use the same numbers per vehicle, and ribbonMirror() below is their arithmetic in JavaScript.
//
// Intensities, candela per lamp toward its axis, and their sources (FMVSS 108, 49 CFR 571.108, 2023 edition,
// read from the govinfo PDF of the plan's reference C6; the tables are images in it):
//   tail lamp   6 cd   Table VIII (taillamp), one lighted section: at least 2.0 cd at H-V, 0.8 at 10 deg left and
//                      right, 0.3 at 20 deg and 5 up/down; at most 18 cd. 6 is a typical design value inside that.
//   stop lamp   120 cd Table IX (stop lamp), one lighted section: at least 80 cd at H-V (40 at 10 deg, 10 at 20 deg),
//                      at most 300 cd; and at least 5 times the tail lamp at H-V (120 / 6 = 20). Drawn as a second
//                      sprite on the tail lamp, so the lens shows 126 cd while the vehicle brakes.
//   high stop   60 cd  the centre high-mounted stop lamp, Table XV: 25 cd at least and 160 at most AS RECALLED
//                      (that table was not legible in the copy read); 60 is inside either way.
//   markers     amber 1.5 cd, red 1.0 cd: side marker lamps (Table X) and clearance and identification lamps
//                      (Table XI) need at least 0.62 cd amber and 0.25 cd red at 10U, H, 10D by 45L, V, 45R; red ones
//                      combined with a stop lamp at most 15 cd. Trucks and coaches carry them (vehicles.json).
//   head lamp   800 cd toward an eye above the cut-off, as an oncoming driver's or a follower's: Table XIX-a (lower
//                      beam LB1V) allows at most 700 cd at 1U 1.5L-L and 1,000 cd at 0.5U 1.5L-L; the hot spot
//                      (15,000 cd and more, 1.5D 2R) is below the eye and lights the road, not the viewer (the pools
//                      in pools.js carry it). Bright, never white-out: the sprite's tone keeps the core small.
// Patterns: a lobe cos^n around the lamp's facing (sprites.js kind 'lobe'). Tail and stop n = 4 (Table VIII's
// minimum ratios fall to 40% at 10 deg; real lamps are much wider: the visibility option of Table V-c still asks
// 0.05 cd at 80 deg); high stop n = 6; head n = 6 (a low beam's light toward eye height falls off steeply
// outside +-20 deg); markers n = 1 (the same minimum at 45 deg as at 0).
//
// Switching. Each vehicle switches its lamps on below an ambient illuminance of its own (a hash of its id,
// log-logistic around VEHICLE_SWITCH.midLux): drivers and automatic headlamps switch on around sunset, well before
// street lamps' photocells (16 lux, lights/switching.js), so the traffic lights up first and over several minutes.
// The sprite shader compares each lamp's threshold with the ambient illuminance (sprites.js `threshold`).

import * as H from './hash.js';

const { hash32, unit } = H; // local bindings (see demand.js)

/** Candela per lamp toward its axis (see the header). */
export const LAMP_CD = Object.freeze({ head: 800, tail: 6, stop: 120, chmsl: 60, amber: 1.5, red: 1.0 });
/** Lobe exponents (cos^n around the facing). */
export const LOBE = Object.freeze({ head: 6, tail: 4, stop: 4, chmsl: 6, marker: 1 });
/** Luminous openings, metres (the sprite's size up close). */
export const LENS_M = Object.freeze({ head: 0.18, tail: 0.14, chmsl: 0.1, marker: 0.06 });

/** Linear sRGB at luminance 1 (sprites.js colour convention). */
const lum1 = (r, g, b) => { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return Object.freeze([r / y, g / y, b / y]); };
export const LAMP_RGB = Object.freeze({
  white: lum1(1, 0.94, 0.82), // a warm-white LED or halogen low beam
  red: lum1(1, 0.02, 0.008), // SAE red (x 0.69, y 0.31 or so)
  amber: lum1(1, 0.3, 0.0), // SAE amber
});

/** When vehicles switch their lamps on: log-logistic thresholds (lux). ASSUMED: half the vehicles by 400 lux
 * (the sun about 1 degree up), 80% between about 130 and 1,250 lux. */
export const VEHICLE_SWITCH = Object.freeze({ midLux: 400, spread: 0.55 });

/** The ambient illuminance (lux) below which vehicle `id` (fleet.js id) has its lamps on. */
export function vehicleThresholdLux(id) {
  const u = Math.min(1 - 1e-4, Math.max(1e-4, unit(hash32(id, 0x1a37))));
  return VEHICLE_SWITCH.midLux * (u / (1 - u)) ** VEHICLE_SWITCH.spread;
}
/** Share of vehicles with lamps on at an ambient illuminance (lux). */
export function vehicleLitShare(ambient) {
  if (!(ambient > 0)) return 1;
  return 1 / (1 + (ambient / VEHICLE_SWITCH.midLux) ** (1 / VEHICLE_SWITCH.spread));
}

/** Intensity (cd) of one lamp of a kind toward a direction at cos c to its facing. */
export function lampIntensity(kind, c) {
  if (!(c > 0)) return 0;
  switch (kind) {
    case 'head': return LAMP_CD.head * c ** LOBE.head;
    case 'tail': return LAMP_CD.tail * c ** LOBE.tail;
    case 'stop': return LAMP_CD.stop * c ** LOBE.stop;
    case 'chmsl': return LAMP_CD.chmsl * c ** LOBE.chmsl;
    case 'amber': return LAMP_CD.amber * c ** LOBE.marker;
    case 'red': return LAMP_CD.red * c ** LOBE.marker;
    default: return 0;
  }
}

/** Front-facing amber and rear-facing red marker lamps of a truck or coach (clearance and identification). */
export const TRUCK_MARKERS = 5;

/**
 * A vehicle's light toward a direction at cos c to its direction of travel, as the ribbons count it: the head
 * lamp pair from ahead, the tail lamp pair from behind, a truck's front and rear clearance and identification
 * lamps weighted by the truck share; side markers are left out (seen along the road they are edge on).
 * @returns {[number, number, number]} candela of white, red and amber light
 */
export function vehicleIntensity(c, truckShare = 0) {
  const f = c > 0 ? c : 0, b = c < 0 ? -c : 0;
  return [
    2 * LAMP_CD.head * f ** LOBE.head,
    2 * LAMP_CD.tail * b ** LOBE.tail + truckShare * TRUCK_MARKERS * LAMP_CD.red * b ** LOBE.marker,
    truckShare * TRUCK_MARKERS * LAMP_CD.amber * f ** LOBE.marker,
  ];
}

/** Scene radiance per unit of (cd/m^2 x gain) for each of the three lights: their colours. */
export function rgbOf([w, r, a], out = [0, 0, 0]) {
  for (let c = 0; c < 3; c++) out[c] = w * LAMP_RGB.white[c] + r * LAMP_RGB.red[c] + a * LAMP_RGB.amber[c];
  return out;
}

/**
 * The ribbon's arithmetic (ribbon.js), for tests: the illuminance (lux) at the eye from a stretch of one
 * lane of length ds at distance d, with density lambda (veh/m), seen at cos c to the direction of travel, through
 * visibility V. It is the sum of the vehicles' point sources: lambda ds I(c) T / d^2. The shader spreads it over
 * the strip's pixels (radiance = E / (pixels x pixel solid angle)), so the summed light is this either way.
 * @returns {[number, number, number]} lux of white, red and amber
 */
export function ribbonIlluminance({ lambda, ds, d, c, truckShare = 0, visibilityM = Infinity }) {
  const T = Math.exp(-d / visibilityM);
  const I = vehicleIntensity(c, truckShare);
  const k = (lambda * ds * T) / (d * d);
  return [I[0] * k, I[1] * k, I[2] * k];
}

/**
 * Weight of the sprites (1) against the ribbons (0) for a vehicle at route distance ds from the car (ahead > 0):
 * 1 within the sprite range less its band, falling smoothly to 0 at the range's end. The ribbon shader uses
 * 1 minus this, so the two always sum to one.
 */
export function spriteWeight(ds, ahead, behind, band) {
  const R = ds >= 0 ? ahead : behind;
  const B = band * R;
  const x = ((ds >= 0 ? ds : -ds) - (R - B)) / B;
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return 1 - t * t * (3 - 2 * t);
}

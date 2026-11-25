// The car's body and the driver's head (plan 02, section 5.7, layers 2 and 3), as pure functions of the
// journey, chainage s and simulation time. Nothing here is integrated frame by frame: where something lags
// (the body's roll after a lateral acceleration, the head after the body), the lag is a convolution of the
// accelerations at a fixed set of past instants of simulation time with the impulse response of a damped
// spring, so the same moment always gives the same motion, scrubbed forwards, backwards or arrived at by a seek.
//
// Cabin coordinates throughout (cabin.json): +X right, +Y up, +Z back (the car faces -Z), origin on the road
// under the driver's eye.

import { createRefline } from '../roadnet/refline.js';

export const G = 9.81;
const RAD = Math.PI / 180;
const TAU = 2 * Math.PI;

/**
 * Every constant of the motion model, with its source. "Assumed" means chosen for a mid-size crossover within
 * the usual range, not measured.
 */
export const MOTION = Object.freeze({
  /** Body roll per g of lateral specific force: passenger cars 3-7 deg/g (Gillespie, Fundamentals of Vehicle Dynamics, ch. 8); 5 assumed. */
  rollPerG: 5 * RAD,
  /** Body pitch per g of longitudinal acceleration (squat and dive): assumed 2 deg/g. */
  pitchPerG: 2 * RAD,
  /** The body's roll and pitch mode, which lags the accelerations: 1-2 Hz body bounce (plan section 7.6, [G9]); 1.5 Hz, damping 0.5 assumed. */
  body: { hz: 1.5, zeta: 0.5 },
  /** The head on the neck, lagging the body: lightly sprung, assumed 1.2 Hz with damping 0.35. */
  head: { hz: 1.2, zeta: 0.35 },
  /** Head travel against the body per m/s^2 (sideways in a curve, back when speeding up): assumed 12 and 10 mm. */
  headSway: 0.012,
  headSurge: 0.010,
  /** Share of the body's vertical bounce at the eye that the neck lets lag: assumed 0.5. */
  headHeave: 0.5,
  /** The lag kernel: past instants every dt seconds, n of them (1 s, a few time constants of both springs). */
  kernel: { dt: 0.05, n: 20 },
  /** Axles in cabin z (front 2.0 m ahead of the eye, rear 0.7 m behind): a 2.7 m wheelbase, typical of a crossover; assumed. */
  frontAxle: -2.0,
  rearAxle: 0.7,
  /** Roll and pitch centre in cabin coordinates: the car's centre line (cabin.json carCenterX), 0.5 m up, between the axles. */
  pivot: [0.37, 0.5, -0.65],
  /** Steering ratio, road wheel to steering wheel: 15:1, typical of passenger cars; assumed. */
  steeringRatio: 15,
  /**
   * Road roughness as the body feels it: [wavelength m, amplitude m, phase rad]. The wavelengths put the
   * energy near body bounce (1-2.5 Hz) at highway speed, with a trace near wheel hop (about 12 Hz at
   * 70 mph) [G9]; amplitudes chosen so the head's vertical acceleration stays near 0.2 m/s^2 RMS at 70 mph
   * (the plan's limit is 0.5). Assumed.
   */
  road: [[41, 0.0015, 0.3], [31, 0.0025, 2.1], [23, 0.002, 4.0], [17, 0.001, 1.2], [13, 0.0006, 5.3], [2.6, 0.00002, 0.7]],
  /** A bridge joint, felt by each axle in turn: a body bounce and a short wheel-hop rattle. Assumed. */
  joint: { body: 0.006, hz: 1.5, zeta: 0.35, hop: 0.0005, hopHz: 12, hopZeta: 0.3, seconds: 2.5 },
});

/** Weights of the discretised impulse response of a damped spring at the kernel's instants, summing to 1. */
export function lagKernel({ hz, zeta }, { dt, n } = MOTION.kernel) {
  const w0 = TAU * hz, wd = w0 * Math.sqrt(1 - zeta * zeta);
  const out = new Float64Array(n);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    // the response is sampled at the middle of each step, so the first weight is not zero
    const t = (k + 0.5) * dt;
    out[k] = Math.exp(-zeta * w0 * t) * Math.sin(wd * t);
    sum += out[k];
  }
  for (let k = 0; k < n; k++) out[k] /= sum;
  return out;
}
const BODY_K = lagKernel(MOTION.body);
const HEAD_K = lagKernel(MOTION.head);

/** The road's height texture at s, metres. */
export function roadProfile(s) {
  let z = 0;
  for (const [l, a, p] of MOTION.road) z += a * Math.sin((TAU * s) / l + p);
  return z;
}

/** Bridge joints along a road: both ends of every bridge, sorted. */
export function jointsOf(road) {
  const out = [];
  for (const b of road?.bridges || []) out.push(b.s0, b.s1);
  return out.sort((a, b) => a - b);
}

/** Response of one axle to the joints it has crossed, at chainage s and speed v. */
export function jointBump(s, v, joints) {
  if (!joints.length || !(v > 0.1)) return 0;
  const J = MOTION.joint;
  const reach = v * J.seconds;
  // the last joint at or behind s
  let lo = 0, hi = joints.length - 1;
  if (joints[0] > s) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (joints[m] <= s) lo = m; else hi = m - 1; }
  const wb = TAU * J.hz, wh = TAU * J.hopHz;
  let z = 0;
  for (let i = lo; i >= 0 && s - joints[i] < reach; i--) {
    const t = (s - joints[i]) / v;
    z += J.body * Math.exp(-J.zeta * wb * t) * Math.sin(wb * t) + J.hop * Math.exp(-J.hopZeta * wh * t) * Math.sin(wh * t);
  }
  return z;
}

/**
 * The body's texture from the road at the eye's chainage s: heave of the roll centre (metres, up) and pitch
 * (radians, nose up), from what the front and rear axles ride over.
 */
export function bodyTexture(s, v, joints) {
  const sf = s - MOTION.frontAxle, sr = s - MOTION.rearAxle; // the front axle is ahead: larger s
  const zf = roadProfile(sf) + jointBump(sf, v, joints);
  const zr = roadProfile(sr) + jointBump(sr, v, joints);
  const L = MOTION.rearAxle - MOTION.frontAxle;
  return { heave: (zf + zr) / 2, pitch: (zf - zr) / L };
}

const helpers = new WeakMap();
/** Per-journey lookups the samples need: the reference line, the joints, the lane changes, the moving window. */
function helperOf(journey) {
  let h = helpers.get(journey);
  if (!h) {
    const refline = createRefline(journey.road);
    const changes = (journey.lanePlan || []).filter((e) => e.s1 > e.s0);
    h = { refline, joints: jointsOf(journey.road), changes, r: {} };
    helpers.set(journey, h);
  }
  return h;
}

/** Curvature of the car's path at s: the road's plus the lateral easing of a lane change (1/m, positive left). */
export function pathCurvature(journey, s) {
  const h = helperOf(journey);
  let k = h.refline.at(s, h.r).curvature;
  for (const e of h.changes) {
    if (s > e.s0 - 1 && s < e.s1 + 1) {
      const d = 0.5;
      k += (journey.offsetAt(s + d) - 2 * journey.offsetAt(s) + journey.offsetAt(s - d)) / (d * d);
      break;
    }
  }
  return k;
}

/**
 * The car at one instant of simulation time: chainage, speed, longitudinal acceleration, and the lateral
 * specific force to the left (speed squared times the path's curvature, less the crossfall's share of gravity).
 */
export function sampleAt(journey, simMs) {
  const h = helperOf(journey);
  const s = journey.sAt(simMs);
  const tA = journey.timeAt(journey.s0), tB = journey.timeAt(journey.s1);
  const moving = simMs >= tA && simMs <= tB;
  const v = moving ? journey.speedAt(s) : 0;
  const a = moving ? journey.profile.accelOf(s) : 0;
  const crossfall = h.refline.at(s, h.r).crossfall;
  const lat = v * v * pathCurvature(journey, s) + G * crossfall;
  return { s, v, a, lat };
}

const ZERO = Object.freeze({ heave: 0, pitch: 0, roll: 0, head: Object.freeze([0, 0, 0]), lat: 0, along: 0 });
export const NO_MOTION = ZERO;

/**
 * Body and head at a simulation time, relative to the car's frame on the road.
 * @returns {{ heave: number, pitch: number, roll: number, head: number[], lat: number, along: number }}
 *   heave (m, up) of the roll centre; pitch (rad, nose up) and roll (rad, right side down) about the roll
 *   centre (MOTION.pivot); head [x, y, z] the head's offset from where the body carries it, cabin metres;
 *   lat and along the lagged accelerations the body felt, m/s^2
 */
export function motionAt(journey, simMs) {
  if (!journey || !Number.isFinite(simMs)) return ZERO;
  const { joints } = helperOf(journey);
  const { dt, n } = MOTION.kernel;
  const back = -MOTION.pivot[2]; // the eye is this far behind the pitch centre: nose up lowers it
  let bLat = 0, bAlong = 0, hLat = 0, hAlong = 0, hEye = 0;
  // the body's accelerations, lagged by the body's own mode; the head's by the neck's
  for (let k = 0; k < n; k++) {
    const x = sampleAt(journey, simMs - (k + 0.5) * dt * 1000);
    bLat += BODY_K[k] * x.lat; bAlong += BODY_K[k] * x.a;
    hLat += HEAD_K[k] * x.lat; hAlong += HEAD_K[k] * x.a;
    const tex = bodyTexture(x.s, x.v, joints);
    hEye += HEAD_K[k] * (tex.heave - back * tex.pitch); // the eye's height change from the road at that instant
  }
  const now = sampleAt(journey, simMs);
  const tex = bodyTexture(now.s, now.v, joints);
  const eye = tex.heave - back * tex.pitch;
  return {
    heave: tex.heave,
    pitch: tex.pitch + (MOTION.pitchPerG * bAlong) / G,
    roll: (MOTION.rollPerG * bLat) / G,
    head: [MOTION.headSway * hLat, MOTION.headHeave * (hEye - eye), MOTION.headSurge * hAlong],
    lat: bLat, along: bAlong,
  };
}

/** Steering wheel angle (radians, positive anticlockwise as the driver sees it: a left turn) for the path at s. */
export function wheelAngle(journey, s) {
  if (!journey) return 0;
  const L = MOTION.rearAxle - MOTION.frontAxle;
  return MOTION.steeringRatio * Math.atan(L * pathCurvature(journey, s));
}

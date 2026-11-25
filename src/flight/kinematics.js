// Where "level" is for an aircraft, its attitude on that level, and the coordinated-turn relations (plan 03, sections
// 5.5 and 7.1). Pure: no scene state.
//
// Scene axes: x east, y up, z south. Body axes: nose -Z, right wing +X, up +Y. Heading is clockwise from grid north,
// pitch is nose up positive, roll is right wing down positive; all in radians. They are applied on the level frame at
// the aircraft's position (the curved datum), not on the XZ plane: 250 km from the origin the two differ by 1.9 degrees,
// and the horizon would be that far off at the start of every flight.
import { Quaternion, Vector3 } from 'three';
import { levelQuaternion } from '../world/frame.js';

/** Standard gravity, m/s^2. */
export const G = 9.80665;

/**
 * The level frame at scene (x, z): unit east, up and north vectors in scene axes. Up is localUp; north is grid north
 * made level.
 * @returns {{ east: Vector3, up: Vector3, north: Vector3 }}
 */
export function levelBasis(x, z, out = { east: new Vector3(), up: new Vector3(), north: new Vector3() }) {
  const q = levelQuaternion(x, z, scratch.level);
  out.east.set(1, 0, 0).applyQuaternion(q);
  out.up.set(0, 1, 0).applyQuaternion(q);
  out.north.set(0, 0, -1).applyQuaternion(q);
  return out;
}

const scratch = { level: new Quaternion(), a: new Quaternion() };
const Y = new Vector3(0, 1, 0), X = new Vector3(1, 0, 0), Z = new Vector3(0, 0, 1);

/**
 * Body -> scene rotation for an aircraft at scene (x, z) with this heading, pitch and roll (radians).
 * Yaw about up (clockwise seen from above, so a negative turn about +Y), then pitch about the right wing, then roll
 * about the longitudinal axis (right wing down, so a negative turn about +Z, the tail-pointing axis).
 * @param {Quaternion} [out]
 */
export function bodyQuaternion(x, z, heading, pitch, roll, out = new Quaternion()) {
  levelQuaternion(x, z, out);
  out.multiply(scratch.a.setFromAxisAngle(Y, -heading));
  out.multiply(scratch.a.setFromAxisAngle(X, pitch));
  out.multiply(scratch.a.setFromAxisAngle(Z, -roll));
  return out;
}

// Coordinated turns: the lift tilts with the bank and its horizontal part turns the flight path, so
// tan(bank) = V * turnRate / g and the radius is V / turnRate. A left turn is a negative rate and a negative bank.

/** Bank (rad) for a turn rate (rad/s, positive clockwise) at true airspeed v (m/s). */
export const bankForTurnRate = (v, turnRate) => Math.atan((v * turnRate) / G);
/** Turn rate (rad/s) for a bank (rad) at true airspeed v. */
export const turnRateForBank = (v, bank) => (v > 0 ? (G * Math.tan(bank)) / v : 0);
/** Radius (m) of a coordinated turn at true airspeed v and this bank; Infinity when level. */
export const turnRadius = (v, bank) => (bank === 0 ? Infinity : (v * v) / (G * Math.tan(Math.abs(bank))));
/** Bank (rad, magnitude) to fly a circle of this radius at true airspeed v. */
export const bankForRadius = (v, radius) => Math.atan((v * v) / (G * radius));
/** Load factor n (g) in a level coordinated turn at this bank. */
export const loadFactor = (bank) => 1 / Math.cos(bank);

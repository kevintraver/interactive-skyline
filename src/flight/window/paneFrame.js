// What the pane's shader is given each frame, as pure functions (plan 03, sections 7.5 and 7.7; F5.4 to F5.7).
//
// Pane coordinates: (u, v) on the pane's surface in metres, u aft (body +z) and v up along the ring (toward the
// crown), the same on both sides of the cabin. The outward normal is paneNormal(side).
//
// Time (7.5): the pane's condition (frost, fog, water) is the journey's and comes in as `pane` (paneState.at(t)).
// Everything that moves or flickers on the pane (drops running, their jitter, the sparkle of frost) runs on
// presentation time, `wallS` (the wall clock while playing, frozen while paused), and stands still under reduced
// motion: timeS is then a constant, so the picture does not change while nothing else does. Nothing on the pane
// flashes: glints follow the sun's and the head's slow motion, never a clock.

import { Vector3, Quaternion } from 'three';
import { FUSELAGE, WINDOW } from '../aircraft/dimensions.js';

/** The ring angle of the windows' centre line, radians above the line of max breadth. */
export const RING = Math.asin((FUSELAGE.floorAtWing + WINDOW.centreAboveFloor - FUSELAGE.axisY) / FUSELAGE.trimRadius);

/** Drops on the outer face. ESTIMATED: no measurement of drops on an airliner window in flight was found (7.7). */
export const DROPS = Object.freeze({
  /** Drops start to move with the air at about this airspeed, m/s (car side glass and acrylic plates [R3]: 15 to 25). */
  onsetMs: 20,
  /** Running speed on the glass per m/s of airspeed above the onset, and its ceiling, m/s (tuned against footage). */
  perMs: 0.012, maxSpeed: 1.2,
  /** Slow sliding under gravity alone, m/s. */
  gravitySpeed: 0.02,
  /** Airspeed at which the air's drag on a millimetre drop equals its weight, m/s (drag 1/2 rho V^2 Cd A against
   * rho_w 4/3 pi r^3 g: about 6 m/s). Below the onset the drop is pinned to the glass and the air moves it little. */
  balanceMs: 6,
});

const G = 9.80665;

/** The pane's outward unit normal in body axes for a side ('right' +x, 'left' -x). */
export function paneNormal(side, out = new Vector3()) {
  const s = side === 'left' ? -1 : 1;
  return out.set(s * Math.cos(RING), Math.sin(RING), 0);
}
/** The pane's "up" tangent (toward the crown along the ring) in body axes. */
function paneUp(side, out) {
  const s = side === 'left' ? -1 : 1;
  return out.set(-s * Math.sin(RING), Math.cos(RING), 0);
}

const _q = new Quaternion(), _a = new Vector3(), _g = new Vector3(), _up = new Vector3();

/**
 * Where water runs on the outer face: { u, v } a unit direction in pane coordinates and `speed` in m/s. The air's
 * velocity past the skin, projected into the pane's plane, mixed with gravity's by dynamic pressure: drops sit until
 * the air is fast enough for their size, then run aft (and up at a positive angle of attack); taxiing they run down.
 * @param {{ quaternion: Quaternion, airVelocity: Vector3, tas?: number, densityKgM3?: number }} state
 * @param {'left' | 'right'} side
 */
export function dropFlow(state, side, out = { u: 0, v: -1, speed: 0 }) {
  _q.copy(state.quaternion).invert();
  // the air relative to the aircraft, in body axes
  _a.copy(state.airVelocity).multiplyScalar(-1).applyQuaternion(_q);
  _g.set(0, -G, 0).applyQuaternion(_q);
  paneUp(side, _up);
  const fu = _a.z, fv = _a.dot(_up);
  const gu = _g.z, gv = _g.dot(_up);
  const V = Math.hypot(fu, fv);
  const rho = Number.isFinite(state.densityKgM3) ? state.densityKgM3 : 1.2;
  // the air's push, held back below the onset (pinning), against gravity's
  const q = 0.5 * rho * V * V, q0 = 0.5 * 1.2 * DROPS.onsetMs * DROPS.onsetMs, qg = 0.5 * 1.2 * DROPS.balanceMs * DROPS.balanceMs;
  const push = (q * q) / (q + q0);
  const w = push / (push + qg);
  const gl = Math.hypot(gu, gv) || 1;
  let u = (V > 1e-9 ? (w * fu) / V : 0) + ((1 - w) * gu) / gl;
  let v = (V > 1e-9 ? (w * fv) / V : 0) + ((1 - w) * gv) / gl;
  const n = Math.hypot(u, v);
  if (n < 1e-9) { u = 0; v = -1; } else { u /= n; v /= n; }
  out.u = u;
  out.v = v;
  out.speed = Math.min(DROPS.maxSpeed, DROPS.gravitySpeed * (1 - w) + DROPS.perMs * Math.max(0, V - DROPS.onsetMs));
  return out;
}

/** The sun reaches the outer pane: 0 edge-on or from behind, rising smoothly over the first 0.1 of its cosine. */
export function sunOnPane(cosOut) {
  const t = Math.min(1, Math.max(0, cosOut / 0.1));
  return t * t * (3 - 2 * t);
}

const _n = new Vector3();
const on = (effects, k) => !effects || effects[k] !== false;
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * This frame's values for the pane's shader.
 * @param {{ state: { quaternion: Quaternion, airVelocity: Vector3 }, pane: { frost: number, fog: number, wet: number,
 *   mist: number, rainRateMmH: number }, side: 'left' | 'right', sun?: { dir: Vector3, illuminanceLux: number },
 *   exposure?: number, wallS?: number, cabinLight?: number, reducedMotion?: boolean,
 *   effects?: { frost?: boolean, condensation?: boolean, droplets?: boolean, scratches?: boolean, reflections?: boolean,
 *   transmission?: boolean }, ambientLux?: number }} o  ambientLux: the outside's diffuse illuminance on the pane
 */
export function paneFrame({ state, pane, side, sun = null, exposure = 1, wallS = 0, cabinLight = 1, reducedMotion = false, effects = null, ambientLux = 0 }) {
  const flow = dropFlow(state, side);
  const sunBody = new Vector3(0, -1, 0);
  let sunE = 0;
  if (sun && sun.dir && sun.illuminanceLux > 0) {
    sunBody.copy(sun.dir).applyQuaternion(_q.copy(state.quaternion).invert()).normalize();
    sunE = sun.illuminanceLux * exposure * sunOnPane(sunBody.dot(paneNormal(side, _n)));
  }
  const droplets = on(effects, 'droplets');
  return {
    timeS: reducedMotion ? 0 : (Number.isFinite(wallS) ? wallS : 0),
    flow,
    sunBody,
    sunE,
    frost: on(effects, 'frost') ? clamp01(pane.frost) : 0,
    fog: on(effects, 'condensation') ? clamp01(pane.fog) : 0,
    wet: droplets ? clamp01(pane.wet) : 0,
    mist: droplets ? clamp01(pane.mist) : 0,
    rainRateMmH: droplets ? Math.max(0, pane.rainRateMmH || 0) : 0,
    scratches: on(effects, 'scratches') ? 1 : 0,
    reflection: on(effects, 'reflections') ? clamp01(cabinLight) : 0,
    transmission: on(effects, 'transmission') ? 1 : 0,
    /** The outside's diffuse light at the pane, buffer units: what frost and fog scatter at least. */
    ambient: Math.max(0, ambientLux || 0) / Math.PI * exposure,
  };
}

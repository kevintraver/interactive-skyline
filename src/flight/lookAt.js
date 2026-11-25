// "Look at" from a window seat (plan 03, section 4.8): the head turns to a building when the seat can see it, and
// otherwise the visitor is told which side it is on. Pure: the inverse of headRig.headPose's look direction.
//
// headPose turns the head by (-90 + yaw) * sign about up, then pitches it; the camera looks along its -Z. So a body
// direction d is seen at pitch = asin(d.y) and at a turn theta = atan2(-d.x, -d.z), with yaw = theta * sign + 90.
import { Vector3, Quaternion } from 'three';
import { LIMITS } from './cabin/headRig.js';

const DEG = 180 / Math.PI;
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * The look that faces a body-axes direction from a seat, and whether the head can make it.
 * @param {{ sign: number }} seat from lopa.js
 * @param {{ x: number, y: number, z: number }} dir body axes (x right, y up, z aft); need not be unit length
 * @returns {{ yaw: number, pitch: number, inView: boolean, where: 'window'|'ahead'|'behind'|'other side'|'below'|'above' }}
 */
export function lookToward(seat, dir) {
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const x = dir.x / l, y = dir.y / l, z = dir.z / l;
  const pitch = Math.asin(Math.max(-1, Math.min(1, y))) * DEG;
  const theta = Math.atan2(-x, -z) * DEG;
  const yaw = wrap(theta * seat.sign + 90);
  let where = 'window';
  if (pitch < -LIMITS.pitchDown) where = 'below';
  else if (pitch > LIMITS.pitchUp) where = 'above';
  else if (x * seat.sign < 0) where = 'other side';
  else if (yaw > LIMITS.yaw) where = 'ahead';
  else if (yaw < -LIMITS.yaw) where = 'behind';
  return { yaw, pitch, inView: where === 'window', where };
}

/** Where a building is, as the end of "<name> is ...". */
export function whereText(where, seat) {
  switch (where) {
    case 'other side': return `on the ${seat.sign > 0 ? 'left' : 'right'} side of the aircraft`;
    case 'ahead': return 'ahead, out of sight of this window';
    case 'behind': return 'behind, out of sight of this window';
    case 'below': return 'below the aircraft';
    case 'above': return 'above the window';
    default: return 'in view';
  }
}

const _q = new Quaternion();
/**
 * The unit direction, in body axes, from the eye to a scene point.
 * @param {{ position: Vector3, quaternion: Quaternion }} state  @param {Vector3} eye body axes
 * @param {Vector3} point scene axes  @param {Vector3} [out]
 */
export function bodyDirection(state, eye, point, out = new Vector3()) {
  return out.copy(point).sub(state.position).applyQuaternion(_q.copy(state.quaternion).invert()).sub(eye).normalize();
}

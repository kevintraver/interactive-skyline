// The aircraft on its wheels (plan 03, F3.4 as put in the app): the session turns the sampled state nose-down about
// the main wheels by rig.js groundPitchCorrection before the view layers place the airframe, the cabin and the camera,
// so all three sit on the runway together; the model is then told not to turn itself again (groundPitch: false).
import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { applyGroundPitch } from '../../../src/flight/attitude.js';
import { groundPitchCorrection } from '../../../src/flight/aircraft/rig.js';
import { bodyQuaternion } from '../../../src/flight/kinematics.js';

const DEG = Math.PI / 180;
const rig = { groundPitchDeg: -0.8108 };
const state = (o) => {
  const s = { position: new Vector3(1400, 20, 2000), quaternion: new Quaternion(), heading: 205 * DEG, pitch: 0, roll: 0, onGround: true, gear: 1, ...o };
  bodyQuaternion(s.position.x, s.position.z, s.heading, s.pitch, s.roll, s.quaternion);
  return s;
};
/** The nose's angle above the local horizontal plane of the body frame before the turn, degrees. */
const noseUp = (q, ref) => {
  const nose = new Vector3(0, 0, -1).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(ref);
  return Math.asin(nose.dot(up)) / DEG;
};

describe('applyGroundPitch', () => {
  it('turns a level aircraft on its wheels nose-down by the rig\'s ground attitude, about body X', () => {
    const s = state({});
    const before = s.quaternion.clone();
    const a = applyGroundPitch(s, rig);
    expect(a).toBeCloseTo(groundPitchCorrection(s, rig), 12);
    expect(a / DEG).toBeCloseTo(-0.8108, 6);
    expect(noseUp(s.quaternion, before)).toBeCloseTo(-0.8108, 6);
    // the right wing stays where it was: the turn is about the wing's axis
    const wing0 = new Vector3(1, 0, 0).applyQuaternion(before), wing1 = new Vector3(1, 0, 0).applyQuaternion(s.quaternion);
    expect(wing0.distanceTo(wing1)).toBeLessThan(1e-9);
    expect(s.position.toArray()).toEqual([1400, 20, 2000]);
  });

  it('leaves the aircraft alone in the air, with the gear up, and with the nose raised (the flare)', () => {
    for (const o of [{ onGround: false }, { gear: 0 }, { pitch: 3 * DEG }]) {
      const s = state(o), q = s.quaternion.clone();
      expect(applyGroundPitch(s, rig)).toBe(0);
      expect(s.quaternion.equals(q)).toBe(true);
    }
  });

  it('does nothing until the rig is known', () => {
    const s = state({}), q = s.quaternion.clone();
    expect(applyGroundPitch(s, null)).toBe(0);
    expect(s.quaternion.equals(q)).toBe(true);
  });
});

// Plan 03, section 4.8: "Look at" turns the head to a building when the seat can see it, else says where it is.
import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { lookToward, whereText, bodyDirection } from '../../../src/flight/lookAt.js';
import { headPose, LIMITS } from '../../../src/flight/cabin/headRig.js';
import { seat } from '../../../src/flight/cabin/lopa.js';
import { bodyQuaternion } from '../../../src/flight/kinematics.js';

const right = seat('22F'), left = seat('22A');
const RAD = Math.PI / 180;
/** The body direction the head looks along for a yaw and pitch (headRig's own convention). */
const dirOf = (s, yaw, pitch) => new Vector3(0, 0, -1).applyQuaternion(headPose(s, { yaw, pitch, lens: 26, lean: 0, slide: 0, rise: 0 }).quaternion);

describe('lookToward', () => {
  it('inverts the head rig: the direction of a look gives back that look, on either side', () => {
    for (const s of [right, left]) {
      for (const [yaw, pitch] of [[0, -8], [40, -20], [-60, 10], [75, -55]]) {
        const l = lookToward(s, dirOf(s, yaw, pitch));
        expect(l.yaw).toBeCloseTo(yaw, 6);
        expect(l.pitch).toBeCloseTo(pitch, 6);
        expect(l.inView).toBe(true);
        expect(l.where).toBe('window');
      }
    }
  });

  it('says where a building is that the seat cannot see', () => {
    // straight ahead along the nose, straight behind, across the cabin, under the belly
    expect(lookToward(right, new Vector3(0.05, 0, -1))).toMatchObject({ inView: false, where: 'ahead' });
    expect(lookToward(right, new Vector3(0.05, 0, 1))).toMatchObject({ inView: false, where: 'behind' });
    expect(lookToward(right, new Vector3(-1, -0.2, 0))).toMatchObject({ inView: false, where: 'other side' });
    expect(lookToward(left, new Vector3(1, -0.2, 0.3))).toMatchObject({ inView: false, where: 'other side' });
    expect(lookToward(right, new Vector3(0.2, -1, 0))).toMatchObject({ inView: false, where: 'below' });
    expect(lookToward(right, new Vector3(0.3, 1, 0))).toMatchObject({ inView: false, where: 'above' });
  });

  it('keeps to the head rig\'s limits at the edge', () => {
    const atLimit = lookToward(right, dirOf(right, LIMITS.yaw - 0.5, -LIMITS.pitchDown + 0.5));
    expect(atLimit.inView).toBe(true);
  });
});

describe('whereText', () => {
  it('names the side in plain words', () => {
    expect(whereText('other side', right)).toBe('on the left side of the aircraft');
    expect(whereText('other side', left)).toBe('on the right side of the aircraft');
    expect(whereText('ahead', right)).toBe('ahead, out of sight of this window');
    expect(whereText('behind', right)).toBe('behind, out of sight of this window');
    expect(whereText('below', right)).toBe('below the aircraft');
    expect(whereText('above', right)).toBe('above the window');
  });
});

describe('bodyDirection', () => {
  it('takes a scene point into the body axes, from the eye', () => {
    const state = { position: new Vector3(100, 500, -200), quaternion: bodyQuaternion(100, -200, 90 * RAD, 0, 0, new Quaternion()) };
    // heading east: the right wing points south (+z in the scene); a point 1 km south of the aircraft, level
    const eye = new Vector3(1.5, 2, 0);
    const d = bodyDirection(state, eye, new Vector3(100, 502, 800));
    expect(d.length()).toBeCloseTo(1, 9);
    expect(d.x).toBeGreaterThan(0.99);
    expect(Math.abs(d.y)).toBeLessThan(0.01);
  });
});

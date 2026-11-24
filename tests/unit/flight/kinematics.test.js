// Plan 03, F1.3 and section 8.2: the level frame, the body attitude on it, and the coordinated-turn relations.
import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { localUp } from '../../../src/world/frame.js';
import {
  G, levelBasis, bodyQuaternion, bankForTurnRate, turnRateForBank, turnRadius, bankForRadius, loadFactor,
} from '../../../src/flight/kinematics.js';

const DEG = Math.PI / 180;
const KT = 1852 / 3600;
const axes = (q) => ({
  nose: new Vector3(0, 0, -1).applyQuaternion(q),
  right: new Vector3(1, 0, 0).applyQuaternion(q),
  up: new Vector3(0, 1, 0).applyQuaternion(q),
});

describe('level frame', () => {
  it('is the scene axes at the origin: up +y, north -z, east +x', () => {
    const b = levelBasis(0, 0);
    expect(b.up.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-12);
    expect(b.north.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-12);
    expect(b.east.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-12);
  });
  it('leans 1.93 degrees 250 km east (2.25 with the true radius, which the app does not use)', () => {
    const { up } = levelBasis(250000, 0);
    expect(Math.acos(up.y) / DEG).toBeCloseTo(1.926, 3);
    // the true radius would give 2.25 degrees: the 7/6 effective radius is what is drawn
    expect(Math.atan(250000 / 6371000) / DEG).toBeCloseTo(2.25, 2);
  });
});

describe('body attitude', () => {
  it('heading 0 points the nose north, heading 90 points it +x (east)', () => {
    expect(axes(bodyQuaternion(0, 0, 0, 0, 0)).nose.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-12);
    expect(axes(bodyQuaternion(0, 0, 90 * DEG, 0, 0)).nose.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-12);
    expect(axes(bodyQuaternion(0, 0, 205 * DEG, 0, 0)).nose.distanceTo(new Vector3(Math.sin(205 * DEG), 0, -Math.cos(205 * DEG)))).toBeLessThan(1e-12);
  });
  it('positive pitch raises the nose; positive roll lowers the right wing (+x)', () => {
    expect(axes(bodyQuaternion(0, 0, 0, 5 * DEG, 0)).nose.y).toBeCloseTo(Math.sin(5 * DEG), 12);
    const { right, up } = axes(bodyQuaternion(0, 0, 0, 0, 20 * DEG));
    expect(right.y).toBeCloseTo(-Math.sin(20 * DEG), 12);
    expect(up.x).toBeGreaterThan(0); // a right bank tilts the lift toward the right
  });
  it('a level aircraft 250 km east has its up vector equal to localUp there', () => {
    const x = 250000, z = 0;
    for (const hdg of [0, 75, 180, 290]) {
      const { up, nose } = axes(bodyQuaternion(x, z, hdg * DEG, 0, 0));
      expect(up.distanceTo(localUp(x, z, new Vector3()))).toBeLessThan(1e-12);
      expect(Math.abs(nose.dot(up))).toBeLessThan(1e-12);
    }
  });
  it('keeps the body basis orthonormal and right-handed for any attitude, anywhere', () => {
    for (let i = 0; i < 200; i++) {
      const x = Math.sin(i * 1.7) * 370000, z = Math.cos(i * 2.3) * 370000;
      const q = bodyQuaternion(x, z, (i * 37) % 360 * DEG, Math.sin(i) * 12 * DEG, Math.cos(i * 0.7) * 35 * DEG, new Quaternion());
      const { nose, right, up } = axes(q);
      for (const v of [nose, right, up]) expect(v.length()).toBeCloseTo(1, 12);
      expect(Math.abs(nose.dot(right)) + Math.abs(nose.dot(up)) + Math.abs(right.dot(up))).toBeLessThan(1e-12);
      // right x up = backward (+Z body), i.e. -nose
      expect(new Vector3().crossVectors(right, up).distanceTo(nose.clone().negate())).toBeLessThan(1e-12);
    }
  });
  it('writes into `out`', () => {
    const out = new Quaternion();
    expect(bodyQuaternion(10, 20, 1, 0.1, 0.2, out)).toBe(out);
  });
});

describe('coordinated turn', () => {
  it('banks 34.5 degrees for 3 degrees a second at 250 kt (section 8.2, test_attitude)', () => {
    expect(bankForTurnRate(250 * KT, 3 * DEG) / DEG).toBeCloseTo(34.5, 1);
  });
  it('is consistent: rate, radius and bank agree, and level flight is no turn', () => {
    const v = 140 * KT, bank = 25 * DEG;
    const w = turnRateForBank(v, bank);
    expect(bankForTurnRate(v, w)).toBeCloseTo(bank, 12);
    expect(turnRadius(v, bank)).toBeCloseTo(v / w, 9);
    expect(bankForRadius(v, turnRadius(v, bank))).toBeCloseTo(bank, 12);
    expect(turnRateForBank(v, 0)).toBe(0);
    expect(turnRadius(v, 0)).toBe(Infinity);
    // a standard-rate turn (3 deg/s) at 180 kt banks 26.3 degrees (atan(92.6 * 0.0524 / 9.81)); a 60 degree bank pulls 2 g
    expect(bankForTurnRate(180 * KT, 3 * DEG) / DEG).toBeCloseTo(26.3, 1);
    expect(loadFactor(60 * DEG)).toBeCloseTo(2, 12);
    expect(G).toBe(9.80665);
  });
  it('turning left is a negative rate and a negative (left wing down) bank', () => {
    expect(bankForTurnRate(100, -0.05)).toBeLessThan(0);
  });
});

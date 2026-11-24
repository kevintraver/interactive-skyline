// The code-built v0 airframe (plan 03, sections 5.5, 6.5 and 7.8; F1.5). Expected values are the published figures
// of section 6.5, in body axes: nose -Z, right wing +X, up +Y, origin at the main gear contact point on the centre
// line, which is 4.09 + 15.60 = 19.69 m aft of the nose.
import { describe, it, expect } from 'vitest';
import { Box3, Vector3, Quaternion, Mesh } from 'three';
import { createAirframe, placeAirframe, wingPlanform } from '../../../src/flight/aircraft/airframe.js';

const Z = (station) => station - 19.69;
const af = createAirframe();
const box = (name) => new Box3().setFromObject(af.parts[name]);
const RAD = Math.PI / 180;

describe('wingPlanform()', () => {
  it('meets the published root, kink and tip', () => {
    const root = wingPlanform(3.76 / 2);
    expect(root.le).toBeCloseTo(15.0, 6);
    expect(root.te).toBeCloseTo(21.4, 6);
    const kink = wingPlanform(3.76 / 2 + 5.6);
    expect(kink.te - kink.le).toBeCloseTo(3.6, 6);
    const tip = wingPlanform(34.32 / 2);
    expect(tip.le).toBeCloseTo(23.47, 6);
    expect(tip.te).toBeCloseTo(24.99, 6);
    expect(tip.y).toBeCloseTo(3.91, 6);
  });

  it('has 6 degrees of dihedral and about 25 degrees of quarter-chord sweep', () => {
    const a = wingPlanform(3), b = wingPlanform(15);
    expect(Math.atan2(b.y - a.y, 12) / RAD).toBeCloseTo(6, 6);
    const q = (p) => p.le + 0.25 * (p.te - p.le);
    const r = wingPlanform(1.88), k = wingPlanform(17.16);
    const sweep = Math.atan2(q(k) - q(r), 17.16 - 1.88) / RAD;
    expect(Math.abs(sweep - 25.02)).toBeLessThan(1);
  });
});

describe('createAirframe()', () => {
  it('spans 35.79 m over the winglets, symmetric about the centre line', () => {
    const b = new Box3().setFromObject(af.group);
    expect(b.max.x).toBeCloseTo(35.79 / 2, 1);
    expect(b.min.x).toBeCloseTo(-35.79 / 2, 1);
  });

  it('puts the winglet top 6.76 m above the ground and its last point 26.01 m aft of the nose', () => {
    const w = box('wingRight');
    expect(Math.abs(w.max.y - 6.76)).toBeLessThan(0.06);
    expect(Math.abs(w.max.z - Z(26.01))).toBeLessThan(0.06);
  });

  it('is 38.02 m long in the fuselage, with the nose 19.69 m ahead of the origin, and the fin 12.55 m high', () => {
    const f = box('fuselage');
    expect(f.min.z).toBeCloseTo(Z(0), 2);
    expect(f.max.z).toBeCloseTo(Z(38.02), 2);
    expect(f.max.y).toBeCloseTo(5.56, 2);
    expect(f.max.x - f.min.x).toBeCloseTo(3.76, 2);
    expect(box('fin').max.y).toBeCloseTo(12.55, 2);
  });

  it('hangs the engine 4.83 m out with the inlet at 13.36 m, a 2.06 m wide nacelle, 0.64 m off the ground', () => {
    const n = box('engineRight');
    expect((n.min.x + n.max.x) / 2).toBeCloseTo(4.83, 2);
    expect(n.max.x - n.min.x).toBeCloseTo(2.06, 2);
    expect(n.min.z).toBeCloseTo(Z(13.36), 2);
    expect(n.min.y).toBeCloseTo(0.64, 2); // the nacelle's lowest point above the ground, empty [B1] p. 2-19
  });

  it('mirrors the left side onto the right', () => {
    for (const [l, r] of [['wingLeft', 'wingRight'], ['engineLeft', 'engineRight'], ['fairingsLeft', 'fairingsRight']]) {
      const a = box(l), b = box(r);
      expect(a.min.x).toBeCloseTo(-b.max.x, 6);
      expect(a.max.y).toBeCloseTo(b.max.y, 6);
      expect(a.min.z).toBeCloseTo(b.min.z, 6);
    }
  });

  it('puts the flap-track fairings under the wing, reaching behind its trailing edge', () => {
    const f = box('fairingsRight');
    expect(f.max.z).toBeGreaterThan(Z(wingPlanform(f.max.x).te));
    expect(f.max.y).toBeLessThan(wingPlanform(f.max.x).y + 0.3);
  });

  it('faces every surface outward, on both sides', () => {
    af.group.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const g = o.geometry, p = g.attributes.position, idx = g.index.array;
      const c = new Box3().setFromBufferAttribute(p).getCenter(new Vector3());
      let vol = 0;
      const a = new Vector3(), b = new Vector3(), d = new Vector3();
      for (let i = 0; i < idx.length; i += 3) {
        a.fromBufferAttribute(p, idx[i]).sub(c); b.fromBufferAttribute(p, idx[i + 1]).sub(c); d.fromBufferAttribute(p, idx[i + 2]).sub(c);
        vol += a.dot(b.cross(d)) / 6;
      }
      expect(vol, o.name).toBeGreaterThan(0);
    });
  });

  it('stays light: a few thousand triangles, no NaN', () => {
    expect(af.triangles).toBeGreaterThan(1500);
    expect(af.triangles).toBeLessThan(8000);
    af.group.traverse((o) => {
      if (o instanceof Mesh) expect(Array.from(o.geometry.attributes.position.array).every(Number.isFinite), o.name).toBe(true);
    });
  });
});

describe('placeAirframe()', () => {
  it('copies an AircraftState position and quaternion onto the group', () => {
    const state = { position: new Vector3(100, 600, -2000), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3) };
    placeAirframe(af.group, state);
    expect(af.group.position.equals(state.position)).toBe(true);
    expect(af.group.quaternion.equals(state.quaternion)).toBe(true);
    // the right wingtip goes down for a right-wing-down roll (a negative turn about +Z)
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -20 * RAD);
    placeAirframe(af.group, { position: new Vector3(), quaternion: q });
    af.group.updateMatrixWorld(true);
    const tip = new Vector3(17.16, 3.91, 0).applyMatrix4(af.group.matrixWorld);
    expect(tip.y).toBeLessThan(3.91);
  });
});

// Plan 03, F5.4 to F5.7: what the pane's shader is given each frame, as pure functions. The streak direction follows
// the air in the pane's plane (7.7, "Droplets"); everything that animates runs on presentation time and stands still
// under reduced motion (7.5); the cabin's reflection follows the flight's cabinLight channel; the sun lights the pane
// only from outside it.
import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { bodyQuaternion } from '../../../src/flight/kinematics.js';
import { dropFlow, paneFrame, paneNormal, DROPS } from '../../../src/flight/window/paneFrame.js';

const DEG = Math.PI / 180;
/** A level aircraft heading north at `tas` with angle of attack `aoaDeg` (pitch = aoa, flying level). */
function flying(tas, aoaDeg = 0, { headingDeg = 0, rollDeg = 0 } = {}) {
  const quaternion = bodyQuaternion(0, 0, headingDeg * DEG, aoaDeg * DEG, rollDeg * DEG);
  // level flight north: the air moves past at tas toward the south (scene: north is -z)
  const airVelocity = new Vector3(Math.sin(headingDeg * DEG) * tas, 0, -Math.cos(headingDeg * DEG) * tas);
  return { quaternion, airVelocity, tas, altMsl: 1000 };
}

describe('dropFlow: where water runs on the outer face', () => {
  it('standing still, drops run straight down', () => {
    const f = dropFlow(flying(0), 'right');
    expect(f.u).toBeCloseTo(0, 6);
    expect(f.v).toBeCloseTo(-1, 6);
    expect(f.speed).toBeLessThan(0.05);
  });

  it('taxiing at 15 kt they still run mostly down, a little aft', () => {
    const f = dropFlow(flying(15 * 0.5144), 'right');
    expect(f.v).toBeLessThan(-0.7);
    expect(f.u).toBeGreaterThan(0);
  });

  it('at 140 kt on approach with 5 degrees of angle of attack they streak aft and slightly up', () => {
    const f = dropFlow(flying(72, 5), 'right');
    expect(f.u).toBeGreaterThan(0.95);
    expect(f.v).toBeGreaterThan(0.02);
    expect(f.v).toBeLessThan(0.25);
  });

  it('nose down (negative angle of attack) the streaks run slightly down instead', () => {
    expect(dropFlow(flying(72, -3), 'right').v).toBeLessThan(0);
  });

  it('the faster the air, the further aft and the faster they run (three speeds)', () => {
    const [a, b, c] = [8, 40, 72].map((v) => dropFlow(flying(v, 0), 'right'));
    expect(a.u).toBeLessThan(b.u);
    expect(b.u).toBeLessThan(c.u);
    expect(a.speed).toBeLessThan(b.speed);
    expect(b.speed).toBeLessThan(c.speed);
    expect(c.speed).toBeLessThanOrEqual(DROPS.maxSpeed);
  });

  it('the left side is the same in pane coordinates (aft, up), and the direction is a unit vector', () => {
    const r = dropFlow(flying(72, 5), 'right'), l = dropFlow(flying(72, 5), 'left');
    expect(l.u).toBeCloseTo(r.u, 9);
    expect(l.v).toBeCloseTo(r.v, 9);
    expect(Math.hypot(r.u, r.v)).toBeCloseTo(1, 9);
  });

  it('banked, gravity pulls slow drops toward the low side of the pane', () => {
    // right wing down 30 degrees: on the right side's pane, "down" in the pane tilts... gravity has a component along
    // the pane's normal, and what lies in its plane is still downward
    const f = dropFlow(flying(0, 0, { rollDeg: 30 }), 'right');
    expect(f.v).toBeLessThan(-0.9);
  });
});

describe('paneNormal', () => {
  it('points outboard: +x on the right, -x on the left, tilted up a little by the window ring angle', () => {
    const r = paneNormal('right'), l = paneNormal('left');
    expect(r.x).toBeGreaterThan(0.95);
    expect(l.x).toBeLessThan(-0.95);
    expect(r.y).toBeGreaterThan(0);
    expect(r.y).toBeLessThan(0.3);
  });
});

describe('paneFrame: the values the shader gets', () => {
  const base = {
    state: { ...flying(72, 5), cabinLight: 1 },
    pane: { frost: 0.4, fog: 0.1, wet: 0.5, mist: 0, rainRateMmH: 4 },
    side: 'right',
    sun: { dir: new Vector3(1, 0.3, 0).normalize(), illuminanceLux: 100000 },
    exposure: 3.2e-5,
    wallS: 1234.5,
    cabinLight: 1,
    reducedMotion: false,
  };

  it('animation runs on presentation time', () => {
    const a = paneFrame({ ...base, wallS: 10 }), b = paneFrame({ ...base, wallS: 11 });
    expect(b.timeS - a.timeS).toBeCloseTo(1, 9);
  });

  it('under reduced motion presentation time stands still: the same picture at any wall time', () => {
    const a = paneFrame({ ...base, reducedMotion: true, wallS: 10 }), b = paneFrame({ ...base, reducedMotion: true, wallS: 99 });
    expect(a.timeS).toBe(b.timeS);
    expect(a).toEqual(b);
  });

  it('the same inputs give the same values (a seek back to a moment draws it again)', () => {
    expect(paneFrame({ ...base })).toEqual(paneFrame({ ...base }));
  });

  it('the cabin reflection follows cabinLight, clamped to 0..1, and is off when the reflections switch is off', () => {
    expect(paneFrame({ ...base, cabinLight: 0.3 }).reflection).toBeCloseTo(0.3, 9);
    expect(paneFrame({ ...base, cabinLight: 2 }).reflection).toBe(1);
    expect(paneFrame({ ...base, cabinLight: -1 }).reflection).toBe(0);
    expect(paneFrame({ ...base, effects: { reflections: false } }).reflection).toBe(0);
  });

  it('the sun lights the pane in buffer units when it shines on it from outside, not from behind', () => {
    const lit = paneFrame(base);
    expect(lit.sunE).toBeGreaterThan(0);
    expect(lit.sunE).toBeLessThanOrEqual(100000 * 3.2e-5 + 1e-12);
    const behind = paneFrame({ ...base, sun: { dir: new Vector3(-1, 0.3, 0).normalize(), illuminanceLux: 100000 } });
    expect(behind.sunE).toBe(0);
    const night = paneFrame({ ...base, sun: { dir: base.sun.dir, illuminanceLux: 0 } });
    expect(night.sunE).toBe(0);
  });

  it('the sun direction is handed over in body axes', () => {
    const f = paneFrame(base);
    const q = base.state.quaternion.clone().invert();
    const want = base.sun.dir.clone().applyQuaternion(q);
    expect(f.sunBody.x).toBeCloseTo(want.x, 9);
    expect(f.sunBody.y).toBeCloseTo(want.y, 9);
    expect(f.sunBody.z).toBeCloseTo(want.z, 9);
  });

  it('switches turn each effect off without touching the others', () => {
    const off = paneFrame({ ...base, effects: { frost: false, droplets: false, scratches: false, condensation: false } });
    expect(off.frost).toBe(0);
    expect(off.fog).toBe(0);
    expect(off.wet).toBe(0);
    expect(off.mist).toBe(0);
    expect(off.scratches).toBe(0);
    expect(off.reflection).toBe(1);
    const on = paneFrame(base);
    expect(on.frost).toBe(0.4);
    expect(on.scratches).toBe(1);
  });

  it('carries the drop flow for this state', () => {
    const f = paneFrame(base);
    const d = dropFlow(base.state, 'right');
    expect(f.flow).toEqual(d);
  });
});

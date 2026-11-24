// The head at a window seat (plan 03, sections 4.5 and 7.4; F1.5 v0, completed by F3.7): limits, default pose, the
// pivot behind the eye, the box the eye cannot leave, and the input mappings. Expected values come from the plan's
// numbers (80/60/35 degrees, 13 to 85 mm, 26 mm, 8 degrees down, 10 cm toward the pane, +-18 cm, +-10 cm).
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createHeadRig, clampLook, headPose, verticalFov, lensToHfov, DEFAULT_LOOK, LIMITS, keyAction, dragDegrees } from '../../../src/flight/cabin/headRig.js';
import { seat, defaultSeat, bodyZ } from '../../../src/flight/cabin/lopa.js';
import { FUSELAGE } from '../../../src/flight/aircraft/dimensions.js';

const RAD = Math.PI / 180;
const dirOf = (pose) => new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
const radial = (p) => Math.hypot(p.x, p.y - FUSELAGE.axisY);

describe('limits', () => {
  it('clamps yaw to +-80, pitch to -60..35 and the lens to 13..85 mm', () => {
    expect(clampLook({ ...DEFAULT_LOOK, yaw: 200 }).yaw).toBe(80);
    expect(clampLook({ ...DEFAULT_LOOK, yaw: -95 }).yaw).toBe(-80);
    expect(clampLook({ ...DEFAULT_LOOK, pitch: -90 }).pitch).toBe(-60);
    expect(clampLook({ ...DEFAULT_LOOK, pitch: 50 }).pitch).toBe(35);
    expect(clampLook({ ...DEFAULT_LOOK, lens: 5 }).lens).toBe(13);
    expect(clampLook({ ...DEFAULT_LOOK, lens: 400 }).lens).toBe(85);
    expect(clampLook({ ...DEFAULT_LOOK, slide: 1 }).slide).toBeCloseTo(0.18, 9);
    expect(clampLook({ ...DEFAULT_LOOK, rise: -1 }).rise).toBeCloseTo(-0.10, 9);
  });

  it('keeps the old value for anything not finite', () => {
    const l = clampLook({ ...DEFAULT_LOOK, yaw: NaN, lens: undefined });
    expect(l.yaw).toBe(DEFAULT_LOOK.yaw);
    expect(l.lens).toBe(DEFAULT_LOOK.lens);
  });

  it('defaults to 26 mm (about 69 degrees across), straight out and 8 degrees down', () => {
    expect(DEFAULT_LOOK).toMatchObject({ yaw: 0, pitch: -8, lens: 26 });
    expect(lensToHfov(26)).toBeCloseTo(69.39, 1);
    expect(verticalFov(26, 16 / 9)).toBeCloseTo(42.57, 1);
    expect(LIMITS).toMatchObject({ yaw: 80, pitchDown: 60, pitchUp: 35, lensMin: 13, lensMax: 85 });
  });
});

describe('headPose()', () => {
  it('looks straight out of the right side and 8 degrees down by default', () => {
    const d = dirOf(headPose(defaultSeat('right'), DEFAULT_LOOK));
    expect(d.x).toBeCloseTo(Math.cos(8 * RAD), 6);
    expect(d.y).toBeCloseTo(-Math.sin(8 * RAD), 6);
    expect(d.z).toBeCloseTo(0, 6);
  });

  it('looks out of the left side for an A seat', () => {
    const d = dirOf(headPose(seat(22, 'A'), DEFAULT_LOOK));
    expect(d.x).toBeCloseTo(-Math.cos(8 * RAD), 6);
  });

  it('turns toward the nose for a positive yaw on either side', () => {
    for (const s of [seat(22, 'F'), seat(22, 'A')]) {
      const d = dirOf(headPose(s, { ...DEFAULT_LOOK, yaw: 60, pitch: 0 }));
      expect(d.z).toBeCloseTo(-Math.sin(60 * RAD), 6);
      expect(Math.abs(d.x)).toBeCloseTo(Math.cos(60 * RAD), 6);
    }
  });

  it('keeps the camera upright: no roll against the body', () => {
    const p = headPose(defaultSeat(), { ...DEFAULT_LOOK, yaw: -70, pitch: -45 });
    const right = new Vector3(1, 0, 0).applyQuaternion(p.quaternion);
    expect(right.y).toBeCloseTo(0, 9);
  });

  it('leans the default eye 10 cm toward the pane and 8 cm down from the seated eye', () => {
    const s = defaultSeat();
    const p = headPose(s, { ...DEFAULT_LOOK, pitch: 0 });
    expect(p.eye.x - s.eye.x).toBeCloseTo(0.10, 6);
    expect(p.eye.y - s.eye.y).toBeCloseTo(-0.08, 6);
    expect(p.eye.z).toBeCloseTo(s.eye.z, 6);
  });

  it('turns the eye about a pivot 10 cm behind it, so the eye moves when the head turns', () => {
    const s = defaultSeat();
    const a = headPose(s, { ...DEFAULT_LOOK, pitch: 0 }).eye;
    const b = headPose(s, { ...DEFAULT_LOOK, pitch: 0, yaw: 90 > LIMITS.yaw ? LIMITS.yaw : 90 }).eye;
    const pivot = new Vector3(a.x - 0.10, a.y, a.z);
    expect(new Vector3(b.x, b.y, b.z).distanceTo(pivot)).toBeCloseTo(0.10, 6);
    expect(b.z).toBeLessThan(a.z); // forward
  });

  it('never lets the eye pass within 5 cm of the trim and the inner pane, or leave its box, whatever the input', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const id of ['22F', '22A', '9F', '16A', '10A', '1F', '30F']) {
      const s = seat(id);
      const home = headPose(s, { ...DEFAULT_LOOK, pitch: 0 }).eye;
      for (let i = 0; i < 400; i++) {
        const look = { yaw: (rnd() - 0.5) * 400, pitch: (rnd() - 0.5) * 300, lens: rnd() * 200, lean: (rnd() - 0.5) * 3, slide: (rnd() - 0.5) * 3, rise: (rnd() - 0.5) * 3 };
        const e = headPose(s, look).eye;
        expect(radial(e)).toBeLessThanOrEqual(FUSELAGE.trimRadius - 0.05 + 1e-9);
        expect(Math.abs(e.z - home.z)).toBeLessThanOrEqual(0.18 + 0.10 + 1e-9);
        expect(Math.abs(e.y - home.y)).toBeLessThanOrEqual(0.10 + 0.10 + 1e-9);
        // the seat in front and the passenger's own seat back: the eye stays 5 cm clear of both
        expect(e.z).toBeGreaterThanOrEqual(bodyZ(s.aheadBackStation) + 0.05 - 1e-9);
        expect(e.z).toBeLessThanOrEqual(bodyZ(s.backStation) - 0.05 + 1e-9);
      }
    }
  });

  it('puts the eye at the inner pane in the clean view', () => {
    const p = headPose(defaultSeat(), DEFAULT_LOOK, { clean: true });
    expect(radial(p.eye)).toBeCloseTo(FUSELAGE.trimRadius, 6);
  });
});

describe('createHeadRig()', () => {
  it('turns, zooms, moves and resets', () => {
    const rig = createHeadRig({ seat: defaultSeat() });
    expect(rig.state).toEqual(DEFAULT_LOOK);
    rig.turnBy(10, 5); // the head turns left on screen and up
    expect(rig.state.yaw).toBeCloseTo(10, 9); // right side: screen left is the nose
    expect(rig.state.pitch).toBeCloseTo(-3, 9);
    rig.zoomBy(2);
    expect(rig.state.lens).toBeCloseTo(52, 9);
    rig.moveBy({ slide: 0.05, rise: 0.5 });
    expect(rig.state.slide).toBeCloseTo(0.05, 9);
    expect(rig.state.rise).toBeCloseTo(0.10, 9);
    rig.reset();
    expect(rig.state).toEqual(DEFAULT_LOOK);
  });

  it('turns toward the tail for a screen-left turn from a left seat', () => {
    const rig = createHeadRig({ seat: seat(22, 'A') });
    rig.turnBy(10, 0);
    expect(rig.state.yaw).toBeCloseTo(-10, 9);
  });

  it('reports a vertical field of view for a viewport', () => {
    const rig = createHeadRig({ seat: defaultSeat() });
    expect(rig.fov(16 / 9)).toBeCloseTo(verticalFov(26, 16 / 9), 9);
  });
});

describe('input mappings', () => {
  it('maps a drag to degrees so the scene stays under the pointer', () => {
    // 26 mm across 1600 px: 69.39 / 1600 degrees a pixel
    const d = dragDegrees(160, -80, 26, 1600);
    expect(d.left).toBeCloseTo(6.939, 2);
    expect(d.up).toBeCloseTo(-3.47, 2);
  });

  it('maps W A S D Q E R to head moves on the screen, whichever side', () => {
    expect(keyAction('w', 'right')).toEqual({ move: { lean: 0.02 } });
    expect(keyAction('s', 'right')).toEqual({ move: { lean: -0.02 } });
    expect(keyAction('a', 'right')).toEqual({ move: { slide: 0.02 } }); // screen left is the nose on the right side
    expect(keyAction('a', 'left')).toEqual({ move: { slide: -0.02 } });
    expect(keyAction('E', 'left')).toEqual({ move: { rise: 0.02 } });
    expect(keyAction('q', 'left')).toEqual({ move: { rise: -0.02 } });
    expect(keyAction('r', 'left')).toEqual({ reset: true });
    expect(keyAction('x', 'left')).toBeNull();
  });
});

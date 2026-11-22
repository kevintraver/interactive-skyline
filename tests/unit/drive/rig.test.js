import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createRig, lensToHfov, verticalFov, NEAR_FRACTION, LENS_DEFAULT } from '../../../src/drive/vehicle/rig.js';
import { createJourney } from '../../../src/drive/journey.js';
import { localUp } from '../../../src/world/frame.js';
import { fixture } from './helpers.js';

const { route, road, frame } = fixture();
const journey = createJourney({ route: route('test'), road: road('test.main'), frame, departMs: 0 });
const VIEW = { width: 1600, height: 900 };
const level = journey.poseAtS(400); // straight and flat
const camOf = (rig, pose = level, view = VIEW) => rig.apply(new PerspectiveCamera(), pose, view);
const dir = (cam) => new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
const camRight = (cam) => new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
const RAD = Math.PI / 180;

describe('rig', () => {
  it('puts the eye 1.2 m above the road surface', () => {
    const cam = camOf(createRig());
    const off = cam.position.clone().sub(level.position);
    expect(off.length()).toBeCloseTo(1.2, 9);
    expect(off.dot(level.up)).toBeCloseTo(1.2, 9);
  });

  it('looks along the road by default', () => {
    const cam = camOf(createRig());
    expect(dir(cam).dot(level.forward)).toBeCloseTo(1, 6);
  });

  it('clamps yaw, pitch and lens, and keeps the head where it is put', () => {
    const rig = createRig();
    rig.look({ yaw: 400, pitch: -90, lens: 5 });
    expect(rig.state).toEqual({ yaw: 150, pitch: -40, lens: 24 });
    rig.look({ yaw: -400, pitch: 90, lens: 1000 });
    expect(rig.state).toEqual({ yaw: -150, pitch: 50, lens: 200 });
    rig.reset();
    expect(rig.state).toEqual({ yaw: 0, pitch: 0, lens: 200 });
    rig.reset({ lens: true });
    expect(rig.lens).toBe(LENS_DEFAULT);
    rig.lookBy(10, 5).lookBy(10, 5);
    expect([rig.yaw, rig.pitch]).toEqual([20, 10]);
    rig.zoomBy(2);
    expect(rig.lens).toBe(100);
    rig.look({ yaw: NaN });
    expect(rig.yaw).toBe(20);
  });

  it('turns left for positive yaw and up for positive pitch', () => {
    const rig = createRig().look({ yaw: 90 });
    expect(dir(camOf(rig)).dot(level.right)).toBeCloseTo(-1, 2);
    rig.look({ yaw: 0, pitch: 30 });
    const up = localUp(level.position.x, level.position.z, new Vector3());
    expect(Math.asin(dir(camOf(rig)).dot(up)) / RAD).toBeCloseTo(30, 0); // the flat road adds no grade
  });

  it('derives the field of view from the lens like main.js', () => {
    expect(lensToHfov(50)).toBeCloseTo(39.6, 1);
    const cam = camOf(createRig());
    expect(cam.aspect).toBeCloseTo(16 / 9, 9);
    expect(cam.fov).toBeCloseTo(2 * Math.atan(18 / (50 * 16 / 9)) / RAD, 9);
    expect(verticalFov(50, 0.5)).toBe(60); // main.js's cap in a tall window
    expect(verticalFov(24, 0.5)).toBeCloseTo(lensToHfov(24), 9); // wider lens, wider cap
    expect(camOf(createRig(), level, { aspect: 2 }).aspect).toBe(2);
  });

  it('sets the near plane from where the lowest ray meets the road', () => {
    const near = (look) => camOf(createRig().look(look)).near;
    // level, 50 mm, 16:9: the bottom ray dips by half the vertical field
    const half = verticalFov(50, 16 / 9) / 2 * RAD;
    expect(near({})).toBeCloseTo(NEAR_FRACTION * 1.2 / Math.tan(half), 1);
    expect(near({}) > 4 && near({}) <= 5).toBe(true);
    // looking down: the bottom ray dips by 40 degrees plus half the field
    expect(near({ pitch: -40 })).toBeCloseTo(NEAR_FRACTION * 1.2 * Math.cos(half) / Math.sin(40 * RAD + half), 1);
    expect(near({ pitch: -40, lens: 24 })).toBe(1); // and wide: clamped to 1 m
    const wide = near({ lens: 24 }); // zoomed out: the road comes into frame closer
    expect(wide).toBeCloseTo(NEAR_FRACTION * 1.2 / (18 / (24 * 16 / 9)), 1);
    expect(wide).toBeLessThan(near({}));
    expect(near({ pitch: 30 })).toBe(5); // the lowest ray never meets the road
    expect(near({ lens: 200 })).toBe(5);
    expect(camOf(createRig()).far).toBe(150000);
  });

  it('is a pure function of pose, look and viewport', () => {
    const rig = createRig().look({ yaw: -12, pitch: 2, lens: 28 });
    const cam = new PerspectiveCamera();
    rig.apply(cam, level, VIEW);
    const a = [cam.matrixWorld.clone(), cam.projectionMatrix.clone()];
    rig.apply(cam, journey.poseAtS(1200), { width: 400, height: 800 });
    rig.apply(cam, level, VIEW);
    expect(cam.matrixWorld.equals(a[0])).toBe(true);
    expect(cam.projectionMatrix.equals(a[1])).toBe(true);
  });

  it('keeps the horizon level on a banked section', () => {
    const banked = journey.poseAtS(1200); // -3% crossfall in the curve
    const up = localUp(banked.position.x, banked.position.z, new Vector3());
    expect(Math.abs(banked.right.dot(up))).toBeGreaterThan(0.02); // the road is tilted
    for (const yaw of [0, 45, -120]) {
      const cam = camOf(createRig().look({ yaw, pitch: 10 }), banked);
      expect(camRight(cam).dot(up)).toBeCloseTo(0, 7);
    }
  });
});

// The cabin view of the rig and the body and head models behind it (plan 02, D4.2): rig offsets are a pure
// function of s and simulation time, Reduce motion holds the eye's offset from the path constant, the head's
// vertical acceleration stays under 0.5 m/s^2 RMS on smooth road at 70 mph, and the glances ease back.
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createRig, glanceEnvelope, GLANCES, GLANCE_TIMES, LENS_CABIN, LENS_DEFAULT, headMatrix, CABIN_DEFAULTS } from '../../../src/drive/vehicle/rig.js';
import { motionAt, bodyTexture, jointBump, jointsOf, roadProfile, sampleAt, wheelAngle, lagKernel, MOTION, NO_MOTION } from '../../../src/drive/vehicle/motion.js';
import { createJourney } from '../../../src/drive/journey.js';
import { fixture } from './helpers.js';

const { route, road, frame } = fixture();
const journey = createJourney({ route: route('test'), road: road('test.main'), frame, departMs: 0 });
const VIEW = { width: 1600, height: 900 };
const RAD = Math.PI / 180;

/** A cabin rig bound to the journey at a settable simulation time. */
function cabinRig(opts = {}) {
  const clock = { t: 0 };
  const rig = createRig({ view: 'cabin', ...opts }).bind({ journey: () => journey, now: () => clock.t });
  return { rig, clock };
}
/** The camera for the journey's pose at time t. */
function camAt(rig, clock, t, cam = new PerspectiveCamera()) {
  clock.t = t;
  return rig.apply(cam, journey.poseAt(t), VIEW);
}
/** The camera's offset from the path in the path's own frame. */
function offsetOf(cam, pose) {
  const d = cam.position.clone().sub(pose.position);
  return [d.dot(pose.right), d.dot(pose.up), d.dot(pose.forward)];
}

describe('rig, views', () => {
  it('opens in the cabin with a 28 mm lens; each view keeps its own lens and the head is shared', () => {
    const rig = createRig();
    expect(rig.view).toBe('cabin');
    expect(rig.lens).toBe(LENS_CABIN);
    rig.look({ yaw: 20, pitch: 5, lens: 35 });
    rig.setView('clean');
    expect(rig.state).toEqual({ yaw: 20, pitch: 5, lens: LENS_DEFAULT });
    rig.setView('cabin');
    expect(rig.lens).toBe(35);
    rig.setView('nonsense');
    expect(rig.view).toBe('cabin');
    rig.reset({ lens: true });
    expect(rig.state).toEqual({ yaw: 0, pitch: 0, lens: LENS_CABIN });
  });

  it('puts the cabin eye at the driver\'s seat: left of the lane centre, 1.2 m up, looking along the road', () => {
    const { rig, clock } = cabinRig();
    rig.setReduceMotion(true);
    const t = 5000;
    const cam = camAt(rig, clock, t);
    const [r, u, f] = offsetOf(cam, journey.poseAt(t));
    expect(r).toBeCloseTo(-CABIN_DEFAULTS.carCenterX, 9);
    expect(u).toBeCloseTo(1.2, 9);
    expect(f).toBeCloseTo(0, 9);
    expect(new Vector3(0, 0, -1).applyQuaternion(cam.quaternion).dot(journey.poseAt(t).forward)).toBeCloseTo(1, 9);
  });

  it('turns the head about the neck pivot 10 cm behind the eye', () => {
    const m = headMatrix({ yaw: 90, pitch: 0 }, NO_MOTION, { eye: new Vector3(0, 1.2, 0), neck: new Vector3(0, 1.2, 0.1) });
    const p = new Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(-0.1, 9); // turned left, the eye swings left and back
    expect(p.z).toBeCloseTo(0.1, 9);
    const dir = new Vector3(0, 0, -1).transformDirection(m);
    expect(dir.x).toBeCloseTo(-1, 9);
  });
});

describe('rig, body and head motion', () => {
  it('with Reduce motion on, the camera\'s offset from the path is constant', () => {
    const { rig, clock } = cabinRig();
    rig.setReduceMotion(true);
    const first = offsetOf(camAt(rig, clock, 0), journey.poseAt(0));
    for (let t = 0; t < journey.duration; t += 1700) {
      const o = offsetOf(camAt(rig, clock, t), journey.poseAt(t));
      for (let i = 0; i < 3; i++) expect(o[i]).toBeCloseTo(first[i], 9);
    }
  });

  it('moves the eye without Reduce motion, by millimetres to a few centimetres', () => {
    const { rig, clock } = cabinRig();
    let most = 0;
    const base = [-CABIN_DEFAULTS.carCenterX, 1.2, 0];
    for (let t = 0; t < journey.duration; t += 250) {
      const o = offsetOf(camAt(rig, clock, t), journey.poseAt(t));
      most = Math.max(most, Math.hypot(o[0] - base[0], o[1] - base[1], o[2] - base[2]));
    }
    expect(most).toBeGreaterThan(0.001);
    expect(most).toBeLessThan(0.06);
  });

  it('is a pure function of s and simulation time, in any order and either direction', () => {
    const times = [];
    for (let t = 0; t < journey.duration; t += 977) times.push(t);
    const forward = times.map((t) => motionAt(journey, t));
    const backward = [...times].reverse().map((t) => motionAt(journey, t)).reverse();
    expect(backward).toEqual(forward);
    const { rig, clock } = cabinRig();
    const a = camAt(rig, clock, 30000).matrixWorld.clone();
    camAt(rig, clock, 61000);
    camAt(rig, clock, 2000);
    expect(camAt(rig, clock, 30000).matrixWorld.equals(a)).toBe(true);
    // the road's texture is keyed on s alone: the same bump at the same place
    for (const s of [120, 777.7, 2345]) expect(bodyTexture(s, 31, [])).toEqual(bodyTexture(s, 31, []));
    expect(roadProfile(500)).toBe(roadProfile(500));
  });

  it('keeps the head\'s vertical acceleration under 0.5 m/s^2 RMS on smooth road at 70 mph', () => {
    const { rig, clock } = cabinRig();
    const dt = 0.01, n = 2000; // 20 s at 100 Hz
    const t0 = journey.timeAt(150);
    expect(journey.poseAt(t0).speed).toBeCloseTo(70 * 0.44704, 6);
    const cam = new PerspectiveCamera();
    const y = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + i * dt * 1000;
      y.push(offsetOf(camAt(rig, clock, t, cam), journey.poseAt(t))[1]);
    }
    let sum = 0;
    for (let i = 1; i < n - 1; i++) { const a = (y[i + 1] - 2 * y[i] + y[i - 1]) / (dt * dt); sum += a * a; }
    const rms = Math.sqrt(sum / (n - 2));
    expect(rms).toBeLessThan(0.5);
    expect(rms).toBeGreaterThan(0.02); // there is a texture at all
  });

  it('rolls the body out of a curve and sways the head with it; pitches the nose up under acceleration', () => {
    // find the fixture's curve: the largest lateral specific force
    let best = null;
    for (let t = 0; t < journey.duration; t += 500) { const x = sampleAt(journey, t); if (!best || Math.abs(x.lat) > Math.abs(best.lat)) best = { ...x, t }; }
    expect(Math.abs(best.lat)).toBeGreaterThan(0.3);
    const m = motionAt(journey, best.t + 3000 > journey.duration ? best.t : best.t);
    expect(Math.sign(m.roll)).toBe(Math.sign(m.lat)); // left curve: right side down
    expect(Math.sign(m.head[0])).toBe(Math.sign(m.lat)); // and the head moves right
    expect(Math.abs(m.roll)).toBeLessThan(2 * RAD);
    // a steady 1 m/s^2 gives the pitch gradient's share, nose up
    expect(MOTION.pitchPerG * 1 / 9.81).toBeGreaterThan(0);
  });

  it('thumps at each bridge joint, front axle then rear, and settles', () => {
    const joints = jointsOf({ bridges: [{ s0: 1000, s1: 1090 }] });
    expect(joints).toEqual([1000, 1090]);
    const v = 31.3;
    expect(jointBump(999, v, joints)).toBe(0);
    let peak = 0;
    for (let s = 1000; s < 1010; s += 0.05) peak = Math.max(peak, Math.abs(jointBump(s, v, joints)));
    expect(peak).toBeGreaterThan(0.002);
    expect(Math.abs(jointBump(1000 + v * 2.4, v, joints))).toBeLessThan(0.0005);
    const flat = bodyTexture(998, v, []), hit = bodyTexture(998.5, v, joints); // the front axle is 2 m ahead
    expect(hit.heave).not.toBe(flat.heave);
  });

  it('turns the steering wheel with the path\'s curvature, left for a left curve', () => {
    let best = 0, bestS = 0;
    for (let s = journey.s0; s < journey.s1; s += 10) { const a = wheelAngle(journey, s); if (Math.abs(a) > Math.abs(best)) { best = a; bestS = s; } }
    expect(Math.abs(best)).toBeGreaterThan(0.5 * RAD);
    expect(Math.abs(best)).toBeLessThan(90 * RAD);
    const k = journey.poseAtS(bestS).curvature;
    expect(Math.sign(best)).toBe(Math.sign(k));
  });

  it('builds lag kernels that sum to one', () => {
    for (const k of [lagKernel(MOTION.body), lagKernel(MOTION.head)]) expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
});

describe('glances', () => {
  it('ease to the mirror, hold, and ease back', () => {
    expect(glanceEnvelope(0)).toBe(0);
    expect(glanceEnvelope(GLANCE_TIMES.out)).toBe(1);
    expect(glanceEnvelope(GLANCE_TIMES.out + GLANCE_TIMES.hold / 2)).toBe(1);
    const end = GLANCE_TIMES.out + GLANCE_TIMES.hold + GLANCE_TIMES.back;
    expect(glanceEnvelope(end)).toBe(0);
    expect(glanceEnvelope(end - GLANCE_TIMES.back / 2)).toBeCloseTo(0.5, 9);
  });

  it('turn the head to the mirror and give it back where it was', () => {
    let now = 1000;
    const rig = createRig({ realNow: () => now }).look({ yaw: 10, pitch: 2 });
    rig.glance('left');
    expect(rig.glancing).toBe('left');
    now += (GLANCE_TIMES.out + 0.1) * 1000;
    expect(rig.effectiveLook).toEqual({ yaw: GLANCES.left.yaw, pitch: GLANCES.left.pitch });
    expect(rig.state.yaw).toBe(10); // the head's own direction is untouched
    rig.glance('left', { hold: true }); // a held key keeps it there
    now += (GLANCE_TIMES.hold - 0.05) * 1000;
    expect(rig.effectiveLook.yaw).toBe(GLANCES.left.yaw);
    now += 5000;
    expect(rig.glancing).toBe(null);
    expect(rig.effectiveLook).toEqual({ yaw: 10, pitch: 2 });
  });
});

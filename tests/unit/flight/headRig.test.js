// The head at a window seat (plan 03, sections 4.5 and 7.4; F1.5 v0, completed by F3.7): limits, default pose, the
// pivot behind the eye, the box the eye cannot leave, and the input mappings. Expected values come from the plan's
// numbers (80/60/35 degrees, 13 to 85 mm, 26 mm, 8 degrees down, 10 cm toward the pane, +-18 cm, +-10 cm).
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { createHeadRig, clampLook, headPose, verticalFov, lensToHfov, DEFAULT_LOOK, LIMITS, keyAction, dragDegrees, defaultLook, windowAperture, slideRange, headShake, orientationDelta, attachHeadInput } from '../../../src/flight/cabin/headRig.js';
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
    const rig = createHeadRig({ seat: defaultSeat(), look: DEFAULT_LOOK });
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
    expect(rig.state).toEqual(defaultLook(defaultSeat()));
    expect(rig.atHome).toBe(true);
  });

  it('starts at the default look of the seat, and moves to that of the next seat when the seat changes at home', () => {
    const rig = createHeadRig({ seat: seat('23F') });
    expect(rig.state).toEqual(defaultLook(seat('23F')));
    rig.zoomBy(2);
    rig.setSeat(seat('9F'));
    expect(rig.state.slide).toBeCloseTo(defaultLook(seat('9F')).slide, 9);
    expect(rig.state.lens).toBeCloseTo(52, 9); // a changed look keeps its lens
    const r2 = createHeadRig({ seat: seat('23F') });
    r2.setSeat(seat('9F'));
    expect(r2.state).toEqual(defaultLook(seat('9F')));
  });

  it('turns toward the tail for a screen-left turn from a left seat', () => {
    const rig = createHeadRig({ seat: seat(22, 'A'), look: DEFAULT_LOOK });
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
    expect(keyAction('c', 'left')).toBeNull(); // the mode's (clean view)
    expect(keyAction('h', 'left')).toBeNull(); // the mode's (HUD)
  });

  it('maps V to the shade, F to the focus, the arrows to turns and + - to the lens', () => {
    expect(keyAction('v', 'right')).toEqual({ shade: true });
    expect(keyAction('F', 'right')).toEqual({ focus: true });
    expect(keyAction('ArrowLeft', 'right')).toEqual({ turn: { left: 5, up: 0 } });
    expect(keyAction('ArrowUp', 'left')).toEqual({ turn: { left: 0, up: 5 } });
    expect(keyAction('+', 'left').zoom).toBeGreaterThan(1);
    expect(keyAction('-', 'left').zoom).toBeLessThan(1);
  });
});

/** A fake element and key target: enough of EventTarget and the DOM for attachHeadInput. */
function fakeTarget() {
  const listeners = new Map();
  return {
    clientWidth: 1600, width: 1600, matches: () => false, getAttribute: () => null, setPointerCapture() {},
    addEventListener(t, f) { listeners.set(t, [...(listeners.get(t) || []), f]); },
    removeEventListener(t, f) { listeners.set(t, (listeners.get(t) || []).filter((g) => g !== f)); },
    fire(t, ev) { for (const f of listeners.get(t) || []) f({ type: t, preventDefault() {}, target: null, timeStamp: 0, ...ev }); },
    count: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  };
}

describe('attachHeadInput()', () => {
  it('turns on a drag, zooms on the wheel, moves and resets on keys, and calls back for the shade and the focus', () => {
    const canvas = fakeTarget(), keys = fakeTarget();
    const rig = createHeadRig({ seat: seat('23F'), look: DEFAULT_LOOK });
    let shade = 0, focus = 0, changes = 0;
    const detach = attachHeadInput(canvas, rig, { keyTarget: keys, onShade: () => shade++, onFocus: () => focus++, onChange: () => changes++ });
    canvas.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    canvas.fire('pointermove', { pointerId: 1, clientX: 260, clientY: 100 });
    canvas.fire('pointerup', { pointerId: 1, clientX: 260, clientY: 100 });
    expect(rig.state.yaw).toBeCloseTo(160 * lensToHfov(26) / 1600, 6); // dragged right: the head turns left, to the nose
    canvas.fire('wheel', { deltaY: -100 });
    expect(rig.state.lens).toBeGreaterThan(26);
    keys.fire('keydown', { key: 'w' });
    expect(rig.state.lean).toBeCloseTo(0.02, 9);
    keys.fire('keydown', { key: 'ArrowDown' });
    expect(rig.state.pitch).toBeCloseTo(-13, 9);
    keys.fire('keydown', { key: 'v' });
    keys.fire('keydown', { key: 'f' });
    expect([shade, focus]).toEqual([1, 1]);
    keys.fire('keydown', { key: 'w', ctrlKey: true });
    expect(rig.state.lean).toBeCloseTo(0.02, 9); // a shortcut, not a move
    keys.fire('keydown', { key: 'r' });
    expect(rig.atHome).toBe(true);
    expect(changes).toBeGreaterThan(3);
    detach();
    expect(canvas.count() + keys.count()).toBe(0);
  });

  it('ignores the shade and focus keys when nobody listens for them, and everything while disabled', () => {
    const canvas = fakeTarget(), keys = fakeTarget();
    const rig = createHeadRig({ seat: seat('23F') });
    let on = false;
    attachHeadInput(canvas, rig, { keyTarget: keys, enabled: () => on });
    keys.fire('keydown', { key: 'w' });
    expect(rig.atHome).toBe(true);
    on = true;
    keys.fire('keydown', { key: 'v' });
    expect(rig.atHome).toBe(true);
  });

  it('resets on a double tap and pinches the lens with two fingers', () => {
    const canvas = fakeTarget();
    const rig = createHeadRig({ seat: seat('23F') });
    attachHeadInput(canvas, rig, { keyTarget: fakeTarget() });
    canvas.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0, pointerType: 'touch' });
    canvas.fire('pointerdown', { pointerId: 2, clientX: 200, clientY: 100, button: 0, pointerType: 'touch' });
    canvas.fire('pointermove', { pointerId: 2, clientX: 300, clientY: 100, pointerType: 'touch' });
    expect(rig.state.lens).toBeCloseTo(rig.home.lens * 2, 6);
    canvas.fire('pointerup', { pointerId: 2, pointerType: 'touch' });
    canvas.fire('pointerup', { pointerId: 1, pointerType: 'touch' });
    for (const t of [1000, 1200]) {
      canvas.fire('pointerdown', { pointerId: 3, clientX: 50, clientY: 50, button: 0, pointerType: 'touch' });
      canvas.fire('pointerup', { pointerId: 3, clientX: 50, clientY: 50, pointerType: 'touch', timeStamp: t });
    }
    expect(rig.atHome).toBe(true);
  });
});

describe('the default look centres the window', () => {
  it('slides and lowers the head so the visible opening of the window is centred on straight out and 8 degrees down', () => {
    for (const id of ['23F', '23A', '21F', '9F', '16F', '1F', '30F']) {
      const s = seat(id), l = defaultLook(s);
      const a = windowAperture(s, headPose(s, l).eye, s.nearest[0].station);
      expect(Math.abs(a.yaw)).toBeLessThan(0.5);
      expect(a.pitch).toBeCloseTo(-8, 1);
      expect(l.yaw).toBeCloseTo(0, 6);
      expect(l.pitch).toBeCloseTo(-8, 2);
      expect(l.lens).toBe(26);
    }
  });

  it('turns toward the window when the seat backs leave the head no room (22F: the window is 17 cm behind the eye)', () => {
    const s = seat('22F'), l = defaultLook(s);
    expect(l.slide).toBeCloseTo(slideRange(s).min, 9);
    expect(l.yaw).toBeLessThan(-5);
    const a = windowAperture(s, headPose(s, l).eye, s.nearest[0].station);
    expect(Math.abs(a.yaw - l.yaw)).toBeLessThan(0.5);
  });

  it('was not centred by the look of the plan alone: the window sat 15 degrees and more off the look for the default seat', () => {
    const s = defaultSeat(), a = windowAperture(s, headPose(s, DEFAULT_LOOK).eye, s.nearest[0].station);
    expect(Math.hypot(a.yaw - DEFAULT_LOOK.yaw, a.pitch - DEFAULT_LOOK.pitch)).toBeGreaterThan(15);
  });

  it('keeps the horizon in view and the frame of the window on either side at 26 mm on a 16:9 screen', () => {
    const s = defaultSeat(), l = defaultLook(s);
    const a = windowAperture(s, headPose(s, l).eye, s.nearest[0].station);
    const half = verticalFov(26, 16 / 9) / 2;
    expect(l.pitch + half).toBeGreaterThan(0); // the horizon (about level) is inside the frame
    expect(a.yawMax).toBeLessThan(lensToHfov(26) / 2); // the reveal shows at both sides
  });

  it('looks straight out at the wall from a blank-wall seat', () => {
    expect(defaultLook(seat('10A'))).toEqual(DEFAULT_LOOK);
    expect(defaultLook(seat('11F'))).toEqual(DEFAULT_LOOK);
  });
});

describe('windowAperture()', () => {
  it('is null for a window the eye cannot see, and spans the real opening seen from the pane', () => {
    const s = seat('23F');
    const far = headPose(seat('23F'), DEFAULT_LOOK).eye;
    expect(windowAperture(s, far, 5.588)).toBeNull(); // 18 m ahead: round the wall's curve
    const atPane = headPose(s, { ...defaultLook(s), pitch: -8 }, { clean: true }).eye;
    const a = windowAperture(s, atPane, s.nearest[0].station);
    expect(a.yawMax - a.yawMin).toBeGreaterThan(60); // from the inner pane the window is wide
  });
});

describe('headShake()', () => {
  it('is a damped response that starts at the event, scrubs with journey time, and is zero with reduced motion', () => {
    const ev = { touchdown: 100 };
    expect(headShake(99.9, ev)).toEqual({ rise: 0, pitch: 0 });
    const a = headShake(100.08, ev), b = headShake(100.08, ev);
    expect(a).toEqual(b);
    expect(a.rise).toBeLessThan(0); // the head drops first
    expect(Math.abs(headShake(102.5, ev).rise)).toBeLessThan(Math.abs(a.rise) * 0.05);
    expect(headShake(100.08, ev, { reducedMotion: true })).toEqual({ rise: 0, pitch: 0 });
    expect(headShake(110, ev)).toEqual({ rise: 0, pitch: 0 });
  });

  it('moves the eye in headPose and never past its limits', () => {
    const s = defaultSeat();
    const a = headPose(s, DEFAULT_LOOK).eye.clone(), b = headPose(s, DEFAULT_LOOK, { shake: { rise: -0.015, pitch: 0 } }).eye;
    expect(b.y - a.y).toBeCloseTo(-0.015, 6);
  });
});

describe('orientationDelta()', () => {
  it('turns left with the phone and up as its top tips away, portrait and landscape', () => {
    const ref = { alpha: 10, beta: 80, gamma: 0 };
    expect(orientationDelta(ref, { alpha: 30, beta: 80, gamma: 0 })).toEqual({ left: 20, up: 0 });
    expect(orientationDelta(ref, { alpha: 10, beta: 90, gamma: 0 }).up).toBe(10);
    expect(orientationDelta(ref, { alpha: 355, beta: 80, gamma: 0 }).left).toBe(-15);
    expect(orientationDelta({ alpha: 0, beta: 0, gamma: -80 }, { alpha: 0, beta: 0, gamma: -70 }, 90).up).toBe(-10);
  });
});

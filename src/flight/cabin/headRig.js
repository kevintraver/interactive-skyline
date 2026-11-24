// The head at a window seat (plan 03, sections 4.5 and 7.4): the eye's pose in body axes, its limits, and the input
// that moves it. v0 for F1.5; F3.7 adds limits from the modelled cabin, touch refinements, device orientation, the
// shocks of section 7.5 and reduced motion. The maths is pure (headPose, clampLook, keyAction, dragDegrees); the
// pointer and keyboard wiring (attachHeadInput) is separate and attaches to any canvas.
//
// Look: yaw is degrees from straight out of the window, positive toward the nose on either side; pitch is degrees, up
// positive. The camera never rolls against the cabin. The eye turns about a pivot 10 cm behind it (plan 2's driver
// uses the same value), so the window reveal shifts against the world when the head turns.
//
// Head position: lean (toward the pane +), slide (toward the nose +) and rise (up +), metres from the default pose,
// which leans 10 cm toward the pane and sits 8 cm low, as people sit to look out of a low window (plan 7.4). The eye
// never comes within 5 cm of the trim and the inner pane, the back of the seat ahead, or the passenger's own seat back.

import { Quaternion, Vector3 } from 'three';
import { FUSELAGE, bodyZ } from '../aircraft/dimensions.js';

export const LIMITS = Object.freeze({
  yaw: 80, pitchDown: 60, pitchUp: 35, // plan 4.5
  lensMin: 13, lensMax: 85, // mm, full-frame equivalent (plan 4.5)
  slide: 0.18, rise: 0.10, // plan 4.5
  leanBack: 0.15, leanIn: 0.25, // ESTIMATED: back to 5 cm behind upright; inward the wall stops the eye first
  pivot: 0.10, // the neck pivot behind the eye (plan 7.4, plan 2's driver)
  clearance: 0.05, // the eye's nearest approach to the trim and the inner pane (the camera's near plane is 2 cm)
});

/** The default head pose's offset from the seated eye (plan 7.4): toward the pane, and down. */
export const DEFAULT_LEAN = 0.10, DEFAULT_DROP = 0.08;

/** The default look (plan 4.5): straight out, 8 degrees down, a phone's 26 mm main camera, the head at home. */
export const DEFAULT_LOOK = Object.freeze({ yaw: 0, pitch: -8, lens: 26, lean: 0, slide: 0, rise: 0 });

const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pick = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** Horizontal field of view, degrees, of a lens in mm on full frame (36 mm wide). */
export const lensToHfov = (lens) => (2 * Math.atan(18 / lens)) / RAD;

/**
 * Vertical field of view, degrees, for a lens and a viewport aspect (width / height): the lens's horizontal field is
 * held whatever the window's shape. In a tall window that would make the vertical field huge, so it is capped at
 * 60 degrees or the lens's own horizontal field if wider (the rule plan 2's rig uses for the app's views).
 */
export function verticalFov(lens, aspect) {
  const h = lensToHfov(lens);
  const v = (2 * Math.atan(Math.tan((h * RAD) / 2) / aspect)) / RAD;
  return Math.min(v, Math.max(60, h));
}

/** A look with every field finite and inside the limits; anything not finite keeps `prev`'s value. */
export function clampLook(look, prev = DEFAULT_LOOK) {
  const L = LIMITS;
  return {
    yaw: clamp(pick(look.yaw, prev.yaw), -L.yaw, L.yaw),
    pitch: clamp(pick(look.pitch, prev.pitch), -L.pitchDown, L.pitchUp),
    lens: clamp(pick(look.lens, prev.lens), L.lensMin, L.lensMax),
    lean: clamp(pick(look.lean, prev.lean), -L.leanBack, L.leanIn),
    slide: clamp(pick(look.slide, prev.slide), -L.slide, L.slide),
    rise: clamp(pick(look.rise, prev.rise), -L.rise, L.rise),
  };
}

const _Y = new Vector3(0, 1, 0), _X = new Vector3(1, 0, 0), _qa = new Quaternion();

/**
 * The eye's pose in body axes (x right, y up from the ground, z aft from the main gear) for a seat from lopa.js and a
 * look. A pure function of its arguments. With `clean` the eye sits at the inner pane (the clean view, key C: no
 * cabin is drawn then).
 * @param {{ eye: {x:number,y:number,z:number}, sign: number }} seat
 * @param {object} look  @param {{ clean?: boolean }} [opts]
 * @param {{ eye: Vector3, quaternion: Quaternion }} [out]
 */
export function headPose(seat, look, { clean = false } = {}, out = { eye: new Vector3(), quaternion: new Quaternion() }) {
  const l = clampLook(look);
  const s = seat.sign;
  // the head's direction: face out of the window (a turn of -90 degrees about up for the right side), turn toward
  // the nose by the yaw, then raise by the pitch
  out.quaternion.setFromAxisAngle(_Y, (-90 + l.yaw) * s * RAD);
  out.quaternion.multiply(_qa.setFromAxisAngle(_X, l.pitch * RAD));
  // the pivot: the default eye moved by the head's offsets, then 10 cm inboard of it (behind the eye at rest)
  const px = seat.eye.x + s * (DEFAULT_LEAN + l.lean) - s * LIMITS.pivot;
  const py = seat.eye.y - DEFAULT_DROP + l.rise;
  const pz = seat.eye.z - l.slide;
  out.eye.set(0, 0, -LIMITS.pivot).applyQuaternion(out.quaternion).add({ x: px, y: py, z: pz });
  // the wall: a cylinder about the fuselage axis. The eye is held inboard of it horizontally, so its height and
  // station stay as the head put them; the clean view puts it on the trim, at the pane
  const dy = out.eye.y - FUSELAGE.axisY;
  const r = clean ? FUSELAGE.trimRadius : FUSELAGE.trimRadius - LIMITS.clearance;
  const xMax = Math.sqrt(Math.max(0, r * r - dy * dy));
  if (clean) out.eye.x = s * xMax;
  else if (Math.abs(out.eye.x) > xMax) out.eye.x = Math.sign(out.eye.x) * xMax;
  // fore and aft: the back of the seat ahead and the passenger's own seat back (a turn aft swings the eye back)
  if (seat.aheadBackStation !== undefined) {
    const lo = bodyZ(seat.aheadBackStation) + LIMITS.clearance, hi = bodyZ(seat.backStation) - LIMITS.clearance;
    out.eye.z = clamp(out.eye.z, lo, hi);
  }
  return out;
}

/**
 * Degrees the head turns for a drag of (dx, dy) pixels, so the scene stays under the pointer: dragging right turns
 * the head left, dragging down turns it up.
 */
export function dragDegrees(dx, dy, lens, widthPx) {
  const k = lensToHfov(lens) / Math.max(1, widthPx);
  return { left: dx * k, up: dy * k };
}

/** Metres a head-move key moves the head. */
export const KEY_STEP = 0.02;

/**
 * What a key does to the head: W/S lean to the pane and back, A/D slide left and right on the screen (toward the
 * nose on the right side, toward the tail on the left), Q/E down and up, R the default look. null for other keys.
 * @param {string} key  @param {'left'|'right'} side
 */
export function keyAction(key, side) {
  const k = String(key).toLowerCase();
  const toNose = side === 'left' ? -1 : 1; // screen left, looking out
  switch (k) {
    case 'w': return { move: { lean: KEY_STEP } };
    case 's': return { move: { lean: -KEY_STEP } };
    case 'a': return { move: { slide: toNose * KEY_STEP } };
    case 'd': return { move: { slide: -toNose * KEY_STEP } };
    case 'e': return { move: { rise: KEY_STEP } };
    case 'q': return { move: { rise: -KEY_STEP } };
    case 'r': return { reset: true };
    default: return null;
  }
}

/**
 * The head of one passenger: look state and the seat it belongs to.
 * @param {{ seat: object, look?: object }} opts seat from lopa.js
 */
export function createHeadRig({ seat, look = DEFAULT_LOOK }) {
  let current = seat;
  let state = clampLook(look);
  const rig = {
    get seat() { return current; },
    get state() { return { ...state }; },
    /** Set any of yaw, pitch, lens, lean, slide, rise; each is clamped. */
    look(next = {}) { state = clampLook({ ...state, ...next }, state); return rig; },
    /** Turn the head on the screen: `left` degrees to the left, `up` degrees up. */
    turnBy(left = 0, up = 0) { return rig.look({ yaw: state.yaw + current.sign * left, pitch: state.pitch + up }); },
    /** factor > 1 zooms in (a longer lens). */
    zoomBy(factor) { return rig.look({ lens: state.lens * pick(factor, 1) }); },
    /** Move the head by metres of lean, slide and rise. */
    moveBy({ lean = 0, slide = 0, rise = 0 } = {}) {
      return rig.look({ lean: state.lean + lean, slide: state.slide + slide, rise: state.rise + rise });
    },
    /** The default look (R, double-click). */
    reset() { state = { ...DEFAULT_LOOK }; return rig; },
    /** Another seat; the look is kept. */
    setSeat(s) { current = s; return rig; },
    /** The eye's pose in body axes now. */
    pose(opts, out) { return headPose(current, state, opts, out); },
    /** Vertical field of view, degrees, for a viewport aspect. */
    fov(aspect) { return verticalFov(state.lens, aspect); },
  };
  return rig;
}

const DRAG_PX = 5; // the app's rule for telling a drag from a click
const DOUBLE_TAP_MS = 320, DOUBLE_TAP_PX = 30;

/** Keys never act while focus is in a text field, a select or a slider. */
const ownsKeys = (el) => !!el && typeof el.matches === 'function'
  && (el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || el.getAttribute('role') === 'slider');

/**
 * Pointer, wheel and keyboard input for a head rig on `canvas` (plan 4.5): drag turns the head; shift-drag or a
 * two-finger drag slides it (across) and leans it (up the screen toward the pane); wheel or pinch zooms; W A S D Q E
 * move it; R or a double-click (or double-tap) resets. Returns detach().
 * @param {HTMLElement} canvas  @param {ReturnType<typeof createHeadRig>} rig
 * @param {{ onChange?: () => void, keyTarget?: EventTarget, enabled?: () => boolean }} [opts]
 */
export function attachHeadInput(canvas, rig, { onChange = () => {}, keyTarget = globalThis, enabled = () => true } = {}) {
  const pointers = new Map();
  let drag = null; // { id, x, y, moved, move: boolean }
  let pinch = null; // { dist, lens, cx, cy }
  let lastTap = null;
  const width = () => Math.max(1, canvas.clientWidth || canvas.width || 1);
  const changed = () => onChange(rig.state);
  const twoFinger = () => { const [a, b] = [...pointers.values()]; return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; };
  // shift-drag and two-finger drags move the head: a screen width is 40 cm
  const moveFromDrag = (dx, dy) => {
    const m = 0.4 / width();
    rig.moveBy({ slide: rig.seat.sign * dx * m, lean: -dy * m });
  };

  const onDown = (ev) => {
    if (!enabled()) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) { pinch = { ...twoFinger(), lens: rig.state.lens }; drag = null; return; }
    if (ev.button === 0) drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false, move: ev.shiftKey };
  };
  const onMove = (ev) => {
    if (!enabled() || !pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && pointers.size === 2) {
      const t = twoFinger();
      rig.look({ lens: pinch.lens * (t.dist / Math.max(1, pinch.dist)) });
      moveFromDrag(t.cx - pinch.cx, t.cy - pinch.cy);
      pinch.cx = t.cx; pinch.cy = t.cy;
      changed();
      return;
    }
    if (!drag || drag.id !== ev.pointerId) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) <= DRAG_PX) return;
    if (!drag.moved) { try { canvas.setPointerCapture?.(ev.pointerId); } catch { /* not tracked */ } }
    drag.moved = true;
    if (drag.move || ev.shiftKey) moveFromDrag(dx, dy);
    else { const d = dragDegrees(dx, dy, rig.state.lens, width()); rig.turnBy(d.left, d.up); }
    drag.x = ev.clientX; drag.y = ev.clientY;
    changed();
  };
  const onUp = (ev) => {
    if (ev.type === 'pointerup' && ev.pointerType === 'touch' && drag && drag.id === ev.pointerId && !drag.moved && pointers.size === 1 && enabled()) {
      const now = ev.timeStamp || performance.now();
      if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < DOUBLE_TAP_PX) {
        lastTap = null; rig.reset(); changed();
      } else lastTap = { t: now, x: ev.clientX, y: ev.clientY };
    }
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && drag.id === ev.pointerId) drag = null;
  };
  const onWheel = (ev) => {
    if (!enabled()) return;
    ev.preventDefault();
    rig.zoomBy(Math.exp(-ev.deltaY * 0.0015));
    changed();
  };
  const onDbl = (ev) => { if (enabled() && ev.pointerType !== 'touch') { rig.reset(); changed(); } };
  const onKey = (ev) => {
    if (!enabled() || ev.metaKey || ev.ctrlKey || ev.altKey || ownsKeys(ev.target)) return;
    const a = keyAction(ev.key, rig.seat.side);
    if (!a) return;
    if (a.reset) rig.reset(); else rig.moveBy(a.move);
    changed();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDbl);
  keyTarget.addEventListener('keydown', onKey);
  return function detach() {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDbl);
    keyTarget.removeEventListener('keydown', onKey);
  };
}

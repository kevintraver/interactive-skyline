// The head at a window seat (plan 03, sections 4.5, 4.7, 7.4 and 7.5; F3.7): the eye's pose in body axes, its limits,
// the default look, the window's aperture, the shocks, and the input that moves it. The maths is pure (headPose,
// clampLook, defaultLook, windowAperture, headShake, keyAction, dragDegrees, orientationDelta); the pointer, keyboard
// and device-orientation wiring (attachHeadInput, attachDeviceLook) is separate and attaches to any element.
//
// Look: yaw is degrees from straight out of the window, positive toward the nose on either side; pitch is degrees, up
// positive. The camera never rolls against the cabin. The eye turns about a pivot 10 cm behind it (plan 2's driver
// uses the same value), so the window reveal shifts against the world when the head turns.
//
// Head position: lean (toward the pane +), slide (toward the nose +) and rise (up +), metres from the base pose, which
// leans 10 cm toward the pane and sits 8 cm low, as people sit to look out of a low window (plan 7.4). The eye never
// comes within 5 cm of the trim and the inner pane, the back of the seat ahead, or the passenger's own seat back.
//
// The default look (plan 4.7, and the review's "centre the window"): straight out and 8 degrees down, with the head
// slid fore or aft to the window and raised or lowered so that the window's visible opening is centred on that look.
// A seat beside a blank panel looks straight out at the wall.

import { Quaternion, Vector3 } from 'three';
import { FUSELAGE, WINDOW, CABIN, bodyZ } from '../aircraft/dimensions.js';

export const LIMITS = Object.freeze({
  yaw: 80, pitchDown: 60, pitchUp: 35, // plan 4.5
  lensMin: 13, lensMax: 85, // mm, full-frame equivalent (plan 4.5)
  slide: 0.18, rise: 0.10, // plan 4.5
  leanBack: 0.20, leanIn: 0.25, // ESTIMATED: back to 10 cm inboard of the seat's centre; inward the wall stops the eye first
  pivot: 0.10, // the neck pivot behind the eye (plan 7.4, plan 2's driver)
  clearance: 0.05, // the eye's nearest approach to the trim and the inner pane (the camera's near plane is 2 cm)
});

/** The base head pose's offset from the seated eye (plan 7.4): toward the pane, and down. */
export const DEFAULT_LEAN = 0.10, DEFAULT_DROP = 0.08;

/** The plan's look (4.7) before the head is moved to the window: straight out, 8 degrees down, 26 mm. */
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

/** The range of `slide` the seat allows: the eye stays 5 cm clear of the seat back ahead and of its own back. */
export function slideRange(seat) {
  if (seat.aheadBackStation === undefined) return { min: -LIMITS.slide, max: LIMITS.slide };
  const fwd = seat.eyeStation - (seat.aheadBackStation + LIMITS.clearance); // toward the nose, positive slide
  const aft = seat.backStation - LIMITS.clearance - seat.eyeStation;
  return { min: Math.max(-LIMITS.slide, -aft), max: Math.min(LIMITS.slide, fwd) };
}

const _Y = new Vector3(0, 1, 0), _X = new Vector3(1, 0, 0), _qa = new Quaternion();

/**
 * The eye's pose in body axes (x right, y up from the main-gear contact plane, z aft from the main gear) for a seat
 * from lopa.js and a look. A pure function of its arguments. With `clean` the eye sits at the inner pane (the clean
 * view, key C: no cabin is drawn then). `shake` ({ rise, pitch }, from headShake) is added before the limits.
 * @param {{ eye: {x:number,y:number,z:number}, sign: number }} seat
 * @param {object} look  @param {{ clean?: boolean, shake?: { rise?: number, pitch?: number } }} [opts]
 * @param {{ eye: Vector3, quaternion: Quaternion }} [out]
 */
export function headPose(seat, look, { clean = false, shake = null } = {}, out = { eye: new Vector3(), quaternion: new Quaternion() }) {
  const l = clampLook(look);
  const s = seat.sign;
  const pitch = l.pitch + (shake?.pitch || 0);
  // the head's direction: face out of the window (a turn of -90 degrees about up for the right side), turn toward
  // the nose by the yaw, then raise by the pitch
  out.quaternion.setFromAxisAngle(_Y, (-90 + l.yaw) * s * RAD);
  out.quaternion.multiply(_qa.setFromAxisAngle(_X, pitch * RAD));
  // the pivot: the base eye moved by the head's offsets, then 10 cm inboard of it (behind the eye at rest)
  const px = seat.eye.x + s * (DEFAULT_LEAN + l.lean) - s * LIMITS.pivot;
  const py = seat.eye.y - DEFAULT_DROP + l.rise + (shake?.rise || 0);
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

// ---------------------------------------------------------------- the window's aperture

const WINDOW_Y = FUSELAGE.floorAtWing + WINDOW.centreAboveFloor;
/** A point on a cylinder about the fuselage axis on side s: at height y, radius r, body z. */
const onCylinder = (s, r, y, z) => ({ x: s * Math.sqrt(Math.max(0, r * r - (y - FUSELAGE.axisY) ** 2)), y, z });

/**
 * What of a window an eye can see, as angles from the eye (yaw toward the nose and pitch, degrees, as in a look): the
 * intersection of the trim's opening (the real one plus the reveal's flare) and the real opening at the skin, each
 * taken as its bounding rectangle. null when the eye sees no part of it (behind the wall, or too far round).
 * @param {{ sign: number }} seat  @param {{ x: number, y: number, z: number }} eye body axes
 * @param {number} station the window's centre station
 */
export function windowAperture(seat, eye, station) {
  const s = seat.sign, z = bodyZ(station);
  const angles = (p) => {
    const dx = (p.x - eye.x) * s, dy = p.y - eye.y, dz = p.z - eye.z;
    return { yaw: Math.atan2(-dz, dx) / RAD, pitch: Math.atan2(dy, Math.hypot(dx, dz)) / RAD, out: dx };
  };
  const box = (r, hw, hh) => {
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].map(([u, v]) => angles(onCylinder(s, r, WINDOW_Y + v * hh, z + u * hw)));
    if (c.some((a) => a.out <= 0)) return null;
    return { yawMin: Math.min(...c.map((a) => a.yaw)), yawMax: Math.max(...c.map((a) => a.yaw)), pitchMin: Math.min(...c.map((a) => a.pitch)), pitchMax: Math.max(...c.map((a) => a.pitch)) };
  };
  // an eye at the pane (the clean view) is inside the trim's opening, which then frames nothing
  const atPane = Math.hypot(eye.x, eye.y - FUSELAGE.axisY) >= FUSELAGE.trimRadius - 1e-3;
  const outer = box(FUSELAGE.width / 2, WINDOW.width / 2, WINDOW.height / 2);
  const inner = atPane ? outer : box(FUSELAGE.trimRadius, WINDOW.width / 2 + CABIN.revealFlare, WINDOW.height / 2 + CABIN.revealFlare);
  if (!inner || !outer) return null;
  const a = {
    yawMin: Math.max(inner.yawMin, outer.yawMin), yawMax: Math.min(inner.yawMax, outer.yawMax),
    pitchMin: Math.max(inner.pitchMin, outer.pitchMin), pitchMax: Math.min(inner.pitchMax, outer.pitchMax),
  };
  if (a.yawMax <= a.yawMin || a.pitchMax <= a.pitchMin) return null;
  return { ...a, yaw: (a.yawMin + a.yawMax) / 2, pitch: (a.pitchMin + a.pitchMax) / 2, station };
}

/** The nearest open window to a seat's eye (not a blank), or null. */
const nearestOpen = (seat) => seat.nearest?.find((w) => !w.blank) ?? null;

/** The frame the default look is composed for: a landscape 16:9 screen at the default 26 mm. */
export const DEFAULT_FRAME = Object.freeze({ aspect: 16 / 9, fill: 0.9, sitBack: 0.15 });

/**
 * The default look for a seat (plan 4.7 with the window centred): the plan's look (straight out, 8 degrees down,
 * 26 mm), with the head slid toward the window's station within the seat's room, sat back from the base pose's lean
 * (at most 15 cm, to 5 cm inboard of the seat's centre) only as far as it takes for the whole opening to fit 90% of a
 * 16:9 frame's height (the rounded window shows, as in
 * a photograph from the seat), and raised or lowered (within the rise limits) until the window's visible opening is
 * centred on that look; whatever the head cannot reach the look makes up by turning. A blank-wall seat, and a seat
 * whose nearest window is more than 60 cm away, keep the plan's look.
 * @param {object} seat from lopa.js
 */
export function defaultLook(seat) {
  const base = { ...DEFAULT_LOOK };
  const w = seat.blankWall ? null : nearestOpen(seat);
  if (!w || Math.abs(w.ahead) > 0.6) return base;
  const range = slideRange(seat);
  const slide = clamp(w.ahead, range.min, range.max);
  const pose = { eye: new Vector3(), quaternion: new Quaternion() };
  const target = DEFAULT_LOOK.pitch;
  const apertureAt = (lean, rise, yaw = 0, pitch = target) => {
    headPose(seat, { ...base, slide, lean, rise, yaw, pitch }, {}, pose);
    return windowAperture(seat, pose.eye, w.station);
  };
  /** The rise that centres the opening on the plan's pitch at a lean (the centre falls as the head rises). */
  const riseFor = (lean) => {
    const centreAt = (r) => apertureAt(lean, r)?.pitch ?? NaN;
    let lo = -LIMITS.rise, hi = LIMITS.rise;
    const cLo = centreAt(lo), cHi = centreAt(hi);
    if (!(Number.isFinite(cLo) && Number.isFinite(cHi))) return null;
    if (target >= cLo) return lo;
    if (target <= cHi) return hi;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (centreAt(m) > target) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const span = (lean) => { const r = riseFor(lean); const a = r === null ? null : apertureAt(lean, r); return a ? a.pitchMax - a.pitchMin : Infinity; };
  const fits = verticalFov(DEFAULT_LOOK.lens, DEFAULT_FRAME.aspect) * DEFAULT_FRAME.fill;
  let lean = 0;
  if (span(0) > fits) {
    let near = 0, far = -DEFAULT_FRAME.sitBack;
    if (span(far) > fits) lean = far;
    else {
      for (let i = 0; i < 24; i++) { const m = (near + far) / 2; if (span(m) > fits) near = m; else far = m; }
      lean = far;
    }
  }
  const rise = riseFor(lean);
  if (rise === null) return base;
  // a turn and a tilt for what the head could not reach (two passes: the pivot moves the eye with the turn)
  let yaw = 0, pitch = target;
  for (let k = 0; k < 2; k++) {
    const a = apertureAt(lean, rise, yaw, pitch);
    if (!a) break;
    yaw = clamp(a.yaw, -LIMITS.yaw, LIMITS.yaw);
    pitch = clamp(a.pitch, -LIMITS.pitchDown, LIMITS.pitchUp);
  }
  return clampLook({ ...base, slide, lean, rise, yaw: Math.abs(yaw) < 1e-6 ? 0 : yaw, pitch });
}

// ---------------------------------------------------------------- shocks (plan 7.5)

/** Touchdown and nose-wheel contact as damped springs: amplitude (m of head drop, degrees of nod), frequency, damping. */
export const SHOCKS = Object.freeze({
  touchdown: { rise: -0.015, pitch: -0.8, hz: 2.8, zeta: 0.35 },
  noseDown: { rise: -0.008, pitch: 0.6, hz: 3.5, zeta: 0.4 },
});

/**
 * The head's response to the shocks of section 7.5 at journey time `t` (seconds): closed-form impulse responses of a
 * damped spring started at each event's time, so they scrub as the journey does. Zero with reduced motion.
 * @param {number} t  @param {{ touchdown?: number, noseDown?: number }} events journey seconds of each event
 * @param {{ reducedMotion?: boolean, scale?: number }} [o]
 * @returns {{ rise: number, pitch: number }}
 */
export function headShake(t, events = {}, { reducedMotion = false, scale = 1 } = {}) {
  const out = { rise: 0, pitch: 0 };
  if (reducedMotion || !Number.isFinite(t)) return out;
  for (const [name, at] of Object.entries(events)) {
    const k = SHOCKS[name];
    const tau = t - at;
    if (!k || !Number.isFinite(at) || tau < 0 || tau > 4) continue;
    const w = 2 * Math.PI * k.hz, wd = w * Math.sqrt(1 - k.zeta * k.zeta);
    // an impulse response normalised to its first peak's sign: down first, then the spring back
    const g = Math.exp(-k.zeta * w * tau) * Math.sin(wd * tau);
    out.rise += k.rise * g * scale;
    out.pitch += k.pitch * g * scale;
  }
  return out;
}

// ---------------------------------------------------------------- input mappings

/**
 * Degrees the head turns for a drag of (dx, dy) pixels, so the scene stays under the pointer: dragging right turns
 * the head left, dragging down turns it up.
 */
export function dragDegrees(dx, dy, lens, widthPx) {
  const k = lensToHfov(lens) / Math.max(1, widthPx);
  return { left: dx * k, up: dy * k };
}

/** Metres a head-move key moves the head; degrees an arrow key turns it; the zoom factor of + and -. */
export const KEY_STEP = 0.02, KEY_TURN = 5, KEY_ZOOM = 1.25;

/**
 * What a key does (plan 4.5): W/S lean to the pane and back, A/D slide left and right on the screen (toward the nose
 * on the right side, toward the tail on the left), Q/E down and up, R the default look, V the shade, F the focus;
 * the arrows turn the head and + and - zoom, so the look works without a pointer. null for other keys (C and H are
 * the mode's).
 * @param {string} key  @param {'left'|'right'} side
 */
export function keyAction(key, side) {
  const k = String(key).length === 1 ? String(key).toLowerCase() : String(key);
  const toNose = side === 'left' ? -1 : 1; // screen left, looking out
  switch (k) {
    case 'w': return { move: { lean: KEY_STEP } };
    case 's': return { move: { lean: -KEY_STEP } };
    case 'a': return { move: { slide: toNose * KEY_STEP } };
    case 'd': return { move: { slide: -toNose * KEY_STEP } };
    case 'e': return { move: { rise: KEY_STEP } };
    case 'q': return { move: { rise: -KEY_STEP } };
    case 'r': return { reset: true };
    case 'v': return { shade: true };
    case 'f': return { focus: true };
    case 'ArrowLeft': return { turn: { left: KEY_TURN, up: 0 } };
    case 'ArrowRight': return { turn: { left: -KEY_TURN, up: 0 } };
    case 'ArrowUp': return { turn: { left: 0, up: KEY_TURN } };
    case 'ArrowDown': return { turn: { left: 0, up: -KEY_TURN } };
    case '+': case '=': return { zoom: KEY_ZOOM };
    case '-': case '_': return { zoom: 1 / KEY_ZOOM };
    default: return null;
  }
}

/**
 * The head of one passenger: look state and the seat it belongs to. Its default look is the seat's (defaultLook).
 * @param {{ seat: object, look?: object }} opts seat from lopa.js; look overrides the seat's default
 */
export function createHeadRig({ seat, look }) {
  let current = seat;
  let home = defaultLook(seat);
  let state = clampLook(look ? { ...home, ...look } : home);
  const same = (a, b) => ['yaw', 'pitch', 'lens', 'lean', 'slide', 'rise'].every((k) => Math.abs(a[k] - b[k]) < 1e-9);
  const rig = {
    get seat() { return current; },
    get state() { return { ...state }; },
    /** The seat's default look (R, double-click). */
    get home() { return { ...home }; },
    /** True while the look is the seat's default. */
    get atHome() { return same(state, home); },
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
    /** The seat's default look (R, double-click). */
    reset() { state = { ...home }; return rig; },
    /**
     * Another seat. A look still at the old seat's default becomes the new seat's; otherwise the turn, tilt and lens
     * are kept and the head goes to the new seat's place.
     */
    setSeat(s) {
      const wasHome = same(state, home);
      current = s;
      const lens = state.lens;
      home = defaultLook(s);
      state = wasHome ? { ...home, lens } : clampLook({ ...state, lean: home.lean, slide: home.slide, rise: home.rise });
      return rig;
    },
    /** The eye's pose in body axes now (opts: clean, shake). */
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
/** The arrow keys and + and - also belong to buttons, menus and the seat map when they have focus. */
const ownsArrows = (el) => !!el && typeof el.matches === 'function' && el.matches('button, [role="grid"], [role="gridcell"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [tabindex]:not(canvas)');

/**
 * Pointer, wheel and keyboard input for a head rig on `canvas` (plan 4.5): drag turns the head; shift-drag or a
 * two-finger drag slides it (across) and leans it (up the screen toward the pane); wheel or pinch zooms; W A S D Q E
 * move it; the arrows turn it and + and - zoom; R or a double-click (or double-tap) resets; V calls onShade and F
 * onFocus. Returns detach().
 * @param {HTMLElement} canvas  @param {ReturnType<typeof createHeadRig>} rig
 * @param {{ onChange?: () => void, onShade?: () => void, onFocus?: () => void, keyTarget?: EventTarget,
 *   enabled?: () => boolean }} [opts]
 */
export function attachHeadInput(canvas, rig, { onChange = () => {}, onShade = null, onFocus = null, keyTarget = globalThis, enabled = () => true } = {}) {
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
    if (!enabled() || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || ownsKeys(ev.target)) return;
    const a = keyAction(ev.key, rig.seat.side);
    if (!a) return;
    if ((a.turn || a.zoom) && ownsArrows(ev.target)) return;
    if (a.shade) { if (!onShade) return; onShade(); ev.preventDefault(); return; }
    if (a.focus) { if (!onFocus) return; onFocus(); ev.preventDefault(); return; }
    if (a.reset) rig.reset();
    else if (a.move) rig.moveBy(a.move);
    else if (a.turn) rig.turnBy(a.turn.left, a.turn.up);
    else if (a.zoom) rig.zoomBy(a.zoom);
    if (a.turn || a.zoom) ev.preventDefault(); // arrows would scroll the page
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

// ---------------------------------------------------------------- "Hold as a window" (plan 4.5, phones)

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * How far a phone has turned since `ref`, as a head turn: { left, up } degrees on the screen. Device orientation
 * angles (alpha about the screen's normal-to-earth, beta front-to-back tilt, gamma left-to-right) are read for the way
 * the screen is held (`screenAngle`, 0 portrait, 90 or -90 landscape): turning the phone to the left turns the head
 * left, tipping its top away turns it up.
 * @param {{ alpha: number, beta: number, gamma: number }} ref  @param {{ alpha: number, beta: number, gamma: number }} now
 * @param {number} [screenAngle]
 */
export function orientationDelta(ref, now, screenAngle = 0) {
  const left = wrap180(now.alpha - ref.alpha);
  let up;
  if (Math.abs(screenAngle) === 90) up = (screenAngle > 0 ? -1 : 1) * wrap180(now.gamma - ref.gamma);
  else up = wrap180(now.beta - ref.beta);
  return { left, up };
}

/**
 * Drive the look from the device's orientation (the optional "Hold as a window" of plan 4.5). Asks for motion
 * permission where the browser requires it (call from a user gesture). The look at the moment it is turned on is the
 * reference. Resolves with detach(), or null when the device gives no orientation or permission is refused.
 * @param {ReturnType<typeof createHeadRig>} rig  @param {{ onChange?: () => void, target?: EventTarget }} [o]
 */
export async function attachDeviceLook(rig, { onChange = () => {}, target = globalThis } = {}) {
  const DOE = globalThis.DeviceOrientationEvent;
  if (!DOE) return null;
  if (typeof DOE.requestPermission === 'function') {
    try { if ((await DOE.requestPermission()) !== 'granted') return null; } catch { return null; }
  }
  let ref = null, base = null;
  const onOrient = (ev) => {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    const now = { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma };
    if (!ref) { ref = now; base = rig.state; return; }
    const angle = globalThis.screen?.orientation?.angle ?? globalThis.orientation ?? 0;
    const d = orientationDelta(ref, now, angle > 180 ? angle - 360 : angle);
    rig.look({ yaw: base.yaw + rig.seat.sign * d.left, pitch: base.pitch + d.up });
    onChange(rig.state);
  };
  target.addEventListener('deviceorientation', onOrient);
  return () => target.removeEventListener('deviceorientation', onOrient);
}

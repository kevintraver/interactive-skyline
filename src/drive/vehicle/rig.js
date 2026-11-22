// The drive camera (plan 02, section 5.7): path -> body -> head -> camera, each a pure function
// of the one below and of s and simulation time (motion.js holds the body and head models).
//
// Two views. The cabin (the default): the car's body sits on the road in the road's own frame
// (pose.right, pose.up, -pose.forward), so it tilts with the bank; on that frame ride the body's
// pitch, roll and heave (motion.js), then the head: the driver's eye from cabin.json, offset by the
// head's lag, turned by the visitor's yaw and pitch about the neck pivot 10 cm behind the eye. The
// camera is fixed to the head, so the cabin sits still in the picture and the world moves. With
// Reduce motion the body and head layers are identity: the eye's offset from the path is constant.
//
// The clean camera: no car. The eye 1.2 m above the road and the camera never rolls against true
// vertical (localUp at the car), so the horizon stays level on a banked road. The road's tilt reaches
// the view only through its grade. Yaw turns about true vertical, pitch raises or lowers the line of
// sight from the car's forward direction.
//
// Glances (keys 1-4) ease the head to a mirror and back over about 1.7 s of real time: a closed-form
// function of the time since the key, added to the look; nothing accumulates.

import { Matrix4, Vector3 } from 'three';
import { localUp } from '../../world/frame.js';
import { motionAt, wheelAngle, NO_MOTION, MOTION } from './motion.js';

export const EYE_HEIGHT = 1.2;
export const YAW_LIMIT = 150;
export const PITCH_MIN = -40;
export const PITCH_MAX = 50;
export const LENS_MIN = 24;
export const LENS_MAX = 200;
export const LENS_DEFAULT = 50;
/** The cabin's default lens: a windshield does not fit a 50 mm frame (plan 02, section 4.5). */
export const LENS_CABIN = 28;
export const VIEWS = ['cabin', 'clean'];
export const DEFAULT_VIEW = 'cabin';
export const NEAR_MIN = 1;
export const NEAR_MAX = 5;
/** camera.near is this fraction of the view-axis depth at which the lowest ray meets the road. */
export const NEAR_FRACTION = 0.8;
export const FAR = 150000;
/** main.js caps the vertical field of view of its 50 mm lens at 60 degrees in tall windows. */
const VFOV_CAP = 60;

const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/** Horizontal field of view, degrees, of a lens in mm equivalent on full frame (36 mm wide). */
export const lensToHfov = (lens) => (2 * Math.atan(18 / lens)) / RAD;

/**
 * Vertical field of view, degrees, the way resize() in main.js derives it: hold the lens's
 * horizontal field whatever the window shape, capped in tall windows. The cap is main.js's 60
 * degrees, raised to the lens's own horizontal field for lenses wider than that, so zooming out
 * still widens the view on a phone held upright.
 */
export function verticalFov(lens, aspect) {
  const v = (2 * Math.atan(Math.tan((lensToHfov(lens) * RAD) / 2) / aspect)) / RAD;
  return Math.min(v, Math.max(VFOV_CAP, lensToHfov(lens)));
}

const aspectOf = (viewport) => {
  if (!viewport) return 16 / 9;
  if (Number.isFinite(viewport.aspect) && viewport.aspect > 0) return viewport.aspect;
  if (viewport.width > 0 && viewport.height > 0) return viewport.width / viewport.height;
  return 16 / 9;
};

/**
 * Near plane for a view: NEAR_FRACTION of the depth (along the view axis) at which the lowest ray
 * of the frustum meets the road plane, clamped to [NEAR_MIN, NEAR_MAX]. A ray that never meets
 * the road gives NEAR_MAX.
 * @param {Vector3} dir unit view direction  @param {Vector3} camUp unit camera up
 * @param {Vector3} roadUp road normal  @param {number} height eye height above the road plane
 * @param {number} vfovDeg vertical field of view
 */
export function nearFor(dir, camUp, roadUp, height, vfovDeg) {
  const t = Math.tan((vfovDeg * RAD) / 2);
  // with no roll the bottom-centre ray is the steepest one
  const ray = new Vector3().copy(dir).addScaledVector(camUp, -t).normalize();
  const down = -ray.dot(roadUp);
  if (!(down > 1e-6)) return NEAR_MAX;
  const depth = (height / down) * ray.dot(dir);
  return clamp(NEAR_FRACTION * depth, NEAR_MIN, NEAR_MAX);
}

/** Where the cabin puts the eye, when no cabin.json is given (the same numbers as public/models/drive/cabin.json). */
export const CABIN_DEFAULTS = Object.freeze({ eye: [0, 1.2, 0], neckPivot: [0, 1.2, 0.1], carCenterX: 0.37 });

/** Glance targets, degrees (cabin.json "view": where each mirror sits from the eye). */
export const GLANCES = Object.freeze({
  ahead: { yaw: 0, pitch: 0 },
  left: { yaw: 39.2, pitch: -7.1 },
  right: { yaw: -59.9, pitch: -4.6 },
  center: { yaw: -30.8, pitch: 12.5 },
});
/** A glance: ease out, hold, ease back (seconds of real time). */
export const GLANCE_TIMES = Object.freeze({ out: 0.3, hold: 0.9, back: 0.45 });
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** How far into its target a glance is (0..1) at `t` seconds after it began; 0 once it is over. */
export function glanceEnvelope(t) {
  const { out, hold, back } = GLANCE_TIMES;
  if (!(t >= 0)) return 0;
  if (t < out) return smooth(t / out);
  if (t < out + hold) return 1;
  return 1 - smooth((t - out - hold) / back);
}
const GLANCE_TOTAL = GLANCE_TIMES.out + GLANCE_TIMES.hold + GLANCE_TIMES.back;

/**
 * @param {{ eyeHeight?: number, view?: 'cabin'|'clean', cabin?: object, realNow?: () => number }} [opts]
 *   cabin is cabin.json (eye, neckPivot, carCenterX; the defaults above without it); realNow is the real-time
 *   clock glances run on (performance.now)
 */
export function createRig({ eyeHeight = EYE_HEIGHT, view = DEFAULT_VIEW, cabin = CABIN_DEFAULTS, realNow = () => performance.now() } = {}) {
  const look = { yaw: 0, pitch: 0 };
  const lenses = { cabin: LENS_CABIN, clean: LENS_DEFAULT };
  let current = VIEWS.includes(view) ? view : DEFAULT_VIEW;
  let reduceMotion = false;
  let glance = null; // { name, yaw, pitch, startMs }
  let source = null; // { journey: () => journey, now: () => simMs }
  let geom = cabinGeometry(cabin);
  const _u = new Vector3(), _h = new Vector3(), _d = new Vector3(), _x = new Vector3(), _y = new Vector3();
  const _m = new Matrix4(), _eye = new Vector3(), _s = new Vector3();

  /** The look with any glance mixed in, degrees. */
  function effective() {
    if (!glance) return look;
    const t = (realNow() - glance.startMs) / 1000;
    if (t >= GLANCE_TOTAL) { glance = null; return look; }
    const e = glanceEnvelope(t);
    return { yaw: look.yaw + (glance.yaw - look.yaw) * e, pitch: look.pitch + (glance.pitch - look.pitch) * e };
  }

  const rig = {
    /** Degrees; yaw positive turns left, pitch positive looks up. Lens in mm, the current view's. */
    get yaw() { return look.yaw; },
    get pitch() { return look.pitch; },
    get lens() { return lenses[current]; },
    get state() { return { yaw: look.yaw, pitch: look.pitch, lens: lenses[current] }; },
    get view() { return current; },
    get reduceMotion() { return reduceMotion; },
    /** The glance in progress ('left', 'right', 'center', 'ahead') or null. */
    get glancing() { effective(); return glance ? glance.name : null; },
    /** The look the camera uses right now, glances included. */
    get effectiveLook() { const e = effective(); return { yaw: e.yaw, pitch: e.pitch }; },
    eyeHeight,
    /** What the last apply() worked out (body and head matrices, wheel angle, motion); null before the first. */
    last: null,

    /** Set any of yaw, pitch (degrees) and lens (mm, for the current view); each is clamped. A new yaw or pitch ends a glance. */
    look({ yaw, pitch, lens } = {}) {
      if (Number.isFinite(yaw) || Number.isFinite(pitch)) glance = null; // an explicit look takes over from a glance
      look.yaw = clamp(finite(yaw, look.yaw), -YAW_LIMIT, YAW_LIMIT);
      look.pitch = clamp(finite(pitch, look.pitch), PITCH_MIN, PITCH_MAX);
      lenses[current] = clamp(finite(lens, lenses[current]), LENS_MIN, LENS_MAX);
      return rig;
    },
    lookBy(dYaw = 0, dPitch = 0) { glance = null; return rig.look({ yaw: look.yaw + dYaw, pitch: look.pitch + dPitch }); },
    /** factor > 1 zooms in (a longer lens). */
    zoomBy(factor) { return rig.look({ lens: lenses[current] * finite(factor, 1) }); },
    /** Look ahead again. The lens stays as it is unless `lens` is true. */
    reset({ lens = false } = {}) {
      look.yaw = 0; look.pitch = 0; glance = null;
      if (lens) lenses[current] = current === 'cabin' ? LENS_CABIN : LENS_DEFAULT;
      return rig;
    },
    /** 'cabin' or 'clean'. Each keeps its own lens; the head's direction is shared. */
    setView(v) { if (VIEWS.includes(v)) current = v; return rig; },
    setReduceMotion(on) { reduceMotion = !!on; return rig; },
    /** Start a glance (GLANCES); `hold` (a held key) keeps it at its target, restarting the hold. */
    glance(name, { hold = false } = {}) {
      const g = GLANCES[name];
      if (!g) return rig;
      const now = realNow();
      if (hold && glance && glance.name === name) glance.startMs = now - GLANCE_TIMES.out * 1000;
      else glance = { name, ...g, startMs: now };
      return rig;
    },
    /** The cabin's numbers (cabin.json), once it is loaded. */
    setCabin(meta) { geom = cabinGeometry(meta || CABIN_DEFAULTS); return rig; },
    /** Where the rig reads the journey and the simulation time for the body and head layers. */
    bind(src) { source = src; return rig; },

    /** Body and head motion now (motion.js), or none with Reduce motion or no journey. */
    motion() {
      if (reduceMotion || !source) return NO_MOTION;
      return motionAt(source.journey(), source.now());
    },

    /**
     * Point `camera` (a PerspectiveCamera) for a pose and viewport. A pure function of (pose, simulation
     * time, look state, viewport): calling it twice gives the same camera.
     * @param {object} pose from journey.poseAt  @param {{ width?: number, height?: number, aspect?: number }} viewport
     */
    apply(camera, pose, viewport) {
      const eff = effective();
      const aspect = aspectOf(viewport);
      const fov = verticalFov(lenses[current], aspect);
      const journey = source ? source.journey() : null;
      const wheel = journey ? wheelAngle(journey, pose.s) : 0;
      if (current === 'cabin') {
        const motion = rig.motion();
        const body = bodyMatrix(pose, motion, geom, new Matrix4());
        const head = headMatrix(eff, motion, geom, new Matrix4());
        _m.multiplyMatrices(body, head);
        _m.decompose(camera.position, camera.quaternion, _s);
        _d.set(0, 0, -1).applyQuaternion(camera.quaternion);
        _y.set(0, 1, 0).applyQuaternion(camera.quaternion);
        // the near plane as for the clean eye: the hood hides the road closer than it anyway
        const near = nearFor(_d, _y, pose.up, eyeHeight, fov);
        setLens(camera, aspect, fov, near);
        rig.last = { view: 'cabin', body, head, fov, aspect, wheel, motion };
        return camera;
      }

      // clean: the eye sits eyeHeight along the road normal
      _eye.copy(pose.position).addScaledVector(pose.up, eyeHeight);
      // camera layer: line of sight from the car's forward direction, uprights from true vertical
      localUp(_eye.x, _eye.z, _u);
      _h.copy(pose.forward).addScaledVector(_u, -pose.forward.dot(_u));
      if (_h.lengthSq() < 1e-12) _h.set(0, 0, -1);
      _h.normalize().applyAxisAngle(_u, eff.yaw * RAD);
      const grade = Math.asin(clamp(pose.forward.dot(_u), -1, 1));
      const el = grade + eff.pitch * RAD;
      _d.copy(_h).multiplyScalar(Math.cos(el)).addScaledVector(_u, Math.sin(el));
      _x.crossVectors(_d, _u).normalize(); // right
      _y.crossVectors(_x, _d); // up, no roll against true vertical
      _m.makeBasis(_x, _y, _d.clone().negate());
      camera.position.copy(_eye);
      camera.quaternion.setFromRotationMatrix(_m);
      setLens(camera, aspect, fov, nearFor(_d, _y, pose.up, eyeHeight, fov));
      rig.last = { view: 'clean', body: null, head: null, fov, aspect, wheel, motion: NO_MOTION };
      return camera;
    },
  };
  return rig;
}

function setLens(camera, aspect, fov, near) {
  camera.aspect = aspect;
  camera.fov = fov;
  camera.near = near;
  camera.far = FAR;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

function cabinGeometry(meta) {
  const m = { ...CABIN_DEFAULTS, ...(meta || {}) };
  return { eye: new Vector3(...m.eye), neck: new Vector3(...m.neckPivot), carCenterX: m.carCenterX, pivot: new Vector3(...MOTION.pivot) };
}

const _bx = new Vector3(), _by = new Vector3(), _bz = new Vector3(), _bm = new Matrix4(), _bo = new Vector3();

/**
 * The car's body in the scene: cabin coordinates to scene coordinates. The road frame at the pose (the
 * driver sits carCenterX left of the lane's centre), raised by the heave, tilted by pitch and roll about
 * the roll centre.
 */
export function bodyMatrix(pose, motion, geom, out = new Matrix4()) {
  _bx.copy(pose.right); _by.copy(pose.up); _bz.copy(pose.forward).negate();
  _bo.copy(pose.position).addScaledVector(pose.right, -geom.carCenterX);
  out.makeBasis(_bx, _by, _bz).setPosition(_bo);
  if (motion.heave || motion.pitch || motion.roll) {
    const p = geom.pivot;
    // about the forward axis (-Z) by roll: right side down; about +X by pitch: nose up
    _bm.makeTranslation(p.x, p.y + motion.heave, p.z);
    out.multiply(_bm);
    out.multiply(_bm.makeRotationX(motion.pitch));
    out.multiply(_bm.makeRotationZ(-motion.roll));
    out.multiply(_bm.makeTranslation(-p.x, -p.y, -p.z));
  }
  return out;
}

const _hp = new Vector3(), _hv = new Vector3(), _hy = new Matrix4(), _hx = new Matrix4();

/**
 * The camera in cabin coordinates: the eye moved by the head's lag, turned by the look about the neck
 * pivot (10 cm behind the eye), so pillars and mirrors shift slightly against the world.
 */
export function headMatrix(lookDeg, motion, geom, out = new Matrix4()) {
  const [dx, dy, dz] = motion.head;
  _hy.makeRotationY(lookDeg.yaw * RAD);
  _hx.makeRotationX(lookDeg.pitch * RAD);
  out.multiplyMatrices(_hy, _hx);
  _hv.copy(geom.eye).sub(geom.neck).applyMatrix4(out); // the eye about the pivot
  _hp.copy(geom.neck).add(_hv);
  _hp.x += dx; _hp.y += dy; _hp.z += dz;
  out.setPosition(_hp);
  return out;
}

// The drive camera (plan 02, section 5.7): path -> body -> head -> camera, each a pure function
// of the one below. This phase builds the clean camera only; body and head are identity seams
// where the car's pitch and roll (Phase 4) and the neck pivot, bob and glances will go.
//
// Uprights: the camera never rolls against true vertical (localUp at the car), so the horizon
// stays level on a banked road. The road's tilt reaches the view only through its grade, which
// pitches the line of sight as it would from a real car. Yaw turns about true vertical, pitch
// raises or lowers the line of sight from the car's forward direction.

import { Matrix4, Vector3 } from 'three';
import { localUp } from '../../world/frame.js';

export const EYE_HEIGHT = 1.2;
export const YAW_LIMIT = 150;
export const PITCH_MIN = -40;
export const PITCH_MAX = 50;
export const LENS_MIN = 24;
export const LENS_MAX = 200;
export const LENS_DEFAULT = 50;
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

/**
 * @param {{ eyeHeight?: number }} [opts]
 */
export function createRig({ eyeHeight = EYE_HEIGHT } = {}) {
  const look = { yaw: 0, pitch: 0, lens: LENS_DEFAULT };
  const _u = new Vector3(), _h = new Vector3(), _d = new Vector3(), _x = new Vector3(), _y = new Vector3();
  const _m = new Matrix4(), _eye = new Vector3();

  const rig = {
    /** Degrees; yaw positive turns left, pitch positive looks up. Lens in mm. */
    get yaw() { return look.yaw; },
    get pitch() { return look.pitch; },
    get lens() { return look.lens; },
    get state() { return { ...look }; },
    eyeHeight,

    /** Set any of yaw, pitch (degrees) and lens (mm); each is clamped. */
    look({ yaw, pitch, lens } = {}) {
      look.yaw = clamp(finite(yaw, look.yaw), -YAW_LIMIT, YAW_LIMIT);
      look.pitch = clamp(finite(pitch, look.pitch), PITCH_MIN, PITCH_MAX);
      look.lens = clamp(finite(lens, look.lens), LENS_MIN, LENS_MAX);
      return rig;
    },
    lookBy(dYaw = 0, dPitch = 0) { return rig.look({ yaw: look.yaw + dYaw, pitch: look.pitch + dPitch }); },
    /** factor > 1 zooms in (a longer lens). */
    zoomBy(factor) { return rig.look({ lens: look.lens * finite(factor, 1) }); },
    /** Look ahead again. The lens stays as it is unless `lens` is true. */
    reset({ lens = false } = {}) {
      look.yaw = 0; look.pitch = 0;
      if (lens) look.lens = LENS_DEFAULT;
      return rig;
    },

    /**
     * Point `camera` (a PerspectiveCamera) for a pose and viewport. A pure function of
     * (pose, look state, viewport): calling it twice gives the same camera.
     * @param {object} pose from journey.poseAt  @param {{ width?: number, height?: number, aspect?: number }} viewport
     */
    apply(camera, pose, viewport) {
      // body layer (identity): the car's frame is the pose's own
      // head layer (identity): the eye sits eyeHeight along the road normal
      _eye.copy(pose.position).addScaledVector(pose.up, eyeHeight);

      // camera layer: line of sight from the car's forward direction, uprights from true vertical
      localUp(_eye.x, _eye.z, _u);
      _h.copy(pose.forward).addScaledVector(_u, -pose.forward.dot(_u));
      if (_h.lengthSq() < 1e-12) _h.set(0, 0, -1);
      _h.normalize().applyAxisAngle(_u, look.yaw * RAD);
      const grade = Math.asin(clamp(pose.forward.dot(_u), -1, 1));
      const el = grade + look.pitch * RAD;
      _d.copy(_h).multiplyScalar(Math.cos(el)).addScaledVector(_u, Math.sin(el));
      _x.crossVectors(_d, _u).normalize(); // right
      _y.crossVectors(_x, _d); // up, no roll against true vertical
      _m.makeBasis(_x, _y, _d.clone().negate());

      const aspect = aspectOf(viewport);
      const fov = verticalFov(look.lens, aspect);
      camera.position.copy(_eye);
      camera.quaternion.setFromRotationMatrix(_m);
      camera.aspect = aspect;
      camera.fov = fov;
      camera.near = nearFor(_d, _y, pose.up, eyeHeight, fov);
      camera.far = FAR;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      return camera;
    },
  };
  return rig;
}

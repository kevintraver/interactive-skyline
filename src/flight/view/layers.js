// The flight's view layers (plan 03, section 7.6; F1.5 on plan 1's renderer): puts the airframe and the cabin into the
// scene on one body group, places the app's one camera at the passenger's eye each frame, sets its near and far, and
// gives the camera back exactly as it was.
//
// One camera and one scene pass (decisions for the build, 2026-11-23): plan 1's depth buffer (reversed on WebGPU,
// logarithmic on WebGL2 without clip control) holds 2 cm to the horizon in one pass, so the window frame, the wing and
// the world are drawn together. The cabin's meshes sit on CABIN_LAYER only, which the camera enables while flying:
// picking rays (layer 0) pass through the window to the city, and F3.9 can move the cabin into its own afterAA pass
// by changing the layers, not the meshes.

import { Group, Vector3, Quaternion } from 'three';
import { horizonDistance, altitudeOf } from '../../core/earth.js';
import { HIGHEST } from '../terrain/nested.js';
import { placeAirframe } from '../aircraft/airframe.js';
import { CABIN_LAYER } from '../cabin/cabin.js';

export { CABIN_LAYER };

/** The near plane: the eye comes within 5 cm of the trim and the pane, and the corner rays of the widest lens
 * (13 mm) are 59 degrees off axis, so a surface 4 cm away is still 2 cm deep. */
export const NEAR = 0.02;
/** How far beyond the eye's horizon a summit can still show: the horizon of the region's highest ground (Mount
 * Whitney, 4,421 m, src/flight/terrain/nested.js HIGHEST), 256 km. */
export const SUMMIT_REACH = horizonDistance(HIGHEST);
/**
 * The far plane's ceiling: 700 km, reached at 41,500 ft (431 km + 256 km). Depth holds it on both backends (plan 01's
 * schemes: reversed float depth on WebGPU, whose resolution does not depend on the far plane, and logarithmic depth on
 * WebGL2, whose resolution scales with log2(far): 700 km costs it 3% against section 7.6's old 480 km cap;
 * tests/unit/flight/layers.test.js works both through).
 */
export const FAR_MAX = 700000;

/**
 * Near and far planes for an eye `altitude` metres above sea level (on the app's refraction sphere, earth.js
 * altitudeOf): 2 cm, and the eye's horizon plus SUMMIT_REACH, at most FAR_MAX (F6.2). That is everything that can be
 * seen: ground nearer than the eye's horizon, and summits up to 4,421 m beyond it. At cruise the old horizon + 80 km
 * cut the ranges beyond it off flat. An altitude below 2 m or not a number counts as 2 m.
 */
export function nearFar(altitude) {
  const h = Number.isFinite(altitude) ? Math.max(altitude, 2) : altitude === Infinity ? Infinity : 2;
  return { near: NEAR, far: Math.min(horizonDistance(h) + SUMMIT_REACH, FAR_MAX) };
}

/**
 * The eye in the scene: an AircraftState's position and quaternion carry the head pose from body axes.
 * @param {{ position: Vector3, quaternion: Quaternion }} state
 * @param {{ eye: Vector3, quaternion: Quaternion }} pose  body-axes eye pose (headRig.headPose)
 * @param {Vector3} outPosition  @param {Quaternion} outQuaternion
 */
export function eyeInScene(state, pose, outPosition, outQuaternion) {
  outPosition.copy(pose.eye).applyQuaternion(state.quaternion).add(state.position);
  outQuaternion.copy(state.quaternion).multiply(pose.quaternion);
  return outPosition;
}

/** What the flight changes on the camera, copied so it can be put back bit for bit. */
function snapshot(camera) {
  return {
    position: camera.position.clone(), quaternion: camera.quaternion.clone(), scale: camera.scale.clone(), up: camera.up.clone(),
    fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect, zoom: camera.zoom, focus: camera.focus,
    filmGauge: camera.filmGauge, filmOffset: camera.filmOffset, view: camera.view ? { ...camera.view } : null,
    mask: camera.layers.mask, matrixAutoUpdate: camera.matrixAutoUpdate,
  };
}

function restore(camera, s) {
  camera.position.copy(s.position); camera.quaternion.copy(s.quaternion); camera.scale.copy(s.scale); camera.up.copy(s.up);
  Object.assign(camera, { fov: s.fov, near: s.near, far: s.far, aspect: s.aspect, zoom: s.zoom, focus: s.focus, filmGauge: s.filmGauge, filmOffset: s.filmOffset, matrixAutoUpdate: s.matrixAutoUpdate });
  camera.view = s.view ? { ...s.view } : null;
  camera.layers.mask = s.mask;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/**
 * @param {{ scene: import('three').Scene, camera: import('three').PerspectiveCamera,
 *           airframe: { group: import('three').Object3D }, cabin?: { group: import('three').Object3D },
 *           rig: ReturnType<import('../cabin/headRig.js').createHeadRig> }} opts
 */
export function createFlightLayers({ scene, camera, airframe, cabin = null, rig, base = 0 }) {
  const body = new Group();
  body.name = 'flight-body';
  body.add(airframe.group);
  if (cabin) body.add(cabin.group);
  let saved = null, clean = false, currentCabin = cabin;
  const _pose = { eye: new Vector3(), quaternion: new Quaternion() };

  const layers = {
    body,
    get clean() { return clean; },
    get attached() { return !!saved; },

    /** Add the aircraft to the scene and take the camera (saving it first). */
    attach() {
      if (saved) return layers;
      saved = snapshot(camera);
      scene.add(body);
      camera.layers.enable(CABIN_LAYER);
      return layers;
    },
    /** Remove the aircraft and give the camera back exactly. */
    detach() {
      if (!saved) return layers;
      scene.remove(body);
      restore(camera, saved);
      saved = null;
      return layers;
    },
    /** Put back the camera as it was at attach(), without detaching (the next update() moves it again). */
    restoreCamera() { if (saved) restore(camera, saved); return layers; },

    /** Swap the cabin (another seat); the old one is returned to its owner to dispose. */
    setCabin(next) {
      if (currentCabin) body.remove(currentCabin.group);
      currentCabin = next;
      if (next) { body.add(next.group); next.group.visible = !clean; }
      return layers;
    },

    /** Key C: no cabin, and the eye at the pane. Returns the state now. */
    cleanView(on = !clean) {
      clean = !!on;
      if (currentCabin) currentCabin.group.visible = !clean;
      return clean;
    },

    /**
     * Place the aircraft and the camera for an AircraftState. A pure function of (state, look, viewport): calling it
     * twice gives the same camera.
     * @param {{ position: Vector3, quaternion: Quaternion }} state
     * @param {{ aspect: number, shake?: object }} view  shake: the head shake (headRig.headShake), passed to the rig
     */
    update(state, { aspect, shake } = {}) {
      placeAirframe(body, state);
      rig.pose(shake ? { clean, shake } : { clean }, _pose);
      eyeInScene(state, _pose, camera.position, camera.quaternion);
      const { near, far } = nearFar(altitudeOf(camera.position, { base }));
      camera.aspect = aspect > 0 ? aspect : camera.aspect;
      camera.fov = rig.fov(camera.aspect);
      camera.near = near;
      camera.far = far;
      camera.zoom = 1; // the lens is the rig's; a view offset (camera.view) is the mode's to keep or clear
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      return camera;
    },
  };
  return layers;
}

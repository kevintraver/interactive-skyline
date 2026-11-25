// The flight's view layers (plan 03, section 7.6; F1.5 and F3.9 on plan 1's renderer): puts the airframe into the
// scene on the body group, keeps the cabin in a scene of its own that follows the body, places the app's one camera at
// the passenger's eye each frame, sets its near and far, and gives the camera back exactly as it was.
//
//   WORLD and AIRFRAME   the scene pass, the app's camera: plan 1's depth buffer (reversed on WebGPU, logarithmic on
//                        WebGL2 without clip control) holds 2 cm to the horizon in one pass
//   CABIN                its own scene (cabinScene) and camera (cabinCamera(): the app camera's pose and lens, the
//                        cabin layer, 2 cm to 6 m), drawn by the cabin stage (view/cabinStage.js) after the world's
//                        anti-aliasing and composed over it. Not in the scene: the scene pass, picking (layer 0), the
//                        world's exposure and bloom's source never see it.

import { Group, Scene, Vector3, Quaternion, PerspectiveCamera } from 'three';
import { horizonDistance, altitudeOf } from '../../core/earth.js';
import { HIGHEST } from '../terrain/nested.js';
import { placeAirframe } from '../aircraft/airframe.js';
import { CABIN_LAYER } from '../cabin/cabin.js';

export { CABIN_LAYER };

/** The cabin pass's near and far planes (7.6's table): the eye comes within 5 cm of the trim, and nothing of the
 * cabin drawn is further than its 5 m half length and the far side. */
export const CABIN_NEAR = 0.02, CABIN_FAR = 6;

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
  // the cabin's own scene: a root that copies the body's world matrix each frame (no sky, fog, lights or world in it)
  const cabinScene = new Scene();
  cabinScene.name = 'flight-cabin';
  const cabinRoot = new Group();
  cabinRoot.name = 'flight-cabin-root';
  cabinRoot.matrixAutoUpdate = false;
  cabinRoot.visible = false;
  cabinScene.add(cabinRoot);
  if (cabin) cabinRoot.add(cabin.group);
  const cabinCam = new PerspectiveCamera();
  cabinCam.layers.set(CABIN_LAYER);
  let saved = null, clean = false, currentCabin = cabin;
  const _pose = { eye: new Vector3(), quaternion: new Quaternion() };

  /** The cabin's root at the body, as drawn (and as rays from the eye find it). */
  function placeCabin() {
    body.updateMatrixWorld(true);
    cabinRoot.matrix.copy(body.matrixWorld);
    cabinRoot.matrixWorldNeedsUpdate = true;
    cabinScene.updateMatrixWorld(true);
  }

  const layers = {
    body,
    cabinScene,
    get clean() { return clean; },
    get attached() { return !!saved; },

    /** Add the aircraft to the scene and take the camera (saving it first). */
    attach() {
      if (saved) return layers;
      saved = snapshot(camera);
      scene.add(body);
      cabinRoot.visible = true;
      return layers;
    },
    /** Remove the aircraft and give the camera back exactly. */
    detach() {
      if (!saved) return layers;
      scene.remove(body);
      cabinRoot.visible = false;
      restore(camera, saved);
      saved = null;
      return layers;
    },
    /** Put back the camera as it was at attach(), without detaching (the next update() moves it again). */
    restoreCamera() { if (saved) restore(camera, saved); return layers; },

    /** Swap the cabin (another seat); the old one is returned to its owner to dispose. */
    setCabin(next) {
      if (currentCabin) cabinRoot.remove(currentCabin.group);
      currentCabin = next;
      if (next) { cabinRoot.add(next.group); next.group.visible = !clean; }
      return layers;
    },

    /** Key C: no cabin, and the eye at the pane. Returns the state now. */
    cleanView(on = !clean) {
      clean = !!on;
      if (currentCabin) currentCabin.group.visible = !clean;
      return clean;
    },

    /** Whether the cabin pass has anything to draw: attached, a cabin, not the clean view. */
    get cabinShown() { return !!saved && !!currentCabin && !clean && currentCabin.group.visible; },

    /**
     * The cabin pass's camera for the app camera as it is now: its pose, lens and view offset, the cabin layer only,
     * CABIN_NEAR to CABIN_FAR. The same object each call.
     */
    cabinCamera() {
      camera.updateMatrixWorld();
      cabinCam.position.copy(camera.position);
      cabinCam.quaternion.copy(camera.quaternion);
      cabinCam.scale.copy(camera.scale);
      Object.assign(cabinCam, { fov: camera.fov, aspect: camera.aspect, zoom: camera.zoom, filmGauge: camera.filmGauge, filmOffset: camera.filmOffset, focus: camera.focus });
      cabinCam.view = camera.view ? { ...camera.view } : null;
      cabinCam.near = CABIN_NEAR;
      cabinCam.far = CABIN_FAR;
      cabinCam.updateProjectionMatrix();
      cabinCam.updateMatrixWorld(true); // the app camera has no parent: its pose is its world pose
      return cabinCam;
    },

    /**
     * Place the aircraft, the cabin and the camera for an AircraftState. A pure function of (state, look, viewport):
     * calling it twice gives the same camera.
     * @param {{ position: Vector3, quaternion: Quaternion }} state
     * @param {{ aspect: number, shake?: object }} view  shake: the head shake (headRig.headShake), passed to the rig
     */
    update(state, { aspect, shake } = {}) {
      placeAirframe(body, state);
      placeCabin();
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

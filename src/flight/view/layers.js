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
import { horizonDistance } from '../../core/earth.js';
import { placeAirframe } from '../aircraft/airframe.js';
import { CABIN_LAYER } from '../cabin/cabin.js';

export { CABIN_LAYER };

/** The near plane: the eye comes within 5 cm of the trim and the pane, and the corner rays of the widest lens
 * (13 mm) are 59 degrees off axis, so a surface 4 cm away is still 2 cm deep. */
export const NEAR = 0.02;
/** Past the horizon, so terrain and haze beyond it are not cut (section 7.6's table). */
export const FAR_MARGIN = 80000;
/** The far plane's ceiling (section 7.6's table). */
export const FAR_MAX = 480000;

/**
 * Near and far planes for an eye `height` metres above the ground: 2 cm, and the horizon distance plus 80 km, at
 * most 480 km. A height at or below the ground counts as 2 m (taxiing, or a terrain error), not as no horizon.
 */
export function nearFar(height) {
  const h = Number.isFinite(height) ? Math.max(height, 2) : 2;
  return { near: NEAR, far: Math.min(horizonDistance(h) + FAR_MARGIN, FAR_MAX) };
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
export function createFlightLayers({ scene, camera, airframe, cabin = null, rig }) {
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
     * @param {{ aspect: number, heightAboveGround?: number }} view  heightAboveGround of the main gear; without it the
     *   gear's scene height is used (about its height above the city's base)
     */
    update(state, { aspect, heightAboveGround } = {}) {
      placeAirframe(body, state);
      rig.pose({ clean }, _pose);
      eyeInScene(state, _pose, camera.position, camera.quaternion);
      const h = (Number.isFinite(heightAboveGround) ? heightAboveGround : state.position.y) + _pose.eye.y;
      const { near, far } = nearFar(h);
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

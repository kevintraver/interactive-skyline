// The aircraft on its wheels: the track gives the body level once the nose wheel is down, while the airframe sits a
// little nose-down on its gear (rig.json groundPitchDeg). The session turns the sampled state by that much about the
// main wheels (body X through the state's origin, the main-gear contact point) before the view layers place the
// airframe, the cabin and the camera, so all three tilt together; the model is then posed with groundPitch: false so
// it does not turn itself a second time. Pure: no scene state.
import { Quaternion, Vector3 } from 'three';
import { groundPitchCorrection } from './aircraft/rig.js';

const X = new Vector3(1, 0, 0), _q = new Quaternion();

/**
 * Turn `state.quaternion` (body -> scene) nose-down about body X by the ground attitude. Returns the angle applied
 * (radians, 0 or negative); 0 and no change in the air, with the gear up, with the nose raised, or before the rig is in.
 * @param {{ quaternion: Quaternion, onGround?: boolean, gear?: number, pitch?: number }} state  @param {{ groundPitchDeg: number } | null} rig
 */
export function applyGroundPitch(state, rig) {
  if (!rig || !Number.isFinite(rig.groundPitchDeg)) return 0;
  const a = groundPitchCorrection(state, rig);
  if (a !== 0) state.quaternion.multiply(_q.setFromAxisAngle(X, a));
  return a;
}

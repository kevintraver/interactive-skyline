// The key light follows the environment (plan 01, section 7.6; task T1.3). Interim, on today's one directional
// light and its one shadow map: the shadow square stays where the city put it (cities.json `shadow`) and is
// re-aimed at the Sun or the Moon. The shadow map is redrawn only when the light has moved more than 0.1 degree,
// not on every frame of a scrub; phase 3 replaces this with cascades that follow the camera.
import * as THREE from 'three';

/** Redraw the shadow map once the key light has turned this far since the last redraw. */
export const SHADOW_STEP_DEG = 0.1;
const STEP_COS = Math.cos(THREE.MathUtils.degToRad(SHADOW_STEP_DEG));

/** @param {{ sun: THREE.DirectionalLight, renderer: THREE.WebGLRenderer, shade: { half: number } }} o */
export function createKeyLight({ sun, renderer, shade }) {
  const distance = shade.half * 2.5;
  let drawn = null; // the direction the shadow map was last drawn from
  return {
    /** Point the light along `dir` (unit, toward the body); redraw the shadow map if it moved enough. */
    aim(dir) {
      sun.position.copy(dir).multiplyScalar(distance).add(sun.target.position);
      if (!drawn || drawn.dot(dir) < STEP_COS) {
        renderer.shadowMap.needsUpdate = true;
        drawn = (drawn || new THREE.Vector3()).copy(dir);
      }
    },
    /** Forget the last drawn direction (the pinned light was restored, or the scene changed). */
    reset() { drawn = null; },
  };
}

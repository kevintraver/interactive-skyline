// Camera moves: gliding to a building, the zoom buttons and the compass.
import * as THREE from 'three';
import { stopMomentum } from './cameraLimits.js';

const lerp = THREE.MathUtils.lerp;

export function initFocus(app) {
  const { camera, controls, invalidate, base: BASE } = app;
  let flight = null; // a camera move in progress: { t0, dur, at(k) } with k easing from 0 to 1
  function fly(dur, at) {
    stopMomentum(controls); // the glide ends where it says, not pushed aside by the rest of the last drag
    flight = { t0: performance.now(), dur, at };
  }
  /** Glide the camera so one building sits in the middle of the view, keeping the current viewing direction. */
  function focusOn(entry) {
    if (app.drive.active) return app.drive.focus(entry); // drive seam: turn the head instead
    const b = entry.data;
    const q0 = controls.target.clone(), q1 = new THREE.Vector3(b.c[0], b.ground - BASE + b.h * 0.5, -b.c[1]).add(entry.offset);
    const dir = camera.position.clone().sub(controls.target).normalize();
    if (dir.y < 0.28) { dir.y = 0.28; dir.normalize(); } // from a little above, so neighbours don't block it
    const dist = THREE.MathUtils.clamp(b.h * 7 + 550, 800, 1700); // far enough to see it among its neighbours
    const p0 = camera.position.clone(), p1 = q1.clone().addScaledVector(dir, dist);
    fly(750, (k) => { camera.position.lerpVectors(p0, p1, k); controls.target.lerpVectors(q0, q1, k); });
  }
  /** Swing the camera around its target: `turn` multiplies the compass angle, `zoom` the distance. */
  function orbitTo({ turn = 1, zoom = 1 }) {
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)), to = from.clone();
    to.theta *= turn;
    to.radius = THREE.MathUtils.clamp(from.radius * zoom, controls.minDistance, controls.maxDistance);
    const at = new THREE.Spherical();
    fly(350, (k) => {
      at.set(lerp(from.radius, to.radius, k), from.phi, lerp(from.theta, to.theta, k));
      camera.position.setFromSpherical(at).add(controls.target);
    });
  }
  controls.addEventListener('start', () => { flight = null; });
  function stepFlight(now) {
    if (!flight) return;
    const t = Math.min((now - flight.t0) / flight.dur, 1);
    flight.at(t * t * (3 - 2 * t));
    if (t === 1) flight = null;
    invalidate();
  }
  document.getElementById('zoom-in').addEventListener('click', () => orbitTo({ zoom: 0.6 }));
  document.getElementById('zoom-out').addEventListener('click', () => orbitTo({ zoom: 1 / 0.6 }));
  const compass = document.getElementById('compass');
  compass.addEventListener('click', () => orbitTo({ turn: 0 }));
  controls.addEventListener('change', () => { compass.firstElementChild.style.rotate = `${controls.getAzimuthalAngle()}rad`; });
  Object.assign(app, { focusOn, stepFlight, flying: () => !!flight });
  app.stopFlight = () => { flight = null; }; // drive seam
}

// ?journey=test (plan 01, task T1.8): a 120-second straight camera track across the valley that exists only to
// exercise the journey contract (section 11.3); the drive and flight plans bring the real ones.
import * as THREE from 'three';

export function testJourney(app) {
  const { camera, controls, groundY, city } = app;
  // west to east through the city origin, 450 m above the ground, looking ahead and a little down
  const half = Math.min(6000, (city.terrain.near.x1 - city.terrain.near.x0) / 2);
  const from = new THREE.Vector3(-half, 0, 1500), to = new THREE.Vector3(half, 0, 1500);
  const at = new THREE.Vector3(), ahead = new THREE.Vector3();
  const place = (p, out, f) => {
    out.lerpVectors(from, to, f);
    out.y = groundY(out.x, -out.z) + p;
    return out;
  };
  return {
    id: 'test', label: 'Test journey', durationS: 120,
    markers: [{ progressS: 60, label: 'Origin' }],
    onProgress(progressS) {
      const f = progressS / 120;
      place(450, at, f);
      place(0, ahead, f + 0.25); // (past the end of the track is fine: it is only where the camera looks)
      camera.position.copy(at);
      controls.target.copy(ahead);
      app.invalidate();
    },
  };
}

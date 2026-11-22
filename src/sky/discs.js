// Sun and Moon discs on the legacy dome (plan 01, task T1.6). Interim: two camera-facing quads 110 km out, at the
// bodies' true angular sizes, drawn after the opaque scene so terrain and buildings hide them; replaced by the
// atmosphere's own Sun and the textured Moon in T3.3. Shown only in the clock state, so the pinned looks (and the
// golden screenshots) never draw them.
//
// The Moon's quad shades a sphere lit from the Sun's direction, so its phase and the tilt of its terminator are
// right for the instant: the normal of each fragment is rebuilt from the quad's own axes.
import * as THREE from 'three';

const DISTANCE = 110000;
const HALO = 4; // the Sun's quad reaches four disc radii, for a soft glow
const SUN_DIST_M = 1.496e11, MOON_DIST_M = 3.844e8;

const VERTEX = 'varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const SUN_FRAGMENT = `uniform vec3 color; uniform float strength; varying vec2 vUv;
void main(){
  float r = length(vUv) * ${HALO.toFixed(1)};
  float disc = 1.0 - smoothstep(0.92, 1.04, r);
  float limb = 1.0 - 0.35 * (1.0 - sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0))));
  float glow = 0.22 * exp(-2.2 * max(r - 1.0, 0.0)) * (1.0 - disc) * step(r, ${HALO.toFixed(1)});
  gl_FragColor = vec4(color * strength * (disc * limb + glow), 1.0);
}`;
const MOON_FRAGMENT = `uniform vec3 color; uniform float strength; uniform vec3 lightDir; uniform vec3 axisX; uniform vec3 axisY; uniform vec3 axisZ;
varying vec2 vUv;
void main(){
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  vec3 n = axisX * vUv.x + axisY * vUv.y + axisZ * sqrt(1.0 - r2);
  float lit = smoothstep(-0.015, 0.015, dot(n, lightDir));
  float edge = 1.0 - smoothstep(0.94, 1.0, sqrt(r2));
  gl_FragColor = vec4(color * strength * lit * edge * (0.86 + 0.14 * sqrt(1.0 - r2)), 1.0);
}`;

function quad(fragmentShader, uniforms) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    vertexShader: VERTEX, fragmentShader, uniforms, transparent: true, depthWrite: false, depthTest: true, fog: false,
    blending: THREE.AdditiveBlending,
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  return mesh;
}

export function createDiscs(scene) {
  const sun = quad(SUN_FRAGMENT, { color: { value: new THREE.Color(1, 0.97, 0.9) }, strength: { value: 1 } });
  const moon = quad(MOON_FRAGMENT, {
    color: { value: new THREE.Color(0.93, 0.93, 0.9) }, strength: { value: 1 }, lightDir: { value: new THREE.Vector3(0, 1, 0) },
    axisX: { value: new THREE.Vector3(1, 0, 0) }, axisY: { value: new THREE.Vector3(0, 1, 0) }, axisZ: { value: new THREE.Vector3(0, 0, 1) },
  });
  sun.name = 'sun disc';
  moon.name = 'moon disc';
  const dirs = { sun: new THREE.Vector3(0, 1, 0), moon: new THREE.Vector3(0, 1, 0) };
  const radius = { sun: 0, moon: 0 };
  const place = (mesh, dir, angularRadius, camera) => {
    mesh.position.copy(camera.position).addScaledVector(dir, DISTANCE);
    mesh.lookAt(camera.position); // +z toward the eye; the roll follows the world's up
    mesh.scale.setScalar(DISTANCE * Math.tan(angularRadius) * (mesh === sun ? HALO : 1));
    mesh.updateMatrixWorld();
  };
  sun.onBeforeRender = (renderer, s, camera) => place(sun, dirs.sun, radius.sun, camera);
  moon.onBeforeRender = (renderer, s, camera) => {
    place(moon, dirs.moon, radius.moon, camera);
    const e = moon.matrixWorld.elements, u = moon.material.uniforms;
    u.axisX.value.set(e[0], e[1], e[2]).normalize();
    u.axisY.value.set(e[4], e[5], e[6]).normalize();
    u.axisZ.value.set(e[8], e[9], e[10]).normalize();
  };
  scene.add(sun, moon);

  const toSun = new THREE.Vector3();
  return {
    sun, moon,
    /** Follow env.state; `show` false hides both (the pinned looks). `nightValue` 0 by day, 1 at night. */
    update(state, show, nightValue = 1) {
      sun.visible = !!show && state.sun.altDeg > -2;
      moon.visible = !!show && state.moon.altDeg > -2;
      if (!show) return;
      dirs.sun.copy(state.sun.dir);
      dirs.moon.copy(state.moon.dir);
      radius.sun = state.sun.angularRadiusRad;
      radius.moon = state.moon.angularRadiusRad;
      sun.material.uniforms.color.value.copy(state.sun.color).multiplyScalar(0.9);
      // light on the Moon comes from the Sun as seen from the Moon
      toSun.copy(state.sun.dir).multiplyScalar(SUN_DIST_M).addScaledVector(state.moon.dir, -MOON_DIST_M).normalize();
      moon.material.uniforms.lightDir.value.copy(toSun);
      // a pale disc on the blue day sky, bright at night
      moon.material.uniforms.strength.value = 0.35 + 0.6 * nightValue;
    },
    dispose() {
      for (const m of [sun, moon]) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    },
  };
}

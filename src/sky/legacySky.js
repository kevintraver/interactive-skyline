// Today's sky: a two-colour dome, exponential fog, a hemisphere light and one fixed sun, switched between two
// hand-tuned looks. Behind three functions (init, apply, dispose) so phase 1 can drive it from the clock and
// phase 3 can delete it in one commit (plan 01, section 5.6).
import * as THREE from 'three';
import { night } from '../night.js';

// Sky, haze and light, by day and by night. `street` is how strongly the ground glows from street lighting
// (near grid, far grid); the moon stands in for the sun so shadows stay where they are.
export const DAY = { haze: 0xd3dee8, zenith: 0x4f86c9, skyLight: 0xdbe8ff, groundLight: 0x8d8371, hemi: 0.8, sun: 0xfff0dc, sunPower: 2.7, tint: 0.45, street: [0, 0] };
export const NIGHT = { haze: 0x3b3850, zenith: 0x05070f, skyLight: 0x33426e, groundLight: 0x4a3a2a, hemi: 0.38, sun: 0x93a8d9, sunPower: 0.2, tint: 0.16, street: [0.07, 0.26] };
const STREET_GLOW = 0xffa858;

export function createLegacySky() {
  const HAZE = new THREE.Color(DAY.haze), ZENITH = new THREE.Color(DAY.zenith);
  const sky = {
    sun: null, hemi: null, dome: null, scene: null, invalidate: null,
    /** Add fog, dome and lights to the scene. */
    init({ scene, city, invalidate }) {
      sky.scene = scene;
      sky.invalidate = invalidate;
      scene.fog = new THREE.FogExp2(HAZE, 0.000014);
      sky.dome = new THREE.Mesh(
        new THREE.SphereGeometry(120000, 32, 16),
        new THREE.ShaderMaterial({
          side: THREE.BackSide, depthWrite: false, fog: false,
          uniforms: { horizon: { value: HAZE }, zenith: { value: ZENITH } },
          vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; varying vec3 d;
      void main(){ float t = pow(clamp(d.y, 0.0, 1.0), 0.45); gl_FragColor = vec4(mix(horizon, zenith, t), 1.0); }`,
        }),
      );
      scene.add(sky.dome);

      const hemi = sky.hemi = new THREE.HemisphereLight(DAY.skyLight, DAY.groundLight, DAY.hemi);
      scene.add(hemi);
      const sun = sky.sun = new THREE.DirectionalLight(DAY.sun, DAY.sunPower);
      // afternoon sun in the west-southwest, 32 degrees up
      const az = THREE.MathUtils.degToRad(245), el = THREE.MathUtils.degToRad(32);
      // the shadow map covers a square around the towers, sized per city
      const shade = city.shadow;
      sun.target.position.set(shade.x, 0, -shade.y);
      sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(shade.half * 2.5).add(sun.target.position);
      sun.castShadow = true;
      sun.shadow.mapSize.set(4096, 4096);
      Object.assign(sun.shadow.camera, { left: -shade.half, right: shade.half, top: shade.half, bottom: -shade.half, near: shade.half * 0.5, far: shade.half * 4.5 });
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 1.2;
      scene.add(sun, sun.target);
      return sky;
    },
    /**
     * Switch sky, haze, light and street glow between day and night. Buildings follow the shared `night` uniform.
     * `terrain` is [{ mesh }] for the far and near ground; `imagery` whether the aerial photo is shown.
     */
    apply({ night: isNight, imagery, terrain }) {
      const look = isNight ? NIGHT : DAY;
      night.value = isNight ? 1 : 0;
      HAZE.set(look.haze);
      sky.scene.fog.color.copy(HAZE); // the fog keeps its own copy of the haze color
      ZENITH.set(look.zenith);
      sky.hemi.color.set(look.skyLight);
      sky.hemi.groundColor.set(look.groundLight);
      sky.hemi.intensity = look.hemi;
      sky.sun.color.set(look.sun);
      sky.sun.intensity = look.sunPower;
      terrain.forEach((t, i) => {
        t.mesh.material.emissive.set(STREET_GLOW);
        // without the photo there is no street pattern to light, so keep the plain ground dim
        t.mesh.material.emissiveIntensity = look.street[i] * (imagery ? 1 : 0.3);
      });
      sky.invalidate();
    },
    /** How strongly removable towers glow blue in this look. */
    tint: (isNight) => (isNight ? NIGHT : DAY).tint,
    dispose() {
      sky.scene.remove(sky.dome, sky.hemi, sky.sun, sky.sun.target);
      sky.dome.geometry.dispose();
      sky.dome.material.dispose();
      sky.sun.shadow.dispose();
      sky.scene.fog = null;
    },
  };
  return sky;
}

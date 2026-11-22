// Falling rain near the camera (plan 02, phase 8): MAX_DROPS instanced streaks (rain.glsl.js), as many drawn as the
// rain rate asks for (rainMirror.js dropCount). The drops' places are a pure function of simulation time
// (rainMirror.js); everything that depends on the camera is set in the mesh's onBeforeRender, with the camera the
// frame is drawn from, in double precision on the CPU. Lit by the visitor's low beam (brightest in the beam) at night
// and by the sky by day.

import * as THREE from 'three';
import { rainVertex, rainFragment } from './rain.glsl.js';
import { BOX_M, AHEAD_M, CLASS_MM, MAX_DROPS, BACKSCATTER, DAY_CONTRAST, STREAK_GAIN, LOW_PEAK_CD, dropSeed, dropCount, dropVelocity, rainOffsets, shutterAt } from './rainMirror.js';

/** The car's box for leaving drops out of the cabin (half width, roof, half length, floor; metres from its road point). */
const CAR_BOX = [1.0, 1.75, 2.5, -0.3];
/** The headlamps relative to the car's road point (car frame: right, up, forward), as headlights.js places them. */
const LAMPS = [[-0.7, 0.65, 2.85], [0.7, 0.65, 2.85]];

export function createRain({ parent, maxDrops = MAX_DROPS }) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([0, -1, 1, -1, 1, 1, 0, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(4 * maxDrops);
  for (let i = 0; i < maxDrops; i++) seeds.set(dropSeed(i), 4 * i);
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = 0;
  const uniforms = {
    uBox: { value: BOX_M },
    uOff: { value: CLASS_MM.map(() => new THREE.Vector3()) },
    uStreak: { value: CLASS_MM.map(() => new THREE.Vector3()) },
    uDiam: { value: new THREE.Vector4(...CLASS_MM.map((d) => d / 1000)) },
    uCentre: { value: new THREE.Vector3() },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uPixelAngle: { value: 1e-3 },
    uLamp: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uCar: { value: new THREE.Matrix3() },
    uLight: { value: new THREE.Vector4(0, 0.1, BACKSCATTER * STREAK_GAIN, DAY_CONTRAST * STREAK_GAIN) },
    uSky: { value: new THREE.Color() },
    uLampColour: { value: new THREE.Color(1, 0.95, 0.86).multiplyScalar(1 / (0.2126 + 0.7152 * 0.95 + 0.0722 * 0.86)) },
    uCarRel: { value: new THREE.Vector3() },
    uCarBox: { value: new THREE.Vector4(...CAR_BOX) },
    uVisibility: { value: 80000 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'rain', uniforms, vertexShader: rainVertex, fragmentShader: rainFragment,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'rain';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 12;
  mesh.visible = false;
  parent.add(mesh);

  // what onBeforeRender needs, set by update()
  let state = null, simMs = 0, rate = 1, pose = null, units = 0.1, beamGain = 0;
  const size = new THREE.Vector2(), camPos = new THREE.Vector3(), camDir = new THREE.Vector3();
  const basis = new THREE.Matrix3();

  mesh.onBeforeRender = (renderer, scene, camera) => {
    if (!state || !pose) return;
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    const centre = [camPos.x + camDir.x * AHEAD_M, camPos.y + camDir.y * AHEAD_M, camPos.z + camDir.z * AHEAD_M];
    const off = rainOffsets(simMs, state, centre);
    const sh = shutterAt(rate);
    const car = pose.forward, s = pose.speed || 0;
    for (let c = 0; c < 4; c++) {
      uniforms.uOff.value[c].set(off[c][0], off[c][1], off[c][2]);
      const v = dropVelocity(state, c);
      uniforms.uStreak.value[c].set((v[0] - car.x * s) * sh, (v[1] - car.y * s) * sh, (v[2] - car.z * s) * sh);
    }
    uniforms.uCentre.value.set(centre[0] - camPos.x, centre[1] - camPos.y, centre[2] - camPos.z);
    renderer.getDrawingBufferSize(size);
    uniforms.uViewport.value.copy(size);
    const fov = camera.isPerspectiveCamera ? camera.getEffectiveFOV() : 50;
    uniforms.uPixelAngle.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, size.y);
    const p = pose.position, r = pose.right, u = pose.up, f = pose.forward;
    uniforms.uCarRel.value.set(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z);
    basis.set(r.x, u.x, f.x, r.y, u.y, f.y, r.z, u.z, f.z);
    uniforms.uCar.value.copy(basis);
    LAMPS.forEach(([x, y, z], i) => uniforms.uLamp.value[i].set(
      p.x + r.x * x + u.x * y + f.x * z - camPos.x, p.y + r.y * x + u.y * y + f.y * z - camPos.y, p.z + r.z * x + u.z * y + f.z * z - camPos.z));
    uniforms.uLight.value.x = LOW_PEAK_CD * beamGain;
    uniforms.uLight.value.y = units;
  };

  return {
    mesh, uniforms,
    get drops() { return mesh.visible ? geometry.instanceCount : 0; },
    /**
     * @param {{ state: object, simMs: number, rate: number, pose: object, units: number, beams: number, sky: THREE.Color }} f
     *   beams: the headlamps' drawn strength (0 off, 1 on at night); sky: the sky's radiance near the horizon
     */
    update(f) {
      const n = Math.min(maxDrops, dropCount(f.state.precipMmPerHour));
      mesh.visible = n > 0;
      geometry.instanceCount = n;
      if (!n) { state = null; return; }
      state = f.state; simMs = f.simMs; rate = f.rate; pose = f.pose; units = f.units; beamGain = f.beams;
      uniforms.uSky.value.copy(f.sky);
      uniforms.uVisibility.value = f.state.visibilityM;
    },
    dispose() { parent.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}

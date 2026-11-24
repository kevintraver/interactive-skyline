// The modelled airframe in the scene (plan 03, section 7.8; F3.4, F3.8): airframe.glb loaded with GLTFLoader, its
// named nodes posed from an AircraftState through rig.js, the wheels on the runway, the wing's own materials for the
// flex, and the baked light attributes decoded.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildAirframeModel, decodeBaked } from '../../../src/flight/aircraft/model.js';
import { createEnvNodes } from '../../../src/env/nodes.js';

const rig = JSON.parse(readFileSync(new URL('../../../public/models/aircraft/rig.json', import.meta.url), 'utf8'));
const buf = readFileSync(new URL('../../../public/models/aircraft/airframe.glb', import.meta.url));
const parse = () => new Promise((resolve, reject) =>
  new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject));
const nodes = createEnvNodes({ state: null });
const RAD = Math.PI / 180;
const rest = { flap: 0, slat: 0, gear: 0, speedbrake: 0, groundSpoiler: 0, reverser: 0, lights: 0, onGround: false, pitch: 0, roll: 0, ias: 120, turbulence: 0 };

/** Lowest point of a node's meshes in the frame the root is placed in (the track's body frame). */
function lowest(model, name) {
  model.root.updateMatrixWorld(true);
  const inv = model.root.parent ? model.root.parent.matrixWorld.clone().invert() : new THREE.Matrix4(), v = new THREE.Vector3();
  let min = Infinity;
  model.parts.get(name).traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv); if (v.y < min) min = v.y; }
  });
  return min;
}

const model = buildAirframeModel((await parse()).scene, rig, { nodes });

describe('buildAirframeModel', () => {
  it('keeps every node rig.json moves, on its pivot, and hides the shadow proxy', () => {
    for (const p of rig.parts) {
      const o = model.parts.get(p.node);
      expect(o, p.node).toBeTruthy();
      const w = o.getWorldPosition(new THREE.Vector3());
      model.root.worldToLocal(w);
      expect(w.distanceTo(new THREE.Vector3(...p.pivot)), p.node).toBeLessThan(2e-3);
    }
    expect(model.root.getObjectByName('ShadowProxy').visible).toBe(false);
  });

  it('counts its triangles and draw calls without the proxy', () => {
    expect(model.triangles).toBeGreaterThan(15000);
    expect(model.triangles).toBeLessThan(60000);
    expect(model.drawCalls).toBe(64);
  });

  it('poses a part as rest + t and turns it by r about its axis', () => {
    model.update({ ...rest, flap: 30, slat: 2, gear: 1 }, { wallS: 0 });
    const p = rig.parts.find((x) => x.node === 'FlapInboard_R');
    const o = model.parts.get('FlapInboard_R'), row = p.tables.flap.find((r) => r.at === 30);
    const expectQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...p.axis), row.r * RAD);
    expect(o.quaternion.angleTo(expectQ)).toBeLessThan(1e-6);
    expect(o.position.distanceTo(model.rest.get('FlapInboard_R').clone().add(new THREE.Vector3(...row.t)))).toBeLessThan(1e-6);
    // the flap's trailing edge goes down and aft
    expect(model.parts.get('MainGear_L').quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
  });

  it('stands the main and nose wheels on the runway when the track says the aircraft is on it', () => {
    model.update({ ...rest, gear: 1, onGround: true, pitch: 0, ias: 0 }, { wallS: 0 });
    for (const n of ['MainGear_L', 'MainGear_R', 'NoseGear']) expect(Math.abs(lowest(model, n)), n).toBeLessThan(0.03);
  });

  it('leaves the ground pitch to the caller when asked (the caller turned the whole body, cabin and camera with it)', () => {
    model.update({ ...rest, gear: 1, onGround: true, pitch: 0, ias: 0 }, { wallS: 0, groundPitch: false });
    expect(model.root.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    expect(lowest(model, 'NoseGear')).toBeGreaterThan(0.15);
  });

  it('touches down on the main wheels with the nose up', () => {
    model.update({ ...rest, gear: 1, onGround: true, pitch: 6 * RAD, ias: 70 }, { wallS: 0 });
    expect(Math.abs(lowest(model, 'MainGear_R'))).toBeLessThan(0.03);
    expect(lowest(model, 'NoseGear')).toBeGreaterThan(0.2);
  });

  it('folds the gear up into the body', () => {
    model.update({ ...rest, gear: 0 }, { wallS: 0 });
    expect(lowest(model, 'MainGear_R')).toBeGreaterThan(0.8);
    expect(lowest(model, 'NoseGear')).toBeGreaterThan(0.8);
  });

  it('gives the wing and what it carries their own flexing materials, and the body none', () => {
    const wingMats = new Set(), bodyMats = new Set();
    model.parts.get('Wing_R').traverse((o) => { if (o.isMesh) wingMats.add(o.material); });
    model.parts.get('Body').traverse((o) => { if (o.isMesh) bodyMats.add(o.material); });
    for (const m of wingMats) { expect(m.isNodeMaterial).toBe(true); expect(m.positionNode).toBeTruthy(); expect(m.emissiveNode).toBeTruthy(); }
    for (const m of bodyMats) { expect(m.positionNode).toBeFalsy(); expect(m.emissiveNode).toBeTruthy(); }
    for (const m of wingMats) expect(bodyMats.has(m)).toBe(false);
  });

  it('sets the flex of each tip from the state, up in flight and down at touchdown', () => {
    model.update({ ...rest }, { wallS: 0 });
    expect(model.flex.tipR).toBeCloseTo(rig.flex.tipDeflection1g, 6);
    model.update({ ...rest, onGround: true, ias: 70, gear: 1, groundSpoiler: 1, pitch: 6 * RAD }, { wallS: 0 });
    expect(model.flex.tipR).toBeLessThan(0.2);
    model.update({ ...rest }, { wallS: 0, flex: false });
    expect(model.flex.tipR).toBe(0);
  });

  it('sets the lamp uniforms from the bits and presentation time', () => {
    model.update({ ...rest, lights: 1 | 8 }, { wallS: 0.5 });
    const [i0, i1] = model.lampUniforms.map((u) => u.value);
    expect(i0.x).toBeGreaterThan(0); // NAV
    expect(i0.w).toBeGreaterThan(0); // LANDING
    expect(i0.y).toBe(0);
    expect(i1.x + i1.y + i1.z + i1.w).toBe(0);
  });
});

describe('decodeBaked', () => {
  it('undoes the sRGB encoding the bake stores the irradiance in', () => {
    expect(decodeBaked(0)).toBe(0);
    expect(decodeBaked(1)).toBeCloseTo(1, 9);
    expect(decodeBaked(0.0987)).toBeCloseTo(0.0098, 4);
    expect(decodeBaked(0.3813)).toBeCloseTo(0.1199, 3);
  });
});

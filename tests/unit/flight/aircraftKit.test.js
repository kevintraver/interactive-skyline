// The aircraft kit (plan 03, F3.2): a two-part model built by models/aircraft/build_kit_fixture.py with
// models/aircraft/aircraft_kit.py loads in three.js with both nodes, their pivots and both baked light attributes.
//   python .claude/skills/blender-landmark-model/scripts/run_blender.py models/aircraft/build_kit_fixture.py \
//       -- --out tests/fixtures/flight/kit-two-parts.glb
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const FILE = new URL('../../fixtures/flight/kit-two-parts.glb', import.meta.url);

async function load() {
  const buf = readFileSync(FILE);
  const array = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(array, '', resolve, reject));
}

const gltf = await load();
const root = gltf.scene.getObjectByName('KitFixture');
const base = gltf.scene.getObjectByName('Base');
const flap = gltf.scene.getObjectByName('Flap');

/** The mesh of a node: Blender writes a node with one mesh as a Mesh, or a Group of meshes for several materials. */
function meshesOf(node) {
  const out = [];
  node.traverse((o) => { if (o.isMesh && (o === node || o.parent === node)) out.push(o); });
  return out;
}

describe('kit-two-parts.glb', () => {
  it('has the root, the base and the flap as named nodes, the flap under the base', () => {
    expect(root).toBeTruthy();
    expect(base).toBeTruthy();
    expect(flap).toBeTruthy();
    expect(base.parent).toBe(root);
    expect(flap.parent).toBe(base);
  });

  it('puts each node on its pivot with no rest rotation', () => {
    // base pivot (model frame 0, 0, 0); flap pivot on its hinge, model frame (x 0, y -1.5, z 1.0): glTF (0, 1, 1.5)
    expect(base.position.toArray()).toEqual([0, 0, 0]);
    const p = flap.getWorldPosition(new THREE.Vector3());
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.y).toBeCloseTo(1.0, 5);
    expect(p.z).toBeCloseTo(1.5, 5);
    expect(flap.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
    expect(flap.userData.hingeAxis).toEqual([1, 0, 0]);
    expect(flap.userData.hingePoint.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0, 1, 1.5]);
  });

  it('builds the flap around its hinge: its geometry starts at the pivot and runs aft', () => {
    const box = new THREE.Box3();
    for (const m of meshesOf(flap)) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
    expect(box.min.z).toBeCloseTo(0, 3); // hinge line at the leading edge
    expect(box.max.z).toBeCloseTo(1.0, 3); // a 1 m chord aft (+Z is aft)
    expect(box.max.y - box.min.y).toBeLessThan(0.2);
  });

  it('turning the flap about its hinge keeps the hinge line fixed', () => {
    const before = flap.localToWorld(new THREE.Vector3(0.5, 0, 0));
    flap.quaternion.setFromAxisAngle(new THREE.Vector3(...flap.userData.hingeAxis), 0.5); // + about +X lowers +Z (aft)
    flap.updateMatrixWorld(true);
    const after = flap.localToWorld(new THREE.Vector3(0.5, 0, 0));
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
    const te = flap.localToWorld(new THREE.Vector3(0, 0, 1));
    expect(te.y).toBeLessThan(1.0); // trailing edge down
    flap.quaternion.identity();
    flap.updateMatrixWorld(true);
  });

  it('carries both four-component light attributes on every mesh, normalized 0..1, lit near the lamp', () => {
    let litFlap = 0, litBase = 0;
    for (const [node, isFlap] of [[base, false], [flap, true]]) {
      const meshes = meshesOf(node);
      expect(meshes.length).toBeGreaterThan(0);
      for (const m of meshes) {
        for (const name of ['_lights0', '_lights1']) {
          const a = m.geometry.getAttribute(name);
          expect(a, `${node.name} ${name}`).toBeTruthy();
          expect(a.itemSize).toBe(4);
          expect(a.count).toBe(m.geometry.getAttribute('position').count);
          for (let i = 0; i < a.count; i++) {
            for (let c = 0; c < 4; c++) {
              const v = a.getComponent(i, c);
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(1);
            }
          }
        }
        // channel 0 (NAV) lights the flap's upper surface; channel 5 (TURNOFF, _lights1.y) the base
        const l0 = m.geometry.getAttribute('_lights0'), l1 = m.geometry.getAttribute('_lights1');
        for (let i = 0; i < l0.count; i++) {
          if (isFlap && l0.getX(i) > 0.05) litFlap++;
          if (!isFlap && l1.getY(i) > 0.05) litBase++;
        }
        expect(m.geometry.getAttribute('_glow')).toBeUndefined();
      }
    }
    expect(litFlap).toBeGreaterThan(0);
    expect(litBase).toBeGreaterThan(0);
  });

  it('shades occluded corners dark: the base hides the lamp under it from the flap\'s underside', () => {
    // channel 2 (STROBE, _lights0.z): a lamp 0.5 m under the base's centre, aimed up
    let baseUnder = 0;
    for (const m of meshesOf(base)) {
      const l0 = m.geometry.getAttribute('_lights0'), nor = m.geometry.getAttribute('normal');
      for (let i = 0; i < l0.count; i++) if (nor.getY(i) < -0.9 && l0.getZ(i) > 0.05) baseUnder++;
    }
    expect(baseUnder).toBeGreaterThan(0);
    let flapUnder = 0;
    for (const m of meshesOf(flap)) {
      const l0 = m.geometry.getAttribute('_lights0'), nor = m.geometry.getAttribute('normal');
      for (let i = 0; i < l0.count; i++) {
        if (nor.getY(i) < -0.9) { flapUnder++; expect(l0.getZ(i)).toBe(0); }
      }
    }
    expect(flapUnder).toBeGreaterThan(0);
  });
});

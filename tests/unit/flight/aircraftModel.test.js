// The modelled airframe in the scene (plan 03, section 7.8; F3.4, F3.8): airframe.glb loaded with GLTFLoader, its
// named nodes posed from an AircraftState through rig.js, the wheels on the runway, the wing's own materials for the
// flex, and the baked light attributes decoded.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildAirframeModel, decodeBaked } from '../../../src/flight/aircraft/model.js';
import { lampIntensities, skinLux } from '../../../src/flight/aircraft/lightsDraw.js';
import { GROUPS, COLOURS } from '../../../src/flight/aircraft/lights.js';
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
// a second copy at rest, for reading the baked attributes in body axes
const fresh = buildAirframeModel((await parse()).scene, rig, { nodes, lampPoints: false });

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
  it('undoes the square-root encoding with the channel\'s scale (rig.json lightBake)', () => {
    expect(rig.lightBake.encoding).toBe('sqrt');
    expect(decodeBaked(0, 3)).toBe(0);
    expect(decodeBaked(1, 3)).toBe(3);
    expect(decodeBaked(0.5, 2)).toBeCloseTo(0.5, 12);
  });
});

describe('the skin\'s light from the baked attributes (the CPU twin of the emission node)', () => {
  const bake = rig.lightBake;
  fresh.root.updateMatrixWorld(true);
  const RAD_LUMA = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  /** Corners of a node in body axes with their normals and both attributes, filtered. */
  function corners(name, keep) {
    const out = [];
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    fresh.parts.get(name).traverse((o) => {
      if (!o.isMesh || (o !== fresh.parts.get(name) && o.parent !== fresh.parts.get(name))) return;
      const g = o.geometry, p = g.getAttribute('position'), nr = g.getAttribute('normal');
      const l0 = g.getAttribute('_lights0'), l1 = g.getAttribute('_lights1');
      const nm = new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        n.fromBufferAttribute(nr, i).applyMatrix3(nm).normalize();
        const c = { pos: v.toArray(), normal: n.toArray(), material: o.material.name,
          codes: [l0.getX(i), l0.getY(i), l0.getZ(i), l0.getW(i), l1.getX(i), l1.getY(i), l1.getZ(i), l1.getW(i)] };
        if (keep(c)) out.push(c);
      }
    });
    return out;
  }
  const levels = (bits, flash = 1) => GROUPS.map((g, i) => (bits & (1 << i) ? (g === 'BEACON' || g === 'STROBE' ? flash : 1) : 0));
  const sum = (cs, bits) => cs.reduce((acc, c) => skinLux(c.codes, c.pos, lampIntensities(levels(bits), bake), bake).map((x, k) => acc[k] + x), [0, 0, 0]);
  const chroma = (rgb) => rgb.map((x) => x / (rgb[0] + rgb[1] + rgb[2]));
  const nav = (side) => rig.lights[side === 1 ? 'nav_right' : 'nav_left'].position;
  const winglet = (side) => corners(side === 1 ? 'Wing_R' : 'Wing_L', (c) => side * c.pos[0] > 17.2 && c.pos[1] > 4 && side * c.normal[0] < -0.6
    && Math.hypot(...c.pos.map((x, k) => x - nav(side)[k])) < 1.8);

  it('glows the right winglet green and the left one red with the position lights alone', () => {
    const r = chroma(sum(winglet(1), 1)), l = chroma(sum(winglet(-1), 1));
    const green = chroma(COLOURS.green), red = chroma(COLOURS.red);
    for (let k = 0; k < 3; k++) { expect(r[k]).toBeCloseTo(green[k], 1); expect(l[k]).toBeCloseTo(red[k], 1); }
  });

  it('flashes the winglet white with the strobe at its peak, far brighter than the steady glow', () => {
    const cs = winglet(1);
    const steady = RAD_LUMA(sum(cs, 1)), flash = sum(cs, 1 | 4);
    expect(RAD_LUMA(flash)).toBeGreaterThan(20 * steady);
    const c = chroma(flash);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThan(0.1);
  });

  it('pulses the nacelle\'s inboard cowl red with the beacons, tens of lux at the pulse\'s peak', () => {
    const cs = corners('Engine_R', (c) => c.material.startsWith('Paint') && c.normal[0] < -0.5 && c.pos[0] < 4.83);
    expect(cs.length).toBeGreaterThan(10);
    const rgb = sum(cs, 2).map((x) => x / cs.length);
    expect(RAD_LUMA(rgb)).toBeGreaterThan(10);
    expect(chroma(rgb)[0]).toBeGreaterThan(0.95);
  });

  it('lights the outer wing with the white aft position light on the shared channel, and the taxi light nothing there', () => {
    const cs = corners('Wing_R', (c) => c.pos[0] > bake.mux.TAXI.outboardOf && c.codes[4] > 0);
    expect(cs.length).toBeGreaterThan(10);
    expect(RAD_LUMA(sum(cs, 1))).toBeGreaterThan(0);
    const taxiOnly = sum(cs, 16);
    expect(RAD_LUMA(taxiOnly)).toBe(0);
  });
});

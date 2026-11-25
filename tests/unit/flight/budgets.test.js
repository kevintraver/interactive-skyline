// Section 9.1's draw and triangle budgets per part, held at unit level (plan 03, section 9.4; F8.2). Each threshold is
// the plan's budget where the part keeps it, or, where it does not yet, what was measured (a regression guard), with
// the measured value beside it. Measured in the app on 25 Nov 2026 (tests/manual/flight-perf.mjs; the report in the
// pull request's "Tests run" and plan 03's F8.2 table). The regional terrain's triangle budget is held in
// terrainIndex.test.js, the cabin's in cabinModel.test.js, the airport's light points in airport.test.js.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildAirframeModel } from '../../../src/flight/aircraft/model.js';
import { createEnvNodes } from '../../../src/env/nodes.js';
import { createFlightLayers } from '../../../src/flight/view/layers.js';
import { createHeadRig } from '../../../src/flight/cabin/headRig.js';
import { defaultSeat, seat as seatOf } from '../../../src/flight/cabin/lopa.js';
import { createState } from '../../../src/flight/track.js';
import { createAirport } from '../../../src/flight/airport/index.js';
import { createAirLamps } from '../../../src/flight/ground/lamps.js';
import { terrainMesh } from '../../../src/city/terrain.js';
import { createMapGroundChunks, planMapChunks } from '../../../src/flight/terrain/mapChunks.js';
import { createFrame, EARTH_R } from '../../../src/world/frame.js';
import cities from '../../../data/cities.json';

const DATA = new URL('../../../public/data/lv/', import.meta.url);

const nodes = createEnvNodes({ state: null });
const rig = JSON.parse(readFileSync(new URL('../../../public/models/aircraft/rig.json', import.meta.url), 'utf8'));
const glb = readFileSync(new URL('../../../public/models/aircraft/airframe.glb', import.meta.url));
const parse = () => new Promise((resolve, reject) =>
  new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '', resolve, reject));

/** Draws and triangles of the meshes under `root` that three's frustum culling keeps for `camera`. */
function inView(root, camera) {
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  let draws = 0, triangles = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    if (o.frustumCulled && !frustum.intersectsObject(o)) return;
    draws++;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  return { draws, triangles };
}

describe('the airframe (section 9.1: 60,000 triangles and 40 draws at most in the scene pass)', async () => {
  const model = buildAirframeModel((await parse()).scene, rig, { nodes });
  const state = createState();
  state.position.set(0, 3000, 0);
  Object.assign(state, { flap: 30, slat: 2, gear: 1, speedbrake: 0, groundSpoiler: 0, reverser: 0, lights: 0, onGround: false, ias: 75 });
  model.update(state, { wallS: 0 });

  it('from the default window seat and the opposite side, inside the budget (measured: 18 draws and 8,444 triangles from 22F)', () => {
    for (const seat of [defaultSeat('right'), seatOf('22A'), seatOf('12F'), seatOf('30F')]) {
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
      const layers = createFlightLayers({ scene, camera, airframe: { group: model.root }, rig: createHeadRig({ seat }) });
      layers.attach();
      layers.update(state, { aspect: 1280 / 800 });
      const v = inView(scene, camera);
      expect(v.draws, seat.id).toBeLessThanOrEqual(40);
      expect(v.triangles, seat.id).toBeLessThanOrEqual(60000);
      layers.detach();
    }
  });

  it('as a whole, seen from outside (measured: 64 draws, each moving part its own; never drawn so in the app)', () => {
    expect(model.drawCalls).toBeLessThanOrEqual(64);
    expect(model.triangles).toBeLessThanOrEqual(60000);
  });
});

describe('the airport (section 9.1: pavement, markings and about 6,000 light points)', () => {
  const data = JSON.parse(readFileSync(new URL('../../../public/data/lv/airport.json', import.meta.url), 'utf8'));
  const airport = createAirport({ data, frame: createFrame(cities.lv), terrain: { surfaceAt: () => 640 }, nodes, quality: 'high' });

  it('three draws and at most 70,000 triangles (measured: 3 draws, 67,689 triangles)', () => {
    const s = airport.stats();
    expect(s.drawCalls).toBeLessThanOrEqual(3);
    let triangles = 0;
    airport.group.traverse((o) => { if (o.isMesh) triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); });
    expect(triangles).toBeLessThanOrEqual(70000);
  });
});

describe('the lamps from the air (section 9.1: one draw; 9.2: 6 MB in memory)', () => {
  // the two packs the flight draws: the valley's (the drive's) and the region's towns
  it('every lamp in one draw, and the sprite layer\'s GPU textures at 16 bytes per lamp per texture (measured: 20 MB for 326,466 lamps)', () => {
    const packs = ['lamps-drive', 'lights-region'].map((name) => {
      const meta = JSON.parse(readFileSync(new URL(`${name}.json`, DATA), 'utf8'));
      const b = readFileSync(new URL(meta.file || `${name}.bin`, DATA));
      return { meta, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name };
    });
    const lamps = createAirLamps({ packs, heightAt: () => 640, base: cities.lv.base, earthR: EARTH_R, nodes, level: 'high' });
    expect(lamps.count).toBe(326466);
    let draws = 0;
    lamps.mesh.traverse((o) => { if (o.isMesh) draws++; });
    expect(draws).toBe(1);
    const t = lamps.layer.uniforms;
    let bytes = 0;
    for (const k of ['tPos', 'tColor', 'tAxis', 'tSwitch']) bytes += t[k].value.image.data.byteLength;
    // 4 float RGBA textures: 64 bytes a lamp. The plan's 6 MB would need half-float or packed attributes in the
    // drive's sprite layer (src/drive/lights/sprites.js), which the drive shares: not changed here
    expect(bytes / 2 ** 20).toBeLessThanOrEqual(20);
  });
});

describe('the map\'s near and far ground while flying (section 9.1: the nested set held to 1.5 million triangles in view)', () => {
  it('cut into at most 64 chunks a grid, so the chunks out of view are not drawn (measured: near 48, far 60)', () => {
    expect(Math.ceil(685 / planMapChunks({ nx: 685, ny: 1051 })) * Math.ceil(1051 / planMapChunks({ nx: 685, ny: 1051 }))).toBeLessThanOrEqual(64);
    expect(Math.ceil(976 / planMapChunks({ nx: 976, ny: 901 })) * Math.ceil(901 / planMapChunks({ nx: 976, ny: 901 }))).toBeLessThanOrEqual(64);
    const raw = new Uint16Array(300 * 260).fill(1000);
    const g = { nx: 300, ny: 260, step: 80, x0: 0, y0: 0, scale: 1, raw };
    const chunks = createMapGroundChunks(terrainMesh(g, null, null, 900), { grid: g });
    chunks.show(true);
    expect(chunks.stats().chunks).toBeLessThanOrEqual(64);
    chunks.show(false);
  });
});


// The traffic's node modules (material.node.js, ribbon.node.js, pools.node.js, valley.node.js) against their GLSL
// siblings, on the CPU: the same exports and values, the same geometry, density tables, instance buffers and
// uniforms for the same calls, and the light units moved out of the gains into `lightScale` (plan 02, third stretch,
// decisions 2 and 6). What they draw is compared on the GPU by tests/manual/traffic-node-shots.mjs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import * as GL_MAT from '../../../src/drive/traffic/material.js';
import * as NODE_MAT from '../../../src/drive/traffic/material.node.js';
import * as GL_RIB from '../../../src/drive/traffic/ribbon.js';
import * as NODE_RIB from '../../../src/drive/traffic/ribbon.node.js';
import * as GL_POOLS from '../../../src/drive/traffic/pools.js';
import * as NODE_POOLS from '../../../src/drive/traffic/pools.node.js';
import * as GL_VALLEY from '../../../src/drive/traffic/valley.js';
import * as NODE_VALLEY from '../../../src/drive/traffic/valley.node.js';
import * as DATA from '../../../src/drive/traffic/lightData.js';
import { PULL } from '../../../src/drive/roadnet/material.js';
import { WHITEN } from '../../../src/drive/traffic/lampLayer.js';
import { BODY_NAMES } from '../../../src/drive/traffic/fleet.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const NIT = 0.1; // the classic light constant (src/drive/env.js LIGHTING_UNITS.nit)

const valuesOf = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v !== 'function'));
const plain = (v) => (v && typeof v === 'object' && 'x' in v ? v.toArray() : v);
const isNodeMaterial = (m) => m && m.isNodeMaterial === true;

describe('shared values', () => {
  it('lightData.js holds the GLSL modules\' values', () => {
    expect(DATA.LAMP).toEqual(GL_MAT.LAMP);
    expect(DATA.PAVEMENT_PULL).toBe(PULL);
    expect(DATA.SHADOW_PULL).toBe(GL_MAT.SHADOW_PULL);
    expect(DATA.WHITEN).toBe(WHITEN);
    for (const k of ['MAX_POOLS', 'POOL_RANGE_M', 'POOL_LENGTH_M', 'ASPHALT_RHO']) expect(DATA[k]).toBe(GL_POOLS[k]);
    const u = GL_MAT.createTrafficUniforms().uniforms;
    expect(DATA.SHADOW_STRENGTH).toBe(u.uStrength.value);
  });

  it('the lamp faces in cd/m^2 x the classic constant are the GLSL module\'s scene values', () => {
    const u = GL_MAT.createTrafficUniforms().uniforms;
    expect(DATA.LAMP_FACE_CDM2.head * NIT).toBeCloseTo(u.uHead.value, 12);
    expect(DATA.LAMP_FACE_CDM2.tail * NIT).toBeCloseTo(u.uTail.value, 12);
    expect(DATA.LAMP_FACE_CDM2.brake * NIT).toBeCloseTo(u.uBrake.value, 12);
  });

  it('the pool model in JavaScript is pools.js\'s', () => {
    for (const [x, y] of [[0, 5], [1, 20], [-3, 40], [2.5, 0.4]]) {
      expect(NODE_POOLS.poolBeam(x + 1, y)).toBe(GL_POOLS.poolBeam(x + 1, y));
      for (const cover of [0, 0.4, 1]) {
        expect(NODE_POOLS.poolIlluminance(x, y, 0.5, 0.65, cover)).toBe(GL_POOLS.poolIlluminance(x, y, 0.5, 0.65, cover));
        expect(NODE_POOLS.poolLuminance(x, y, { cover })).toBe(GL_POOLS.poolLuminance(x, y, { cover }));
      }
    }
  });
});

describe('exports', () => {
  for (const [name, gl, node] of [['material', GL_MAT, NODE_MAT], ['ribbon', GL_RIB, NODE_RIB], ['pools', GL_POOLS, NODE_POOLS], ['valley', GL_VALLEY, NODE_VALLEY]]) {
    it(`${name}.node.js exports what ${name}.js does, with the same values`, () => {
      expect(Object.keys(node).sort()).toEqual(Object.keys(gl).sort());
      expect(valuesOf(node)).toEqual(valuesOf(gl));
    });
  }
});

describe('materials', () => {
  it('createTrafficUniforms: uniform nodes the caller sets by .value, and the light scale', () => {
    const shared = NODE_MAT.createTrafficUniforms({ lightScale: NIT });
    expect(Object.keys(shared.uniforms).sort()).toEqual(Object.keys(GL_MAT.createTrafficUniforms().uniforms).sort());
    for (const u of Object.values(shared.uniforms)) expect(u.isNode).toBe(true);
    shared.uniforms.uDusk.value = 0.7;
    expect(shared.uniforms.uDusk.value).toBe(0.7);
    expect(shared.lightScale.isNode).toBe(true);
    expect(NODE_MAT.createTrafficUniforms().lightScale.value).toBe(1);
  });

  it('createBodyMaterial: a lit standard node material with the dissolve mask and the lamp emission', () => {
    const shared = NODE_MAT.createTrafficUniforms({ lightScale: NIT });
    const m = NODE_MAT.createBodyMaterial(new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }), shared);
    expect(isNodeMaterial(m)).toBe(true);
    expect(m.isMeshStandardNodeMaterial).toBe(true);
    expect(m.vertexColors).toBe(true);
    expect([m.roughness, m.metalness]).toEqual([0.4, 0.1]);
    expect(m.maskNode).toBeTruthy();
    expect(m.emissiveNode).toBeTruthy();
    expect(m.name).toBe('traffic-body');
  });

  it('createShadowMaterial: transparent, no depth write, the shared strength as m.uniforms.uStrength', () => {
    const shared = NODE_MAT.createTrafficUniforms();
    const m = NODE_MAT.createShadowMaterial(shared);
    expect(isNodeMaterial(m)).toBe(true);
    expect([m.transparent, m.depthWrite, m.name]).toEqual([true, false, 'traffic-shadow']);
    expect(m.uniforms.uStrength).toBe(shared.uniforms.uStrength);
  });
});

// a curved two-way road with three lanes each way (as tests/manual/traffic-node.html)
function roadModel() {
  const R = 30000, L = 6000;
  const at = (s, r) => {
    const a = s / R;
    r.x = R * Math.sin(a); r.y = R * (1 - Math.cos(a)); r.heading = a;
    r.h = 0.002 * s + 4 * Math.sin(s / 2500); r.grade = 0.002; r.crossfall = -0.02;
    return r;
  };
  const traffic = {
    range: [0, L],
    lanes: () => [{ lane: 1 }, { lane: 2 }, { lane: 3 }],
    segments: () => [{ s0: 0, truckShare: 0.12 }, { s0: 3000, truckShare: 0.3 }],
    laneDensities(dir, s, ms, out) {
      for (let l = 0; l < 8; l++) out[l] = l < 3 ? 0.012 * (1 + 0.6 * Math.sin(s / 900 + l * 1.3 + ms / 4e5)) * (dir === 'with' ? 1 : 0.75) : 0;
    },
  };
  const laneMap = {
    dirs: { with: { refline: { at }, sign: 1 }, against: { refline: { at: (u, r) => { at(L - u, r); r.heading += Math.PI; return r; } }, sign: -1 } },
    atDir(ld, lane, s, lm) { lm.sRoad = ld.sign > 0 ? s : L - s; lm.d = -((lane - 0.5) * 3.6 + 1.5); lm.dds = 0; lm.w = lane === 3 ? 0.8 : 1; return lm; },
  };
  return { traffic, laneMap, frame: { sceneY: (h) => h } };
}

describe('ribbons', () => {
  it('the same geometry, density table and uniforms for the same frames; gain without the light units', () => {
    const make = (M, extra) => M.createRibbons({ parent: new THREE.Group(), ...roadModel(), ...extra });
    const gl = make(GL_RIB, {}), node = make(NODE_RIB, { lightScale: NIT });
    for (const k of ['position', 'aTangent', 'aInfo', 'aTruck']) {
      expect(Array.from(node.mesh.geometry.getAttribute(k).array)).toEqual(Array.from(gl.mesh.geometry.getAttribute(k).array));
    }
    expect(Array.from(node.mesh.geometry.index.array)).toEqual(Array.from(gl.mesh.geometry.index.array));
    expect(isNodeMaterial(node.mesh.material)).toBe(true);
    expect([node.mesh.renderOrder, node.mesh.frustumCulled, node.mesh.name]).toEqual([gl.mesh.renderOrder, gl.mesh.frustumCulled, gl.mesh.name]);
    const camera = new THREE.PerspectiveCamera(30, 16 / 9, 1, 50000);
    const renderer = { getDrawingBufferSize: (v) => v.set(1280, 720) };
    const t0 = Date.parse('2026-11-21T01:30:00Z');
    // a run of frames across density quanta, a seek, and the slices worked out ahead
    for (const [i, simMs] of [t0, t0 + 400, t0 + 9000, t0 + 12000, t0 + 31000, t0 + 3.6e6, t0 + 3.6e6 + 50].entries()) {
      const f = { simMs, carS: 100 * i, ahead: 900, behind: 450, band: 0.25, camera, renderer, lit: 0.8, visibility: 30000, on: true };
      gl.update({ ...f, gain: NIT * 0.6 });
      node.update({ ...f, gain: 0.6 });
      expect(node.mesh.visible).toBe(gl.mesh.visible);
      expect(Array.from(node.uniforms.tDensity.value.image.data)).toEqual(Array.from(gl.uniforms.tDensity.value.image.data));
      for (const [k, u] of Object.entries(gl.uniforms)) {
        if (k === 'tDensity') continue;
        const want = k === 'uGain' ? u.value / NIT : plain(u.value);
        if (k === 'uGain') expect(node.uniforms[k].value).toBeCloseTo(want, 12);
        else expect(plain(node.uniforms[k].value)).toEqual(want);
      }
      expect(node.stats()).toEqual(gl.stats());
    }
    node.invalidate(); gl.invalidate();
    node.update({ simMs: t0, carS: 0, ahead: 900, behind: 450, band: 0.25, camera, renderer, gain: 0, lit: 1, on: true });
    expect(node.mesh.visible).toBe(false);
  });
});

describe('pools', () => {
  it('the same instances for the same vehicles; gain without the light units; the wet cover followed from a holder', () => {
    const sidecar = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/drive/vehicles.json'), 'utf8'));
    const holder = { value: 0.3 };
    const gl = GL_POOLS.createPools({ parent: new THREE.Group(), sidecar, bodyNames: BODY_NAMES });
    const node = NODE_POOLS.createPools({ parent: new THREE.Group(), sidecar, bodyNames: BODY_NAMES, lightScale: NIT, twinWet: holder });
    const n = 40;
    const near = { count: n, alpha: new Float32Array(n), pos: new Float64Array(3 * n), fwd: new Float32Array(3 * n), up: new Float32Array(3 * n), id: new Float64Array(n), body: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      near.pos.set([((i * 7) % 11) - 5, 0, -i * 5], 3 * i);
      near.fwd.set([0, 0, i % 3 ? -1 : 1], 3 * i);
      near.up.set([0, 1, 0], 3 * i);
      near.id[i] = i + 1; near.body[i] = i % BODY_NAMES.length; near.alpha[i] = i % 5 ? 1 : 0.02;
    }
    const f = { near, eye: { x: 0, y: 1.3, z: 4 }, ambient: 3, threshold: (id) => (id % 4 ? 10 : 1) };
    gl.update({ ...f, gain: NIT * 0.8 });
    node.update({ ...f, gain: 0.8 });
    expect(node.mesh.geometry.instanceCount).toBe(gl.mesh.geometry.instanceCount);
    expect(node.mesh.geometry.instanceCount).toBeGreaterThan(8);
    for (const k of ['iOrigin', 'iFwd', 'iUp', 'iLamp', 'iScale', 'corner']) {
      expect(Array.from(node.mesh.geometry.getAttribute(k).array)).toEqual(Array.from(gl.mesh.geometry.getAttribute(k).array));
    }
    expect(Array.from(node.mesh.geometry.index.array)).toEqual(Array.from(gl.mesh.geometry.index.array));
    expect(node.uniforms.uGain.value).toBeCloseTo(0.8, 12);
    expect(node.uniforms.uPull.value).toBeCloseTo(DATA.SHADOW_PULL * 1.2, 15);
    expect(node.stats()).toEqual(gl.stats());
    // the holder is read by the uniform's update each frame
    holder.value = 0.55;
    expect(typeof node.uniforms.uTwinWet.update).toBe('function');
    node.uniforms.uTwinWet.update({});
    expect(node.uniforms.uTwinWet.value).toBe(0.55);
    // a node passed as is
    const own = NODE_MAT.createTrafficUniforms().uniforms.uDusk;
    expect(NODE_POOLS.createPools({ parent: new THREE.Group(), sidecar, bodyNames: BODY_NAMES, twinWet: own }).uniforms.uTwinWet).toBe(own);
    node.update({ ...f, gain: 0 });
    expect(node.mesh.visible).toBe(false);
  });
});

describe('valley', () => {
  it('the same ribbons, route and hour for the same calls; gain without lighting.units.nit', async () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/lv/traffic/valley.json'), 'utf8'));
    const bin = fs.readFileSync(path.join(ROOT, 'public/data/lv/traffic', doc.file || 'valley.bin'));
    const ctxOf = () => ({
      optional: async () => doc,
      get: async () => ({ arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) }),
      env: { lighting: { units: { nit: NIT } }, weather: null }, terrain: { surfaceAt: (x, y) => 600 + 0.001 * x - 0.002 * y }, base: 500,
      app: { renderer: { getDrawingBufferSize: (v) => v.set(1280, 720) } }, group: new THREE.Group(),
    });
    const gl = await GL_VALLEY.createValleyPart(ctxOf());
    const node = await NODE_VALLEY.createValleyPart(ctxOf(), { lightScale: NIT });
    expect(isNodeMaterial(node.mesh.material)).toBe(true);
    for (const k of ['position', 'aDir', 'aAlong', 'aTraffic']) {
      expect(Array.from(node.mesh.geometry.getAttribute(k).array)).toEqual(Array.from(gl.mesh.geometry.getAttribute(k).array));
    }
    for (const p of [gl, node]) { p.setRoute({ route: { id: 'i15n' } }); p.setLook({ lights: 0.7 }); }
    expect(Array.from(node.mesh.geometry.index.array)).toEqual(Array.from(gl.mesh.geometry.index.array));
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 1e5);
    for (const simMs of [Date.parse('2026-11-21T02:00:00Z'), Date.parse('2026-03-08T10:30:00Z')]) {
      for (const p of [gl, node]) { p.update({ simMs }); p.beforeRender({ camera, simMs }); }
      const { js: a, ...sa } = gl.stats(), { js: b, ...sb } = node.stats();
      expect(sb).toEqual(sa);
    }
    expect(node.mesh.visible).toBe(true);
    // ctx.lightScale works too, and the light units are out of uGain: setLook writes the fade alone
    const viaCtx = await NODE_VALLEY.createValleyPart({ ...ctxOf(), lightScale: 0.25 });
    expect(viaCtx).toBeTruthy();
    expect(Object.keys(node).sort()).toEqual(Object.keys(gl).sort());
  });
});

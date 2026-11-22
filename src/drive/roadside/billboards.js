// The `billboards` drive part (plan 02, D7.4 and D7.5): the billboard structures beside the routes, from
// public/data/<city>/billboards.json (scripts/build_billboards.py). Joined in parts.js.
//
// Structures are instanced over the whole product (about 400 boards, five draw calls): a mono-pole, a steel frame
// behind every face, a catwalk under it, the floodlights of the static faces, and the faces. A board has one face, or
// two in a V whose apex is toward the road (panelsOf, the twin of scripts/lib/billboards.py panels()).
// Faces show original abstract artwork (screens/art.js): a static face one design, lit from below at night by its
// own lamps; a digital face a new design every HOLD_S seconds of simulation time with a quick fade (screens/digital.js),
// at a level that follows the ambient illuminance. The faces are screens in the registry (`screens` part), and the
// digital ones nearest the car light the road and ground in front of them (a surface term, screens/light.glsl.js).
//
// Per frame: two uniforms (the content time and the levels) and, for the glow, the nearest digital faces to the car.

import * as THREE from 'three';
import { addSurfaceTerm } from '../lights/surfaceLight.js';
import { createTimings } from '../timing.js';
import { buildAtlas, hash32 } from '../screens/art.js';
import { contentSeconds } from '../screens/clock.js';
import { digitalLevel, digitalMean, phaseOf, staticLevel } from '../screens/digital.js';
import { GLOW_BODY, GLOW_HEAD, GLOW_MAX } from '../screens/light.glsl.js';
import { faceMaterial } from './billboardsFace.js';

const RAD = Math.PI / 180;
/** Metres in front of a digital face that its glow reaches. */
const GLOW_RANGE = 70;
/** Digital faces farther than this from the car are not considered for the glow (m). */
const GLOW_PICK_M = 250;
const POLE_R = { bulletin: 0.45, poster: 0.25 };

/** A product row as an object (the field order is the product's `fields`). */
export function boardOf(row, fields) {
  const b = {};
  fields.forEach((k, i) => { b[k] = row[i]; });
  return b;
}

/**
 * The faces of a board as [{ x, y (map metres), normal: [nx, ny], along: [ux, uy] }], the same geometry as
 * scripts/lib/billboards.py panels(): one face centred on the pole, or two in a V whose apex is on the side the faces
 * look toward (the road), the pole at the middle of the two.
 */
export function panelsOf(b) {
  const n1 = [Math.cos(b.facing * RAD), Math.sin(b.facing * RAD)];
  if (b.sides === 1 || b.facing2 === null || b.facing2 === undefined) {
    return [{ x: b.x, y: b.y, normal: n1, along: [n1[1], -n1[0]] }];
  }
  const n2 = [Math.cos(b.facing2 * RAD), Math.sin(b.facing2 * RAD)];
  const sx = n1[0] + n2[0], sy = n1[1] + n2[1];
  const us = [n1, n2].map(([nx, ny]) => {
    let ux = -ny, uy = nx;
    if (ux * sx + uy * sy > 0) { ux = -ux; uy = -uy; }
    return [ux, uy];
  });
  const mx = ((us[0][0] + us[1][0]) / 2) * (b.w / 2), my = ((us[0][1] + us[1][1]) / 2) * (b.w / 2);
  return [n1, n2].map((normal, i) => ({ x: b.x - mx + us[i][0] * (b.w / 2), y: b.y - my + us[i][1] * (b.w / 2), normal, along: us[i] }));
}

/** The seed of face p of a board (24 bits: it travels to the shader as a float). */
export const faceSeed = (seed, p) => hash32((seed + p * 0x632be5ab) >>> 0) & 0xffffff;

/** @param {object} ctx the part context (parts.js) */
export async function createBillboardsPart(ctx) {
  const doc = await ctx.optional('billboards.json');
  if (!doc || !Array.isArray(doc.boards) || !doc.boards.length) return null;
  const { env, terrain } = ctx;
  const groundY = terrain.groundY;
  const boards = doc.boards.map((r) => boardOf(r, doc.fields));
  const atlas = buildAtlas();
  const timings = createTimings();

  // ---------------------------------------------------------------- the faces' layout
  const faces = []; // { board, x, y (map), gy, cx, cy, cz (scene centre), nx, nz (scene normal), w, h, seed, phase, digital }
  for (const b of boards) {
    const gy = groundY(b.x, b.y);
    panelsOf(b).forEach((p, i) => {
      const seed = faceSeed(b.seed >>> 0, i);
      faces.push({
        board: b, x: p.x, y: p.y, gy, cx: p.x, cy: gy + b.bottom + b.h / 2, cz: -p.y, nx: p.normal[0], nz: -p.normal[1],
        ax: p.along[0], az: -p.along[1], w: b.w, h: b.h, seed, phase: phaseOf(seed), digital: b.digital === 1,
      });
    });
  }

  // ---------------------------------------------------------------- materials
  const art = new THREE.DataTexture(atlas.data, atlas.width, atlas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  art.colorSpace = THREE.SRGBColorSpace;
  art.generateMipmaps = true;
  art.minFilter = THREE.LinearMipmapLinearFilter;
  art.magFilter = THREE.LinearFilter;
  art.anisotropy = ctx.app.renderer.capabilities.getMaxAnisotropy();
  art.needsUpdate = true;
  const uniforms = {
    uArt: { value: art }, uTime: { value: 0 }, uDigitalLevel: { value: 0.5 }, uStaticLevel: { value: 0 },
  };
  const faceMat = faceMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }), uniforms);
  const steel = new THREE.MeshLambertMaterial({ color: 0x6f7377 });
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x3c3f43 });
  const lampMat = new THREE.MeshLambertMaterial({ color: 0x2b2d30, emissive: 0xfff1d6, emissiveIntensity: 0 });

  // ---------------------------------------------------------------- geometry
  const poleGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const faceGeo = new THREE.PlaneGeometry(1, 1);
  const statics = faces.filter((f) => !f.digital);
  const lampsPer = (f) => (f.w >= 11 ? 4 : 2);
  const nLamps = statics.reduce((n, f) => n + lampsPer(f), 0);
  const poles = new THREE.InstancedMesh(poleGeo, steel, boards.length);
  const frames = new THREE.InstancedMesh(boxGeo, frameMat, faces.length);
  const walks = new THREE.InstancedMesh(boxGeo, steel, faces.length);
  const lamps = new THREE.InstancedMesh(boxGeo, lampMat, Math.max(1, nLamps));
  const faceMesh = new THREE.InstancedMesh(faceGeo, faceMat, faces.length);
  const aFace = new Float32Array(faces.length * 4);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const basis = new THREE.Matrix4(), xAxis = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0), zAxis = new THREE.Vector3();

  boards.forEach((b, i) => {
    const kind = b.w >= 11 ? 'bulletin' : 'poster', r = POLE_R[kind];
    // a single face's pole stands just behind it; a V's at the middle, behind both faces
    const back = b.sides === 1 ? r + 0.45 : 0, a = b.facing * RAD;
    const px = b.x - Math.cos(a) * back, py = b.y - Math.sin(a) * back;
    m.compose(p.set(px, groundY(b.x, b.y), -py), q.identity(), s.set(r, b.bottom + b.h * 0.55, r));
    poles.setMatrixAt(i, m);
  });
  let li = 0;
  faces.forEach((f, i) => {
    // the face's frame: x along the panel (so that +z, the plane's normal, is the face's normal), y up
    zAxis.set(f.nx, 0, f.nz);
    xAxis.crossVectors(yAxis, zAxis).normalize();
    basis.makeBasis(xAxis, yAxis, zAxis);
    q.setFromRotationMatrix(basis);
    const at = (dz, dy) => p.set(f.cx + f.nx * dz, f.cy + dy, f.cz + f.nz * dz);
    faceMesh.setMatrixAt(i, m.compose(at(0.02, 0), q, s.set(f.w, f.h, 1)));
    frames.setMatrixAt(i, m.compose(at(-0.3, 0), q, s.set(f.w + 0.3, f.h + 0.3, 0.55)));
    walks.setMatrixAt(i, m.compose(at(0.55, -f.h / 2 - 0.25), q, s.set(f.w, 0.08, 1.0)));
    aFace.set([f.seed, f.digital ? 1 : 0, f.phase, 0], i * 4);
    if (!f.digital) {
      const k = lampsPer(f);
      for (let j = 0; j < k; j++) {
        const t = ((j + 0.5) / k - 0.5) * f.w;
        p.set(f.cx + f.nx * 1.3 + f.ax * t, f.cy - f.h / 2 - 0.15, f.cz + f.nz * 1.3 + f.az * t);
        lamps.setMatrixAt(li++, m.compose(p, q, s.set(0.45, 0.22, 0.35)));
      }
    }
  });
  faceGeo.setAttribute('aFace', new THREE.InstancedBufferAttribute(aFace, 4));
  const group = new THREE.Group();
  group.name = 'billboards';
  for (const mesh of [poles, frames, walks, lamps, faceMesh]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  lamps.count = nLamps;
  (ctx.roads || ctx.group).add(group);

  // ---------------------------------------------------------------- levels, the registry, the glow
  let ambient = 1e4, lights = 0, dLevel = digitalLevel(ambient, env.lighting.units), sLevel = 0;
  const screens = faces.map((f, i) => ({
    id: `billboard:${i}`, kind: 'billboard', name: f.digital ? 'digital billboard' : 'billboard', area: f.w * f.h, digital: f.digital,
    centre: () => [f.cx, f.cy, f.cz], visible: () => group.visible,
    meanColor(simMs, out = [0, 0, 0]) {
      if (f.digital) digitalMean(atlas.means, f.seed, f.phase, contentSeconds(simMs), out);
      else for (let c = 0; c < 3; c++) out[c] = atlas.means[(f.seed % (atlas.means.length / 3)) * 3 + c];
      const k = f.digital ? dLevel : sLevel;
      out[0] *= k; out[1] *= k; out[2] *= k;
      return out;
    },
  }));

  const glow = {
    uScrGlowP: { value: Array.from({ length: GLOW_MAX }, () => new THREE.Vector4()) },
    uScrGlowN: { value: Array.from({ length: GLOW_MAX }, () => new THREE.Vector4(0, 0, 1, GLOW_RANGE)) },
    uScrGlowL: { value: Array.from({ length: GLOW_MAX }, () => new THREE.Vector3()) },
  };
  const glowTerm = { id: 'screenGlow', key: 'v1', uniforms: glow, head: GLOW_HEAD, body: GLOW_BODY };
  const detach = [];
  const attach = (mat) => { if (mat) detach.push(addSurfaceTerm(mat, glowTerm)); };
  attach(ctx.materials?.road);
  attach(ctx.materials?.roadNear);
  attach(ctx.wideMesh?.material);
  for (const [mesh] of ctx.ground || []) attach(mesh.material);
  const digitals = faces.filter((f) => f.digital);
  const near = [];
  const mean = [0, 0, 0];
  let glowCount = 0;

  function pickGlow(carX, carY, simMs) {
    near.length = 0;
    for (const f of digitals) {
      const d2 = (f.x - carX) ** 2 + (f.y - carY) ** 2;
      if (d2 < GLOW_PICK_M * GLOW_PICK_M) near.push([d2, f]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const t = contentSeconds(simMs);
    glowCount = Math.min(GLOW_MAX, near.length);
    for (let i = 0; i < GLOW_MAX; i++) {
      const L = glow.uScrGlowL.value[i];
      if (i >= glowCount || !group.visible) { L.set(0, 0, 0); continue; }
      const f = near[i][1];
      digitalMean(atlas.means, f.seed, f.phase, t, mean);
      L.set(mean[0] * dLevel, mean[1] * dLevel, mean[2] * dLevel);
      glow.uScrGlowP.value[i].set(f.cx, f.cy, f.cz, f.w * f.h);
      glow.uScrGlowN.value[i].set(f.nx, 0, f.nz, GLOW_RANGE);
    }
  }

  let enabled = true, pendingMs = 0;
  const part = {
    name: 'billboards',
    screens,
    faces,
    count: boards.length,
    setEnabled(v) { enabled = !!v; group.visible = enabled; },
    update(frame) {
      if (!enabled) return;
      const t0 = performance.now();
      ambient = env.lighting.ambientLux(frame.sun.elevation);
      dLevel = digitalLevel(ambient, env.lighting.units);
      sLevel = staticLevel(lights, env.lighting.units);
      uniforms.uTime.value = contentSeconds(frame.simMs);
      uniforms.uDigitalLevel.value = dLevel;
      uniforms.uStaticLevel.value = sLevel;
      lampMat.emissiveIntensity = 1.5 * lights;
      pickGlow(frame.pose.position.x, -frame.pose.position.z, frame.simMs);
      pendingMs += performance.now() - t0;
    },
    setLook(look) {
      lights = look.lights ?? (look.night ? 1 : 0);
      sLevel = staticLevel(lights, env.lighting.units);
      uniforms.uStaticLevel.value = sLevel;
      lampMat.emissiveIntensity = 1.5 * lights;
    },
    beforeRender() { timings.add(pendingMs); pendingMs = 0; },
    stats() {
      const t = timings.summary();
      return {
        boards: boards.length, faces: faces.length, digital: digitals.length, lamps: nLamps, glow: glowCount,
        level: { digital: +dLevel.toFixed(3), static: +sLevel.toFixed(3), ambientLux: +ambient.toFixed(3) },
        js: { mean: t.mean, p95: t.p95, max: t.max },
      };
    },
    dispose() {
      for (const d of detach) d();
      group.removeFromParent();
      for (const g of [poleGeo, boxGeo, faceGeo]) g.dispose();
      for (const mt of [faceMat, steel, frameMat, lampMat]) mt.dispose();
      art.dispose();
    },
  };
  group.userData.billboardsPart = part; // for tests/manual/screens-shots.mjs
  return part;
}

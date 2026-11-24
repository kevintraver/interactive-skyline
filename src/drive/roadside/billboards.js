// The `billboards` drive part (plan 02, D7.4 and D7.5): the billboard structures beside the routes, from
// public/data/<city>/billboards.json (scripts/build_billboards.py). Joined in parts.js.
//
// Structures are instanced over the whole product (about 400 boards, five draw calls): a mono-pole, a steel frame
// behind every face, a catwalk under it, the floodlights of the static faces, and the faces. A board has one face, or
// two in a V whose apex is toward the road (panelsOf, the twin of scripts/lib/billboards.py panels()).
// Faces show fictional 1990s advertisements (public/textures/billboards/, packed by scripts/pack_billboards.py;
// the choice, fit and rotation are billboardsImages.js): a static face one image, lit from below at night by its own
// lamps; a digital face a new image every HOLD_S seconds of simulation time with a quick fade (screens/digital.js), at
// a level that follows the ambient illuminance. The atlas loads after the part is in (the faces are plain until
// then); if it fails, the faces show the generated abstract artwork of screens/art.js instead, never nothing. The faces are screens in the registry (`screens` part), and the
// digital ones nearest the car light the road and ground in front of them (a surface term, screens/light.glsl.js).
//
// Per frame: two uniforms (the content time and the levels) and, for the glow, the nearest digital faces to the car.
//
// Renderers (plan 02, third stretch, decisions 2, 6 and 8). The faces' and lamps' materials come from billboardsFace.js
// on the classic renderer and billboardsFace.node.js on plan 01's, the glow's term from screens/light.glsl.js or
// light.node.js, picked by ctx.legacy; the layout, the images and the schedule are the same. On plan 01's renderer the
// levels are luminances in cd/m^2 (screens/digital.js faceLevels: a digital face's white 300 cd/m^2 at night and 6,000
// by day; a static face vinyl under 400 lx of floodlight), as are the registry's mean colours and the glow's, and the
// detail follows app.quality's level (DETAIL below): the atlas tier, the floodlights per face and the faces that glow.
// On the classic renderer the atlas tier follows the cabin model's device probe, as before.

import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { createTimings } from '../timing.js';
import { eachGround } from '../parts.js';
import { buildAtlas, hash32 } from '../screens/art.js';
import { contentSeconds } from '../screens/clock.js';
import { digitalMean, faceLevels, phaseOf, PLAIN } from '../screens/digital.js';
import * as lightGlsl from '../screens/light.glsl.js';
import * as lightNode from '../screens/light.node.js';
import * as faceGlsl from './billboardsFace.js';
import * as faceNode from './billboardsFace.node.js';
import { adMean, assignImages, loadAds, shaderTables, textureBytes } from './billboardsImages.js';

const RAD = Math.PI / 180;
/** Metres in front of a digital face that its glow reaches. */
const GLOW_RANGE = 70;
/** Digital faces farther than this from the car are not considered for the glow (m). */
const GLOW_PICK_M = 250;
const POLE_R = { bulletin: 0.45, poster: 0.25 };
/**
 * Detail by plan 01's quality level (decision 8), on its renderer: the atlas tier, the floodlights of a static face
 * (bulletins, 11 m and wider, and posters), and how many digital faces nearest the car light the ground. The classic
 * renderer keeps the high row, with the tier chosen by the cabin model's device probe.
 */
export const DETAIL = Object.freeze({
  low: Object.freeze({ tier: 'low', lampsBulletin: 2, lampsPoster: 2, glow: 2 }),
  high: Object.freeze({ tier: 'high', lampsBulletin: 4, lampsPoster: 2, glow: 6 }),
  ultra: Object.freeze({ tier: 'high', lampsBulletin: 4, lampsPoster: 2, glow: 6 }),
});

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

/** Metres around a board's centre over which its base finds the lowest ground. */
const POLE_FOOT = 0.6;

/** @param {object} ctx the part context (parts.js) */
export async function createBillboardsPart(ctx) {
  const doc = await ctx.optional('billboards.json');
  if (!doc || !Array.isArray(doc.boards) || !doc.boards.length) return null;
  const { env, terrain } = ctx;
  const legacy = ctx.legacy !== false;
  const level = legacy ? 'high' : (DETAIL[env?.quality?.preset] ? env.quality.preset : 'high');
  const detail = DETAIL[level];
  const photometry = legacy ? undefined : { nodes: env?.nodes };
  // a board stands on the ground as drawn (terrain.surfaceY), at the lowest point around its pole, so on a slope
  // the pole never hangs on its downhill side
  const groundY = (x, y) => {
    let lo = terrain.surfaceY(x, y);
    for (let k = 0; k < 8; k++) lo = Math.min(lo, terrain.surfaceY(x + POLE_FOOT * Math.cos(k * Math.PI / 4), y + POLE_FOOT * Math.sin(k * Math.PI / 4)));
    return lo;
  };
  const boards = doc.boards.map((r) => boardOf(r, doc.fields));
  let atlas = null; // the generated artwork, built only if the advertisements fail to load
  const timings = createTimings();

  // ---------------------------------------------------------------- the faces' layout
  const faces = []; // { board, x, y (map), gy, cx, cy, cz (scene centre), nx, nz (scene normal), w, h, seed, phase, digital }
  for (const b of boards) {
    const gy = groundY(b.x, b.y);
    panelsOf(b).forEach((p, i) => {
      const seed = faceSeed(b.seed >>> 0, i);
      faces.push({
        index: faces.length, panel: i, board: b, x: p.x, y: p.y, gy, cx: p.x, cy: gy + b.bottom + b.h / 2, cz: -p.y, nx: p.normal[0], nz: -p.normal[1],
        ax: p.along[0], az: -p.along[1], w: b.w, h: b.h, aspect: b.w / b.h, seed, phase: phaseOf(seed), digital: b.digital === 1,
      });
    });
  }

  // ---------------------------------------------------------------- materials
  const renderer = ctx.app.renderer;
  const anisotropy = Math.min(16, renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : renderer.capabilities.getMaxAnisotropy());
  const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blank.needsUpdate = true;
  const blankTable = new THREE.DataTexture(new Float32Array(8), 1, 2, THREE.RGBAFormat, THREE.FloatType);
  blankTable.needsUpdate = true;
  let uniforms, faceMat, steel, frameMat, lampMat, lampLevel;
  if (legacy) {
    uniforms = {
      uArt: { value: blank }, uAds: { value: blank }, uAdTable: { value: blankTable }, uAdTexel: { value: new THREE.Vector2(1, 1) },
      uMode: { value: 0 }, uTime: { value: 0 }, uDigitalLevel: { value: 0.5 }, uStaticLevel: { value: 0 },
    };
    faceMat = faceGlsl.faceMaterial(new THREE.MeshLambertMaterial({ color: 0xffffff }), uniforms);
    steel = new THREE.MeshLambertMaterial({ color: 0x6f7377 });
    frameMat = new THREE.MeshLambertMaterial({ color: 0x3c3f43 });
    lampMat = new THREE.MeshLambertMaterial({ color: 0x2b2d30, emissive: 0xfff1d6, emissiveIntensity: 0 });
    lampLevel = (v) => { lampMat.emissiveIntensity = v; };
  } else {
    ({ material: faceMat, uniforms } = faceNode.faceMaterial({ blank, blankTable, photometry }));
    steel = new MeshLambertNodeMaterial({ color: 0x6f7377 });
    frameMat = new MeshLambertNodeMaterial({ color: 0x3c3f43 });
    const lamp = faceNode.lampMaterial({ color: 0xfff1d6, photometry });
    lampMat = lamp.material;
    lampLevel = (v) => { lamp.uniforms.uLevel.value = v; };
  }
  // the levels' units: scene units on the classic renderer, cd/m^2 on plan 01's (faceLevels)
  const display = legacy ? 'legacy' : faceNode.displayOf(photometry);
  const levelsFor = (ambientLux, lampsOn) => faceLevels({ display, ambientLux, lampsOn, units: env.lighting.units });
  let art = null, ads = null, table = null, mode = 'plain', adMeans = null, assigned = null;
  const loadInfo = { state: 'loading' };

  // ---------------------------------------------------------------- geometry
  const poleGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const faceGeo = new THREE.PlaneGeometry(1, 1);
  const statics = faces.filter((f) => !f.digital);
  const lampsPer = (f) => (f.w >= 11 ? detail.lampsBulletin : detail.lampsPoster);
  const nLamps = statics.reduce((n, f) => n + lampsPer(f), 0);
  const poles = new THREE.InstancedMesh(poleGeo, steel, boards.length);
  const frames = new THREE.InstancedMesh(boxGeo, frameMat, faces.length);
  const walks = new THREE.InstancedMesh(boxGeo, steel, faces.length);
  const lamps = new THREE.InstancedMesh(boxGeo, lampMat, Math.max(1, nLamps));
  const faceMesh = new THREE.InstancedMesh(faceGeo, faceMat, faces.length);
  const aFace = new Float32Array(faces.length * 4);
  const aAd = new Float32Array(faces.length * 4).fill(1), aFit = new Float32Array(faces.length * 2).fill(1);
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
    if (f.board.sides === 2 && faces[i + (f.panel ? -1 : 1)]?.board === f.board) {
      // a face of a V: a shallow frame that stops short of the apex (the face's start, against `along`), so it never
      // stands in front of the other face, whose plane meets this one there at the V's opening angle
      const o = faces[i + (f.panel ? -1 : 1)], cosOpen = -(f.nx * o.nx + f.nz * o.nz);
      const open = Math.acos(Math.max(-1, Math.min(1, cosOpen))), depth = 0.2;
      const inset = open < Math.PI / 2 ? Math.min(1, (depth + 0.03) / Math.tan(Math.max(open, 0.05))) : 0;
      const w = f.w + 0.15 - inset, shift = (0.15 + inset) / 2;
      m.compose(at(-0.02 - depth / 2, 0).addScaledVector(xAxis.set(f.ax, 0, f.az), shift), q, s.set(w, f.h + 0.3, depth));
      frames.setMatrixAt(i, m);
    } else frames.setMatrixAt(i, m.compose(at(-0.3, 0), q, s.set(f.w + 0.3, f.h + 0.3, 0.55)));
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
  const aAdAttr = new THREE.InstancedBufferAttribute(aAd, 4), aFitAttr = new THREE.InstancedBufferAttribute(aFit, 2);
  faceGeo.setAttribute('aAd', aAdAttr);
  faceGeo.setAttribute('aFit', aFitAttr);
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
  let ambient = 1e4, lights = 0, dLevel = levelsFor(ambient, 0).digital, sLevel = 0;
  const screens = faces.map((f, i) => ({
    id: `billboard:${i}`, kind: 'billboard', name: f.digital ? 'digital billboard' : 'billboard', area: f.w * f.h, digital: f.digital,
    centre: () => [f.cx, f.cy, f.cz], visible: () => group.visible,
    meanColor(simMs, out = [0, 0, 0]) {
      faceMean(i, contentSeconds(simMs), out);
      const k = f.digital ? dLevel : sLevel;
      out[0] *= k; out[1] *= k; out[2] *= k;
      return out;
    },
  }));

  /** The mean colour (linear, level 1) face i shows at content time t: its image's, the artwork's, or the blank face's. */
  function faceMean(i, t, out) {
    const f = faces[i];
    if (mode === 'ads') return adMean(adMeans, assigned[i], f.phase, t, out);
    if (mode === 'art') {
      if (f.digital) return digitalMean(atlas.means, f.seed, f.phase, t, out);
      for (let c = 0; c < 3; c++) out[c] = atlas.means[(f.seed % (atlas.means.length / 3)) * 3 + c];
      return out;
    }
    out[0] = PLAIN[0]; out[1] = PLAIN[1]; out[2] = PLAIN[2];
    return out;
  }

  // ---------------------------------------------------------------- the advertisements, after the part is in
  const texture = (img, w, h) => {
    const t = img ? new THREE.Texture(img) : new THREE.DataTexture(atlas.data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // an ImageBitmap comes flipped already; the artwork's rows start at the bottom
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    return t;
  };
  function useArt(why) {
    if (disposed) return;
    loadInfo.state = 'art';
    loadInfo.error = String(why?.message || why);
    console.warn(`billboards: the advertisements did not load (${loadInfo.error}); showing the generated artwork`);
    atlas = buildAtlas();
    art = texture(null, atlas.width, atlas.height);
    uniforms.uArt.value = art;
    mode = 'art';
    uniforms.uMode.value = 1;
    ctx.app.invalidate?.();
  }
  let disposed = false;
  const loading = (async () => {
    let tier = detail.tier;
    if (legacy) {
      const { chooseCabinModel, probeDevice } = await import('../vehicle/cabin.js');
      tier = chooseCabinModel(probeDevice(renderer)) === 'low' ? 'low' : 'high';
    }
    const got = await loadAds(tier);
    if (disposed) { got.bitmap.close?.(); return; }
    const { doc, bitmap } = got;
    const t0 = performance.now();
    const boardIndex = new Map(boards.map((b, i) => [b, i]));
    assigned = assignImages(faces.map((f) => ({ board: boardIndex.get(f.board), x: f.x, y: f.y, seed: f.seed, aspect: f.aspect, digital: f.digital })), doc.images);
    assigned.forEach((a, i) => { aAd.set([a.base, a.n, a.start, a.step], i * 4); aFit.set(a.fit, i * 2); });
    aAdAttr.needsUpdate = true;
    aFitAttr.needsUpdate = true;
    const tables = shaderTables(doc, tier), n = doc.images.length, td = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) { td.set(tables.rects.subarray(i * 4, i * 4 + 4), i * 4); td.set(tables.means.subarray(i * 3, i * 3 + 3), (n + i) * 4); }
    table = new THREE.DataTexture(td, n, 2, THREE.RGBAFormat, THREE.FloatType);
    table.needsUpdate = true;
    const t1 = performance.now();
    await new Promise((r) => setTimeout(r, 0)); // the upload in a task of its own, between frames
    if (disposed) { bitmap.close?.(); return; }
    const t2 = performance.now();
    ads = texture(bitmap);
    renderer.initTexture(ads); // the upload and the mipmaps now, not in the middle of a frame
    renderer.initTexture(table);
    const t3 = performance.now();
    adMeans = tables.means;
    uniforms.uAds.value = ads;
    uniforms.uAdTable.value = table;
    uniforms.uAdTexel.value.set(1 / bitmap.width, 1 / bitmap.height);
    mode = 'ads';
    uniforms.uMode.value = 2;
    Object.assign(loadInfo, {
      state: 'ads', tier, level, images: n, size: [bitmap.width, bitmap.height], bytes: got.bytes, gpuBytes: textureBytes(bitmap.width, bitmap.height),
      fetchMs: +got.fetchMs.toFixed(1), decodeMs: +got.decodeMs.toFixed(1), assignMs: +(t1 - t0).toFixed(1), uploadMs: +(t3 - t2).toFixed(1),
    });
    ctx.app.invalidate?.();
  })().catch(useArt);

  const glowLight = legacy ? lightGlsl.createGlowLight({ range: GLOW_RANGE }) : lightNode.createGlowLight({ range: GLOW_RANGE, count: detail.glow, photometry });
  const glow = glowLight.uniforms, GLOW_MAX = glowLight.count;
  const detach = [];
  const attach = (mat) => { if (mat && (legacy || mat.isNodeMaterial)) detach.push(glowLight.attach(mat)); };
  attach(ctx.materials?.road);
  attach(ctx.materials?.roadNear);
  attach(ctx.wideMesh?.material);
  const offGround = eachGround(ctx, (mesh) => attach(mesh.material)); // the terrain patches too, when they come
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
      if (i >= glowCount || !group.visible) { L.set(0, 0, 0); continue; } // (dLevel: scene units, or cd/m^2 on plan 01's renderer)
      const f = near[i][1];
      faceMean(f.index, t, mean);
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
    /** The faces' shader inputs (test hook: tests/manual/screens-luminance.mjs zeroes a level to measure a face's emission). */
    uniforms,
    /** Face i's advertisement schedule (billboardsImages.js assignImages; null before the images are in). Test hook. */
    assignment: (i) => assigned?.[i] ?? null,
    setEnabled(v) { enabled = !!v; group.visible = enabled; },
    update(frame) {
      if (!enabled) return;
      const t0 = performance.now();
      ambient = env.lighting.ambientLux(frame.sun.elevation);
      const lv = levelsFor(ambient, lights);
      dLevel = lv.digital;
      sLevel = lv.static;
      uniforms.uTime.value = contentSeconds(frame.simMs);
      uniforms.uDigitalLevel.value = dLevel;
      uniforms.uStaticLevel.value = sLevel;
      lampLevel(lv.lamp);
      pickGlow(frame.pose.position.x, -frame.pose.position.z, frame.simMs);
      pendingMs += performance.now() - t0;
    },
    setLook(look) {
      lights = look.lights ?? (look.night ? 1 : 0);
      const lv = levelsFor(ambient, lights);
      sLevel = lv.static;
      uniforms.uStaticLevel.value = sLevel;
      lampLevel(lv.lamp);
    },
    beforeRender() { timings.add(pendingMs); pendingMs = 0; },
    stats() {
      const t = timings.summary();
      return {
        boards: boards.length, faces: faces.length, digital: digitals.length, lamps: nLamps, glow: glowCount, glowMax: GLOW_MAX,
        detail: { level, ...detail }, units: display === 'physical' ? 'cd/m2' : display === 'classic' ? 'cd/m2 (classic display)' : 'scene',
        images: { ...loadInfo },
        level: { digital: +dLevel.toFixed(3), static: +sLevel.toFixed(3), ambientLux: +ambient.toFixed(3) },
        js: { mean: t.mean, p95: t.p95, max: t.max },
      };
    },
    /** Resolves once the faces show the advertisements or, failing those, the artwork. */
    whenSettled: () => loading,
    dispose() {
      disposed = true;
      offGround();
      for (const d of detach) d();
      group.removeFromParent();
      for (const g of [poleGeo, boxGeo, faceGeo]) g.dispose();
      for (const mt of [faceMat, steel, frameMat, lampMat]) mt.dispose();
      for (const t of [blank, blankTable, art, ads, table]) t?.dispose();
    },
  };
  group.userData.billboardsPart = part; // for tests/manual/screens-shots.mjs
  return part;
}

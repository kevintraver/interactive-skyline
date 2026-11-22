// The mirrors (plan 02, D4.3; section 7.6): each of the three mirror faces of the cabin shows the world from a
// camera placed by reflecting the driver's eye in the mirror's plane, rendered into a render target of its own.
//
// Construction (mirrorView, pure). The eye is the head's position in cabin coordinates (rig.last.head), so the
// reflection follows the head: its lag, its look and the glances.
//   Flat mirrors (the driver's door mirror, the interior mirror): the camera sits at the eye's reflection E' and
//   looks through the mirror's rectangle as through a window, an off-axis frustum whose near plane is the mirror
//   plane: x = -right, y = up, z = -normal (the normal points to the driver). This is exact for a flat mirror:
//   the ray from E' through a point of the glass is the eye's ray reflected there. The camera's x runs against
//   the face's u, hence the flip in the face's shader. The interior mirror is widened to cabin.json's minFovDeg
//   (FMVSS 111's 20 degrees) when the eye sees less through it (it sees about 19).
//   The convex passenger mirror (radius 1.4 m, FMVSS 111 allows 889-1651 mm): a spherical mirror turns the ray at
//   an offset a from its centre by 2a/R more than a flat one does, so the angles of the field grow by
//   k = 1 + 2D/R (D the eye's distance to the mirror; about 3.3 here). The camera sits at E', looks along the
//   central ray reflected, with a symmetric frustum of k times the flat mirror's half-angles, and the face
//   samples it through a barrel mapping (tan(sA)/tan(A)), so angles, not tangents, run linearly across it.
// Each camera is then carried into the scene by the body's matrix (rig.last.body).
//
// The passes (createMirrors). A mirror pass draws the world scene only: not the cabin, not the windshield layer
// (both live in the cabin's own scene). The passes run before the world's own draw (session.js render, cabin.js
// beforeWorld), so the canvas's world and cabin are drawn without a pass between them; the first pass redraws the
// shadow map when it is due (only buildings cast shadows, so it is the map the world's draw would have made).
// Two things the world's parts cull against the main camera are put right for each pass: the traffic bodies
// (traffic.renderer.draw is run again for the mirror's camera, and once more for the main camera afterwards,
// so the traffic part's lamp points and stats stay the main view's), and the light sprites and ribbons, which
// size themselves in pixels from uViewport and uPixelAngle (set back afterwards). The glass's reflectance is applied
// before the tone mapping, as the eye would see a dimmer image: the renderer's exposure times the reflectance for
// the world, the sprites' gain times it for the light sprites (they tone-map themselves, and a dimmer lamp is a
// smaller disc: a follower's head lamps do not blind in the mirror). The interior mirror then gets
// the car's own interior drawn over the world with the depth cleared (the rear window's frame, the headliner,
// the rear headrests: simple boxes in cabin coordinates on layer 1 of the cabin scene); the door mirrors get the
// car's flank in their shader.
// What the passes do not fix: the street lamps' sprites are culled per cell against the main view
// (lights/index.js), so lamp heads well behind the car are missing from the mirrors; the lamps' pools are not.
//
// Refresh. glassPresets.js sets each mirror's target and rate; while the clock is paused every mirror is drawn
// on every drawn frame, so a settled frame's mirrors are current whatever the frame count.

import * as THREE from 'three';
import { mirrorVertex, mirrorFragment } from './mirrors.glsl.js';
import { mirrorsDue, MIRROR_NAMES } from './glassPresets.js';
import { createTimings } from '../timing.js';

export const MIRROR_FAR = 150000; // the main camera's far plane (rig.js FAR): the sky dome is 120 km out
/** The share of the traffic part's body range kept behind the car when it looks ahead (traffic/index.js BEHIND_SHARE). */
const TRAFFIC_BEHIND_SHARE = 0.35;
/** Reflectance (assumed): door mirrors about half (FMVSS 111 asks at least 35%; chromium-coated glass is about 50%);
 * the interior mirror's silvered glass 0.8 by day, dimmed toward 0.3 at night as an auto-dimming mirror does. */
export const REFLECTANCE = Object.freeze({ door: 0.5, centerDay: 0.8, centerNight: 0.3 });
/** The door mirrors' flank: share of the face at the bottom and top, and the beltline's height (assumed, by eye). */
const FLANK = Object.freeze({ bottom: 0.15, top: 0.09, belt: 0.48 });
const PAINT = [0.32, 0.32, 0.31]; // cabin.js's hood paint
const RAD = Math.PI / 180;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * A mirror's render target, drawn exactly as the screen is: tone-mapped and sRGB-encoded by each material's own
 * shader. three gives a plain render target linear output without tone mapping, which is a different shader
 * program for every material of the world: switching every material's program twice a frame cost about 4 ms of
 * main-thread time. A target marked as an XR target takes the screen's tone mapping and its texture's colour space
 * (three's WebGLPrograms, getOutputColorSpace). The storage is plain RGBA8, set up while the texture is still
 * linear, so the encoded values are stored as they are (no second encoding by the hardware); the face's shader
 * decodes them.
 */
function displayTarget(renderer, w, h, samples) {
  const target = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType, samples, depthBuffer: true, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace,
  });
  renderer.initRenderTarget(target); // RGBA8, while linear
  target.texture.colorSpace = THREE.SRGBColorSpace; // read by the programs from now on
  target.isXRRenderTarget = true;
  return target;
}

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _u = new THREE.Vector3(), _d = new THREE.Vector3();

/** The reflection of point p in the plane through `center` with unit `normal`. */
export function reflectPoint(p, center, normal, out = new THREE.Vector3()) {
  const d = _v.copy(p).sub(center).dot(normal);
  return out.copy(p).addScaledVector(normal, -2 * d);
}

/**
 * The reflected camera for one mirror. Pure.
 * @param {THREE.Vector3} eye the eye in cabin coordinates
 * @param {object} face a cabin mirror (cabin.js: center, normal, right, up, corners, kind, radiusM?, minFovDeg?)
 * @param {{ far?: number }} [opts]
 * @returns {{ position: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3, left: number, right: number,
 *   top: number, bottom: number, near: number, far: number, tan: { l: number, r: number, b: number, t: number },
 *   barrel: number[] | null, k: number, matrix: THREE.Matrix4, projection: THREE.Matrix4, fovY: number }}
 *   matrix: camera to cabin coordinates; tan: the frustum's tangents (x right, y up); fovY: the vertical field an
 *   on-axis camera with the same pixel scale would have (degrees)
 */
export function mirrorView(eye, face, { far = MIRROR_FAR } = {}) {
  const c = face.center;
  const n = _n.copy(face.normal).normalize();
  if (_d.copy(eye).sub(c).dot(n) < 0) n.negate(); // the normal toward the eye
  const position = reflectPoint(eye, c, n, new THREE.Vector3());
  const convex = face.kind === 'convex' && face.radiusM > 0;
  const z = new THREE.Vector3(), y = new THREE.Vector3(), x = new THREE.Vector3();
  let k = 1;
  // the flat mirror's frame: x = -right, y = up, z = -normal
  z.copy(n).negate();
  y.copy(face.up).addScaledVector(z, -face.up.dot(z)).normalize();
  x.crossVectors(y, z);
  if (convex) {
    // turned, by the least rotation, to look along the central ray reflected (so the face's axes keep their roll)
    const D = _d.copy(c).sub(eye).length();
    const dir = _d.normalize();
    const r = dir.clone().addScaledVector(n, -2 * dir.dot(n));
    const q = new THREE.Quaternion().setFromUnitVectors(n, r);
    x.applyQuaternion(q); y.applyQuaternion(q); z.copy(r).negate();
    k = 1 + (2 * D) / face.radiusM;
  }
  // the corners' tangents from E' in the camera's frame
  let l = Infinity, rt = -Infinity, b = Infinity, t = -Infinity, depth = Infinity;
  for (const P of Object.values(face.corners)) {
    _u.copy(P).sub(position);
    const zc = -_u.dot(z);
    const tx = _u.dot(x) / zc, ty = _u.dot(y) / zc;
    l = Math.min(l, tx); rt = Math.max(rt, tx); b = Math.min(b, ty); t = Math.max(t, ty);
    depth = Math.min(depth, zc);
  }
  let near, barrel = null;
  if (convex) {
    // symmetric about the central ray, every angle k times the flat mirror's
    const aH = Math.min(40 * RAD, (k * (Math.atan(rt) - Math.atan(l))) / 2);
    const aV = Math.min(30 * RAD, (k * (Math.atan(t) - Math.atan(b))) / 2);
    const tH = Math.tan(aH), tV = Math.tan(aV);
    l = -tH; rt = tH; b = -tV; t = tV;
    barrel = [tH, tV];
    near = Math.max(0.05, depth * 0.5);
  } else {
    const minFov = face.minFovDeg ? face.minFovDeg * RAD : 0;
    const al = Math.atan(l), ar = Math.atan(rt);
    if (minFov && ar - al < minFov) {
      const mid = (al + ar) / 2, s = minFov / (ar - al);
      const bl = Math.atan(b), bt = Math.atan(t), vm = (bl + bt) / 2;
      l = Math.tan(mid - minFov / 2); rt = Math.tan(mid + minFov / 2);
      b = Math.tan(vm + (bl - vm) * s); t = Math.tan(vm + (bt - vm) * s);
    }
    near = Math.max(0.05, depth * 0.999); // the mirror's plane: nothing in front of the glass is drawn
  }
  const matrix = new THREE.Matrix4().makeBasis(x, y, z).setPosition(position);
  const projection = new THREE.Matrix4().makePerspective(l * near, rt * near, t * near, b * near, near, far);
  const fovY = (2 * Math.atan((t - b) / 2)) / RAD;
  return { position, x, y, z, left: l * near, right: rt * near, top: t * near, bottom: b * near, near, far, tan: { l, r: rt, b, t }, barrel, k, matrix, projection, fovY };
}

/**
 * Where a point (cabin coordinates) shows on a mirror's face, as the driver sees it: { u, v } in the face's UVs
 * (u to the driver's right, v up) and `inside` when it is on the glass. The inverse of the face's shader.
 */
export function projectToMirror(view, P) {
  _u.copy(P).sub(view.position);
  const zc = -_u.dot(view.z);
  if (!(zc > view.near)) return { u: NaN, v: NaN, inside: false };
  const tx = _u.dot(view.x) / zc, ty = _u.dot(view.y) / zc;
  let su = (tx - view.tan.l) / (view.tan.r - view.tan.l), sv = (ty - view.tan.b) / (view.tan.t - view.tan.b); // texture 0..1
  if (view.barrel) {
    const [bh, bv] = view.barrel, AH = Math.atan(bh), AV = Math.atan(bv);
    su = (Math.atan((su * 2 - 1) * bh) / AH + 1) / 2;
    sv = (Math.atan((sv * 2 - 1) * bv) / AV + 1) / 2;
  }
  const u = 1 - su, v = sv;
  return { u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

/**
 * A coarser index for a regular grid mesh (post (i, j) is vertex j * nx + i, as src/city/terrain.js lays them out):
 * every `stride`-th post each way, over the same vertex buffer. A block with a hole in it (the full index skips the
 * cells under a finer grid) keeps its fine cells instead, so nothing opens at a hole's edge. About 1 / stride^2 of
 * the triangles.
 * @param {ArrayLike<number>} index the full index (two triangles a, b, d / b, e, d per cell)  @param {number} nx
 * @param {number} ny  @param {number} stride
 * @returns {Uint32Array}
 */
export function coarseGridIndex(index, nx, ny, stride) {
  const cells = new Uint8Array((nx - 1) * (ny - 1));
  for (let t = 0; t < index.length; t += 6) {
    const a = index[t], i = a % nx, j = (a - i) / nx;
    if (i < nx - 1 && j < ny - 1) cells[j * (nx - 1) + i] = 1;
  }
  const out = [];
  for (let j = 0; j < ny - 1; j += stride) {
    const j1 = Math.min(j + stride, ny - 1);
    for (let i = 0; i < nx - 1; i += stride) {
      const i1 = Math.min(i + stride, nx - 1);
      let all = true;
      for (let jj = j; jj < j1 && all; jj++) for (let ii = i; ii < i1; ii++) if (!cells[jj * (nx - 1) + ii]) { all = false; break; }
      if (all) {
        const a = j * nx + i, b = j * nx + i1, d = j1 * nx + i, e = j1 * nx + i1;
        out.push(a, b, d, b, e, d);
        continue;
      }
      for (let jj = j; jj < j1; jj++) {
        for (let ii = i; ii < i1; ii++) {
          if (!cells[jj * (nx - 1) + ii]) continue;
          const a = jj * nx + ii;
          out.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
        }
      }
    }
  }
  return Uint32Array.from(out);
}

/**
 * The mirror passes.
 * @param {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, session: object, cabinScene: THREE.Scene,
 *   faces: object, options: object, lights: THREE.Light[] }} o
 *   faces: the cabin part's mirrors; options: a preset's `mirrors` (glassPresets.js); lights: the cabin's lights
 *   (they light the interior mirror's view of the car's inside too); ground: [[mesh, stride], ...] regular grid
 *   meshes drawn coarser in the mirrors (the ground grids: millions of triangles that culling cannot reduce)
 */
export function createMirrors({ renderer, scene, session, cabinScene, faces, options, lights, ground = [] }) {
  const mirrors = {};
  const standIn = new THREE.Color(0x1c2330);
  for (const name of MIRROR_NAMES) {
    const face = faces[name], opt = options[name];
    if (!face?.mesh || !opt) continue;
    const [w, h] = opt.size;
    const target = displayTarget(renderer, w, h, options.samples || 0);
    target.texture.name = `mirror-${name}`;
    const door = name !== 'center';
    const side = name === 'left' ? 1 : name === 'right' ? -1 : 0; // the inboard edge: u = 1 on the left mirror
    const material = new THREE.ShaderMaterial({
      name: `mirror-${name}`,
      uniforms: {
        map: { value: target.texture }, uReady: { value: 0 }, uStandIn: { value: standIn.clone() },
        uReflect: { value: door ? REFLECTANCE.door : REFLECTANCE.centerDay }, uBarrel: { value: new THREE.Vector2(0, 0) },
        uExposure: { value: renderer.toneMappingExposure },
        uFlank: { value: new THREE.Vector4(door ? side : 0, FLANK.bottom, FLANK.top, FLANK.belt) },
        uFlankPaint: { value: new THREE.Color() }, uFlankGlass: { value: new THREE.Color() },
      },
      vertexShader: mirrorVertex, fragmentShader: mirrorFragment, side: THREE.DoubleSide,
      toneMapped: false, // the image is tone-mapped already; the shader maps the flank itself
    });
    const old = face.mesh.material;
    face.mesh.material = material;
    old?.dispose?.();
    const camera = new THREE.PerspectiveCamera();
    camera.matrixAutoUpdate = false;
    const cabinCam = new THREE.PerspectiveCamera();
    cabinCam.matrixAutoUpdate = false;
    cabinCam.layers.set(1);
    mirrors[name] = { name, face, opt, target, material, camera, cabinCam, view: null, renders: 0, stamp: null };
  }

  // ---------------------------------------------------------------- the car's inside, for the interior mirror
  const proxies = buildInterior();
  proxies.traverse((o) => o.layers.set(1));
  cabinScene.add(proxies);
  for (const l of lights) l.layers.enable(1);

  // ---------------------------------------------------------------- the coarse ground
  // Each grid mesh gets a second index over its own vertices, swapped in for the mirror passes only.
  // A mesh whose full index is replaced later (the wide mesh, when a terrain patch is cut out of it: session.js
  // addPatches) gets its coarse index again from the new one.
  const coarse = [];
  for (const [mesh, stride] of ground) {
    const g = mesh?.geometry, idx = g?.index, uv = g?.getAttribute('uv'), pos = g?.getAttribute('position');
    if (!idx || !uv || !pos || !(stride > 1)) continue;
    const nx = Math.round(1 / uv.array[2]) + 1, ny = pos.count / nx;
    if (!Number.isInteger(ny) || ny < 2) continue;
    const index = new THREE.BufferAttribute(coarseGridIndex(idx.array, nx, ny, stride), 1);
    coarse.push({ geometry: g, full: idx, index, nx, ny, stride });
  }
  const swapGround = (on) => {
    for (const c of coarse) {
      if (on && c.geometry.index !== c.full) {
        c.full = c.geometry.index;
        c.index = new THREE.BufferAttribute(coarseGridIndex(c.full.array, c.nx, c.ny, c.stride), 1);
      }
      // a geometry's index can be swapped between draws: the renderer binds whichever it finds
      c.geometry.index = on ? c.index : c.full;
    }
  };

  // ---------------------------------------------------------------- the world's pixel-sized things
  // and the objects the passes leave out (options.skip: names), found in the same walk of the scene
  let sized = [], skipped = [], sizedAt = -Infinity;
  let skipNames = new Set(options.skip || []);
  function findSized(frameNo) {
    if (frameNo - sizedAt < 120 && sizedAt >= 0) return sized;
    sizedAt = frameNo;
    const found = new Set();
    skipped = [];
    scene.traverse((o) => {
      const u = o.material?.uniforms;
      if (u && u.uViewport && u.uPixelAngle) found.add(o.material);
      if (o.name && skipNames.has(o.name)) skipped.push({ o, v: true });
    });
    sized = [...found].map((m) => ({ u: m.uniforms, vp: new THREE.Vector2(), pa: 0, gain: 0 }));
    return sized;
  }

  const timing = createTimings(); // the passes' own JavaScript (renderer.render's work excluded: see submits)
  const submits = createTimings(); // the CPU side of the mirror passes' renderer.render calls
  const _body = new THREE.Matrix4(), _eye = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _w = new THREE.Matrix4();
  let frameNo = 0, lastPassMs = 0, lastPixels = 0, lastCalls = 0, renders = 0, enabled = options.enabled !== false;
  let marker = null;
  const look = { dusk: 0 };
  const flank = { paint: new THREE.Color(), glass: new THREE.Color() };

  /** Light the flank and set the reflectances from the scene's sky light (the cabin's hemisphere copy). */
  function shade(hemi, sunLight) {
    const sky = hemi ? hemi.intensity : 0.5;
    const sun = sunLight ? sunLight.intensity : 0;
    // the car's side in the sky's light and a share of the sun's (it faces sideways): Lambert, albedo of the paint
    const e = sky * 0.7 + sun * 0.25;
    flank.paint.setRGB(PAINT[0] * e / Math.PI, PAINT[1] * e / Math.PI, PAINT[2] * e / Math.PI);
    if (hemi) flank.paint.multiply(hemi.color);
    flank.glass.copy(flank.paint).multiplyScalar(0.18);
    for (const m of Object.values(mirrors)) {
      m.material.uniforms.uFlankPaint.value.copy(flank.paint);
      m.material.uniforms.uFlankGlass.value.copy(flank.glass);
      if (m.name === 'center') m.material.uniforms.uReflect.value = REFLECTANCE.centerDay + (REFLECTANCE.centerNight - REFLECTANCE.centerDay) * look.dusk;
    }
  }

  /**
   * Draw the mirrors due on this frame. Called from the cabin's beforeWorld, before the world and the cabin are drawn.
   * @param {object} frame the session's frame  @param {object} L rig.last (cabin view)  @param {{ all?: boolean }} [opt]
   * @returns {number} the pass's own JavaScript, ms (renderer.render's work excluded)
   */
  function render(frame, L, { all = false } = {}) {
    lastPassMs = 0;
    if (!enabled) return 0;
    frameNo++;
    const due = mirrorsDue(frameNo, options, all || !frame.playing);
    if (!due.length) { lastPixels = 0; return 0; }
    const t0 = performance.now();
    _eye.setFromMatrixPosition(L.head);
    _body.copy(L.body);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    // the shadow map (refreshed on demand: shadowMap.autoUpdate is off) is redrawn by the first pass when it is due,
    // and then not again by the world's draw that follows; only buildings cast shadows, so it is the same map
    const traffic = session.part?.('traffic');
    const placed = traffic?.placed?.();
    const vpH = frame.viewport?.height || 720;
    const tw = traffic?.renderer && placed ? { s: frame.pose.s, range: traffic.renderer.rangeFor(frame.camera, vpH) * TRAFFIC_BEHIND_SHARE } : null;
    const list = findSized(frameNo);
    for (const it of list) { it.vp.copy(it.u.uViewport.value); it.pa = it.u.uPixelAngle.value; if (it.u.uGain) it.gain = it.u.uGain.value; }
    const prevExposure = renderer.toneMappingExposure;
    for (const k of skipped) { k.v = k.o.visible; k.o.visible = false; }
    const info = renderer.info.render;
    let pixels = 0, calls = 0, submit = 0;
    swapGround(true);
    // the session brought every matrix up to date for this frame (session.js render): the passes skip the scene graph's update
    const prevAutoMatrix = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    for (const name of due) {
      const m = mirrors[name];
      if (!m) continue;
      const view = mirrorView(_eye, m.face);
      m.view = view;
      const cam = m.camera;
      _w.multiplyMatrices(_body, view.matrix);
      cam.matrix.copy(_w);
      cam.matrixWorld.copy(_w);
      _w.decompose(cam.position, cam.quaternion, _s);
      cam.matrixWorldInverse.copy(_w).invert();
      cam.near = view.near; cam.far = view.far; cam.fov = view.fovY; cam.aspect = (view.tan.r - view.tan.l) / (view.tan.t - view.tan.b);
      cam.projectionMatrix.copy(view.projection);
      cam.projectionMatrixInverse.copy(view.projection).invert();
      const [w, h] = m.opt.size;
      if (tw) traffic.renderer.draw(placed, cam, h, tw);
      const pa = (view.tan.t - view.tan.b) / h;
      // the glass's reflectance, before the tone mapping: the world through the renderer's exposure, the light sprites
      // (which tone-map themselves) through their gain, so a follower's lamp seen in a dim mirror is a smaller disc
      const R = m.material.uniforms.uReflect.value;
      renderer.toneMappingExposure = prevExposure * R;
      for (const it of list) { it.u.uViewport.value.set(w, h); it.u.uPixelAngle.value = pa; if (it.u.uGain) it.u.uGain.value = it.gain * R; }
      renderer.setRenderTarget(m.target);
      renderer.autoClear = true;
      let ts = performance.now();
      renderer.render(scene, cam);
      submit += performance.now() - ts;
      calls += info.calls;
      if (name === 'center') {
        // the car's inside, over the world: the same camera in cabin coordinates
        m.cabinCam.matrix.copy(view.matrix);
        m.cabinCam.matrixWorld.copy(view.matrix);
        m.cabinCam.matrixWorldInverse.copy(view.matrix).invert();
        m.cabinCam.projectionMatrix.copy(view.projection);
        m.cabinCam.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
        renderer.autoClear = false;
        renderer.clearDepth();
        ts = performance.now();
        renderer.render(cabinScene, m.cabinCam);
        submit += performance.now() - ts;
        calls += info.calls;
      }
      m.material.uniforms.uReady.value = 1;
      if (view.barrel) m.material.uniforms.uBarrel.value.set(view.barrel[0], view.barrel[1]);
      m.renders++;
      m.stamp = { simMs: frame.simMs, frame: frameNo, eye: [_eye.x, _eye.y, _eye.z] };
      pixels += w * h;
    }
    swapGround(false);
    for (const k of skipped) k.o.visible = k.v;
    scene.matrixWorldAutoUpdate = prevAutoMatrix;
    for (const it of list) { it.u.uViewport.value.copy(it.vp); it.u.uPixelAngle.value = it.pa; if (it.u.uGain) it.u.uGain.value = it.gain; }
    renderer.toneMappingExposure = prevExposure;
    if (tw) traffic.renderer.draw(placed, frame.camera, vpH, { s: frame.pose.s, range: traffic.renderer.rangeFor(frame.camera, vpH) });
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    renders++;
    lastPixels = pixels; lastCalls = calls;
    lastPassMs = performance.now() - t0;
    const own = lastPassMs - submit;
    timing.add(own);
    submits.add(submit);
    return own;
  }

  return {
    mirrors,
    get enabled() { return enabled; },
    /** The wall time of the last render() call, ms (its own JavaScript and its renderer.render work). */
    get lastPassMs() { return lastPassMs; },
    /** Names of scene objects the passes leave out (replaces the preset's list). */
    setSkip(names) { skipNames = new Set(names || []); sizedAt = -Infinity; },
    /** Mirrors on or off (off: the faces keep their last image; for measuring what they cost). */
    setEnabled(v) { enabled = !!v; },
    setLook(l) { look.dusk = Number.isFinite(l.dusk) ? l.dusk : l.night ? 1 : 0; },
    shade,
    render,
    /** Cabin frames seen so far (a stamp's `frame` is the one its mirror was last drawn on). */
    get frame() { return frameNo; },
    /** The views of the last pass, per mirror (for tests): position, axes, frustum tangents. */
    views: () => Object.fromEntries(Object.values(mirrors).map((m) => [m.name, m.view && {
      position: m.view.position.toArray(), x: m.view.x.toArray(), y: m.view.y.toArray(), z: m.view.z.toArray(),
      tan: { ...m.view.tan }, barrel: m.view.barrel, k: m.view.k, fovY: m.view.fovY, near: m.view.near,
    }])),
    /** Per mirror: when it was last drawn ({ simMs, frame, eye }) and how often. */
    stamps: () => Object.fromEntries(Object.values(mirrors).map((m) => [m.name, m.stamp && { ...m.stamp, renders: m.renders }])),
    /**
     * A mirror's image (tone-mapped, as displayed) as linear floats 0..1 (RGBA, rows from the bottom), for tests:
     * { width, height, data }. Reads the render target back (slow; never per frame).
     */
    read(name) {
      const m = mirrors[name];
      if (!m) return null;
      const [w, h] = m.opt.size;
      const bytes = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(m.target, 0, 0, w, h, bytes);
      const data = new Float32Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) data[i] = srgbToLinear(bytes[i] / 255);
      return { width: w, height: h, data };
    },
    /** A magenta box in the world for tests (scene coordinates, metres), or null to remove it. */
    marker(at, size = 1.6) {
      if (marker) { scene.remove(marker); marker.geometry.dispose(); marker.material.dispose(); marker = null; }
      if (!at) return null;
      marker = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ color: 0xff00ff, fog: false }));
      marker.name = 'mirror-test-marker';
      marker.position.set(at.x, at.y, at.z);
      marker.updateMatrixWorld(true);
      scene.add(marker);
      return marker.name;
    },
    stats: () => ({
      enabled, renders, frame: frameNo, pixels: lastPixels, calls: lastCalls, js: timing.summary(), submit: submits.summary(),
      sizes: Object.fromEntries(Object.values(mirrors).map((m) => [m.name, [...m.opt.size, m.opt.every]])),
    }),
    dispose() {
      for (const m of Object.values(mirrors)) { m.target.dispose(); m.material.dispose(); }
      proxies.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      swapGround(false);
      cabinScene.remove(proxies);
      if (marker) this.marker(null);
    },
  };
}

/**
 * The car's inside as the interior mirror sees it (cabin coordinates, metres; assumed proportions of a crossover
 * of cabin.json's body: 1.85 m wide, roof at 1.66, rear at 2.2): the rear window's opening in a frame (C-pillars,
 * headliner, parcel shelf), the headliner over the rear seats, and the two outboard rear headrests.
 */
function buildInterior() {
  const g = new THREE.Group();
  g.name = 'mirror-interior';
  const cx = 0.37; // the car's centre line
  const trim = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.055, 0.055, 0.058), roughness: 0.9, side: THREE.DoubleSide });
  const liner = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.19, 0.18), roughness: 0.95, side: THREE.DoubleSide });
  const seat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.04, 0.04, 0.042), roughness: 0.85 });
  // the rear window's frame: a plane across the back with the opening cut out, raked (top forward)
  const W = 0.56, bottom = 0.98, top = 1.47;
  const frame = new THREE.Shape();
  frame.moveTo(-1.2, -0.4); frame.lineTo(1.2, -0.4); frame.lineTo(1.2, 1.0); frame.lineTo(-1.2, 1.0); frame.closePath();
  const hole = new THREE.Path();
  const hb = bottom - 1.2, ht = top - 1.2, r = 0.06;
  hole.moveTo(-W + r, hb); hole.lineTo(W - r, hb); hole.quadraticCurveTo(W, hb, W - 0.01, hb + r);
  hole.lineTo(W - 0.05, ht - r); hole.quadraticCurveTo(W - 0.06, ht, W - 0.06 - r, ht);
  hole.lineTo(-W + 0.06 + r, ht); hole.quadraticCurveTo(-W + 0.06, ht, -W + 0.05, ht - r);
  hole.lineTo(-W + 0.01, hb + r); hole.quadraticCurveTo(-W, hb, -W + r, hb);
  frame.holes.push(hole);
  const back = new THREE.Mesh(new THREE.ShapeGeometry(frame, 6), trim);
  back.position.set(cx, 1.2, 2.0);
  back.rotation.x = -0.35; // raked: the top leans forward
  g.add(back);
  // the headliner from the front seats to the rear window
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.0), liner);
  roof.rotation.x = Math.PI / 2;
  roof.position.set(cx, 1.58, 1.0);
  g.add(roof);
  // the outboard rear headrests (the centre one sits lower, below the mirror's view)
  for (const dx of [-0.4, 0.4]) {
    // a pill: rounded top and sides, 0.26 m wide and 0.16 m tall
    const hr = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.1, 6, 12), seat);
    hr.rotation.z = Math.PI / 2;
    hr.scale.set(1, 1, 0.55);
    hr.position.set(cx + dx, 1.13, 1.18);
    g.add(hr);
    const back2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.12), seat);
    back2.position.set(cx + dx * 1.05, 0.83, 1.3);
    back2.rotation.x = -0.25;
    g.add(back2);
  }
  return g;
}

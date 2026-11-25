// The mirrors (plan 02, D4.3; section 7.6; third stretch, decisions 3 and 8): each of the three mirror faces of the cabin
// shows the world from a camera placed by reflecting the driver's eye in the mirror's plane (mirrorGeometry.js
// mirrorView, whose header has the construction), drawn into a render target of its own.
//
//   - The passes are a pipeline stage at `beforeScene` (decision 3; plan 01 section 11.8), drawn before the shadow and
//     scene passes, so the scene pass is never split. The cabin part adds the stage and removes it on dispose.
//   - The targets hold linear HDR (half float, pre-exposed like the scene pass). The face multiplies by the glass's
//     reflectance (the eye sees a dimmer image) and the pipeline tone-maps it with the rest of the frame. The light
//     sprites size themselves from the target being drawn (sprites.js), so nothing is set aside.
//   - The traffic bodies are culled against the main camera, so traffic.renderer.draw is run again for each mirror's
//     camera, and once more for the main camera afterwards (the traffic part's lamp points and stats stay the main
//     view's). The street lamps' sprites are culled per cell against the main view (lights/index.js), so lamp heads well
//     behind the car are missing from the mirrors; the lamps' pools are not.
//   - The car is in the world scene (the cabin is drawn in the scene pass), so the passes hide it. The interior mirror's
//     view of the car's inside (the rear window's frame, the headliner, the headrests: mirrorInterior.js) is a group of
//     the world scene shown only during that mirror's pass, drawn with the world in one pass: everything behind the
//     rear window is farther than the car's inside, so no depth clear is needed. The door mirrors get the car's flank in
//     their face's shader.
//   - The coarse ground: each ground grid gets a second mesh sharing its vertices with a coarser index (mirrorGeometry.js
//     coarseGridIndex), shown instead of the grid during the passes (a swapped index would leave a GPU buffer behind at
//     every rebuild of the near ring: the renderer keys buffers by attribute). The coarse index is updated in place in a
//     buffer with room to spare, drawn with a draw range.
//   - Refresh and quality (decision 8): sizes, rates and samples come from the preset the cabin picked for app.quality's
//     level (glassPresets.js); setOptions() takes another preset when the level changes. While the clock is paused every
//     mirror is drawn on every drawn frame, so a settled frame's mirrors are current whatever the frame count.

import * as THREE from 'three';
import { RenderTarget, MeshBasicNodeMaterial, MeshStandardNodeMaterial, HalfFloatType } from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, select, mix, smoothstep, atan, tan, abs } from 'three/tsl';
import { mirrorsDue, MIRROR_NAMES } from './glassPresets.js';
import { createTimings } from '../timing.js';
import {
  FINE_M, FINE_STEP_M, GROUND_BUDGET_MS, TRAFFIC_BEHIND_SHARE, REFLECTANCE, FLANK, FLANK_PAINT, mirrorView, coarseGridIndex,
  coarseGridSteps, gridCells,
} from './mirrorGeometry.js';
import { buildInterior } from './mirrorInterior.js';

/** A mirror's target: linear HDR as the scene pass holds it, multisampled when the preset asks. */
function hdrTarget(w, h, samples) {
  const target = new RenderTarget(w, h, { type: HalfFloatType, samples, depthBuffer: true, generateMipmaps: false });
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  return target;
}

/**
 * The face's colour, linear: the image times the reflectance, the stand-in before the
 * first image, the barrel mapping on the convex mirror, the car's flank along the inboard edge of a door mirror.
 */
function faceNode(u) {
  return Fn(() => {
    // the face as the driver sees it, u right and v up (three keeps glTF's v, which runs down)
    const f = vec2(uv().x, float(1).sub(uv().y)).toVar();
    // the reflected camera's x runs against the face's u
    const t = vec2(float(1).sub(f.x), f.y).toVar();
    const s = t.mul(2).sub(1);
    const A = atan(u.barrel.max(1e-6));
    const tb = tan(s.mul(A)).div(u.barrel.max(1e-6)).mul(0.5).add(0.5);
    const tt = select(u.barrel.x.greaterThan(0), tb, t);
    // three samples a render target's texture with v running down on both backends
    const image = texture(u.map, vec2(tt.x, float(1).sub(tt.y))).rgb.mul(u.reflect);
    const c = select(u.ready.greaterThan(0.5), image, u.standIn.mul(u.reflect)).toVar();
    // the car's own side: wider low down, a window line at the beltline, a highlight along the shoulder
    const edge = select(u.flank.x.greaterThan(0), float(1).sub(f.x), f.x);
    const w = mix(u.flank.y, u.flank.z, f.y);
    const k = float(1).sub(smoothstep(w.sub(0.012), w.add(0.004), edge));
    const paint = u.flankPaint.mul(smoothstep(0, u.flank.w, f.y).mul(0.4).add(0.8));
    const side = select(f.y.greaterThan(u.flank.w), u.flankGlass, paint)
      .add(u.flankPaint.mul(0.5).mul(float(1).sub(smoothstep(0, 0.035, abs(f.y.sub(u.flank.w).add(0.03))))));
    const withFlank = mix(c, side.mul(u.reflect), k);
    return vec4(select(abs(u.flank.x).greaterThan(0), withFlank, c), 1);
  })();
}

/**
 * The mirror passes.
 * @param {{ renderer: object, scene: THREE.Scene, session: object, car: THREE.Object3D, carGroup: THREE.Object3D,
 *   faces: object, options: object, lightsNode: object, ground?: Array<[THREE.Mesh, number]>, standIn?: THREE.Color }} o
 *   car: the car's group in the world scene (hidden during the passes); carGroup: where the interior group goes (it is
 *   placed with the car); faces: the cabin part's mirrors; options: a preset's `mirrors`; lightsNode: the cabin's lights
 *   (the inside the interior mirror shows is lit as the cabin is); ground: [[mesh, stride], ...] grid meshes drawn coarser
 */
export function createMirrors({ renderer, scene, session, car, carGroup, faces, options: opts0, lightsNode, ground = [] }) {
  let options = opts0;
  const mirrors = {};
  const standIn = new THREE.Color(0x1c2330);
  for (const name of MIRROR_NAMES) {
    const face = faces[name], opt = options[name];
    if (!face?.mesh || !opt) continue;
    const [w, h] = opt.size;
    const target = hdrTarget(w, h, options.samples || 0);
    target.texture.name = `mirror-${name}`;
    const door = name !== 'center';
    const side = name === 'left' ? 1 : name === 'right' ? -1 : 0; // the inboard edge: u = 1 on the left mirror
    const u = {
      map: target.texture, ready: uniform(0), standIn: uniform(standIn.clone()),
      reflect: uniform(door ? REFLECTANCE.door : REFLECTANCE.centerDay), barrel: uniform(new THREE.Vector2(0, 0)),
      flank: uniform(new THREE.Vector4(door ? side : 0, FLANK.bottom, FLANK.top, FLANK.belt)),
      flankPaint: uniform(new THREE.Color()), flankGlass: uniform(new THREE.Color()),
    };
    const material = new MeshBasicNodeMaterial({ name: `mirror-${name}`, side: THREE.DoubleSide, fog: false });
    material.colorNode = faceNode(u);
    const old = face.mesh.material;
    face.mesh.material = material;
    old?.dispose?.();
    const camera = new THREE.PerspectiveCamera();
    camera.matrixAutoUpdate = false;
    // the renderer's clip space and depth direction from the start: otherwise its first render of this camera re-derives
    // the projection from fov and aspect (symmetric), and a projection built for WebGL's clip space without reversed depth
    // keeps only the farthest surfaces (three has no setter for the camera's reversed depth)
    camera.coordinateSystem = renderer.coordinateSystem;
    camera._reversedDepth = !!renderer.reversedDepthBuffer;
    mirrors[name] = { name, face, opt, target, material, u, camera, view: null, renders: 0, stamp: null };
  }

  // ---------------------------------------------------------------- the car's inside, for the interior mirror
  const interior = buildInterior((params) => {
    const m = new MeshStandardNodeMaterial({ ...params, fog: false });
    m.lightsNode = lightsNode;
    return m;
  });
  interior.visible = false;
  interior.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  carGroup.add(interior);

  // ---------------------------------------------------------------- the coarse ground
  const coarseGroup = new THREE.Group();
  coarseGroup.name = 'mirror-coarse-ground';
  coarseGroup.visible = false;
  coarseGroup.matrixWorldAutoUpdate = false;
  scene.add(coarseGroup);
  const coarse = [];
  for (const [mesh, stride] of ground) {
    const g = mesh?.geometry, idx = g?.index, uvA = g?.getAttribute('uv'), pos = g?.getAttribute('position');
    if (!idx || !uvA || !pos || !(stride > 1)) continue;
    const nx = Math.round(1 / uvA.array[2]) + 1, ny = pos.count / nx;
    if (!Number.isInteger(ny) || ny < 2) continue;
    const a = pos.array, step = a[3] - a[0];
    const x0 = a[0] + mesh.position.x, y0 = -(a[2] + mesh.position.z);
    const geometry = new THREE.BufferGeometry();
    for (const [k, v] of Object.entries(g.attributes)) geometry.setAttribute(k, v); // shared: one GPU buffer each
    const first = coarseGridIndex(idx.array, nx, ny, stride);
    const index = new THREE.BufferAttribute(new Uint32Array(Math.ceil(first.length * 1.5) + 6 * 4096), 1);
    index.array.set(first);
    geometry.setIndex(index);
    geometry.setDrawRange(0, first.length);
    geometry.boundingSphere = g.boundingSphere; geometry.boundingBox = g.boundingBox;
    const copy = new THREE.Mesh(geometry, mesh.material);
    copy.name = `${mesh.name || 'ground'}-coarse`;
    copy.matrixAutoUpdate = false;
    copy.matrixWorldAutoUpdate = false;
    copy.frustumCulled = mesh.frustumCulled;
    copy.renderOrder = mesh.renderOrder;
    coarseGroup.add(copy);
    coarse.push({ mesh, copy, geometry, full: idx, nx, ny, stride, x0, y0, step, at: null, cells: null, grown: 0, was: undefined });
  }
  const fineOf = (c, x, y) => {
    const r = FINE_M / c.step;
    const fi = (x - c.x0) / c.step, fj = (y - c.y0) / c.step;
    return [Math.floor(fi - r), Math.ceil(fi + r), Math.floor(fj - r), Math.ceil(fj + r)];
  };
  const rebuilt = { count: 0, lastMs: 0, maxMs: 0, maxStepMs: 0, totalMs: 0, indices: 0, pending: 0, grown: 0 };
  let job = null;
  const measure = (t0) => { const ms = performance.now() - t0; performance.measure?.('drive:mirror-ground', { start: t0, end: t0 + ms }); return ms; };
  const done = (c, index, ms) => {
    let attr = c.geometry.index;
    if (index.length > attr.array.length) {
      // no room: a bigger buffer (the old one is left to the renderer's geometry disposal; rare: counted in stats)
      attr = new THREE.BufferAttribute(new Uint32Array(Math.ceil(index.length * 1.5)), 1);
      c.geometry.setIndex(attr);
      c.grown++; rebuilt.grown++;
    }
    attr.array.set(index);
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, index.length);
    attr.needsUpdate = true;
    c.geometry.setDrawRange(0, index.length);
    rebuilt.count++; rebuilt.lastMs = ms; rebuilt.maxMs = Math.max(rebuilt.maxMs, ms); rebuilt.totalMs += ms; rebuilt.indices = index.length;
  };
  function swapGround(on, x, y) {
    if (on && Number.isFinite(x)) {
      const t0 = performance.now(), end = t0 + GROUND_BUDGET_MS;
      for (const c of coarse) {
        if (c.mesh.geometry.index === c.full) continue;
        if (job?.c === c) job = null; // a new full index (a patch cut out of the wide grid): at once
        c.full = c.mesh.geometry.index;
        c.cells = gridCells(c.full.array, c.nx, c.ny);
        c.at = [x, y];
        done(c, coarseGridIndex(c.full.array, c.nx, c.ny, c.stride, fineOf(c, x, y)), 0);
      }
      if (!job) {
        const c = coarse.find((g) => !g.at || Math.hypot(x - g.at[0], y - g.at[1]) > FINE_STEP_M);
        if (c) {
          c.cells ||= gridCells(c.full.array, c.nx, c.ny);
          job = { c, at: [x, y], ms: 0, it: coarseGridSteps(c.full.array, c.nx, c.ny, c.stride, fineOf(c, x, y), c.cells) };
          if (!c.at) { let r; do r = job.it.next(); while (!r.done); c.at = job.at; done(c, r.value, 0); job = null; }
        }
      }
      if (job) {
        let r;
        do r = job.it.next(); while (!r.done && performance.now() < end);
        const ms = measure(t0);
        job.ms += ms;
        rebuilt.maxStepMs = Math.max(rebuilt.maxStepMs, ms);
        if (r.done) { job.c.at = job.at; done(job.c, r.value, job.ms); job = null; }
      }
      rebuilt.pending = job ? 1 : 0;
    }
    coarseGroup.visible = !!on;
    for (const c of coarse) {
      if (on) {
        c.was = c.mesh.visible;
        c.copy.visible = c.was;
        c.copy.matrixWorld.copy(c.mesh.matrixWorld);
        c.mesh.visible = false;
      } else if (c.was !== undefined) { c.mesh.visible = c.was; c.was = undefined; }
    }
  }

  // objects the passes leave out (options.skip: names), found by a walk of the scene every 120 mirror frames
  let skipped = [], skippedAt = -Infinity;
  let skipNames = new Set(options.skip || []);
  function findSkipped(frameNo) {
    if (frameNo - skippedAt < 120 && skippedAt >= 0) return skipped;
    skippedAt = frameNo;
    skipped = [];
    if (skipNames.size) scene.traverse((o) => { if (o.name && skipNames.has(o.name)) skipped.push({ o, v: true }); });
    return skipped;
  }

  const timing = createTimings(); // the passes' own JavaScript (renderer.render's work excluded: see submits)
  const submits = createTimings(); // the CPU side of the mirror passes' renderer.render calls
  const _body = new THREE.Matrix4(), _eye = new THREE.Vector3(), _s = new THREE.Vector3(), _w = new THREE.Matrix4();
  let frameNo = 0, lastPassMs = 0, lastPixels = 0, lastCalls = 0, renders = 0, enabled = options.enabled !== false;
  let heldMatrices = null; // the scene's matrixWorldAutoUpdate while the passes have it off (null: not held)
  let rotate = false; // tests: rotate as while playing even on a paused frame (to time it)
  let marker = null;
  const look = { dusk: 0 };
  const flank = { paint: new THREE.Color(), glass: new THREE.Color() };

  /** Light the flank and set the interior mirror's reflectance from the scene's sky light and sun (as drawn this frame). */
  function shade(hemi, sunLight) {
    const sky = hemi ? hemi.intensity : 0.5;
    const sun = sunLight ? sunLight.intensity : 0;
    const e = sky * 0.7 + sun * 0.25;
    flank.paint.setRGB(FLANK_PAINT[0] * e / Math.PI, FLANK_PAINT[1] * e / Math.PI, FLANK_PAINT[2] * e / Math.PI);
    if (hemi) flank.paint.multiply(hemi.color);
    flank.glass.copy(flank.paint).multiplyScalar(0.18);
    for (const m of Object.values(mirrors)) {
      m.u.flankPaint.value.copy(flank.paint);
      m.u.flankGlass.value.copy(flank.glass);
      if (m.name === 'center') m.u.reflect.value = REFLECTANCE.centerDay + (REFLECTANCE.centerNight - REFLECTANCE.centerDay) * look.dusk;
    }
  }

  /**
   * Draw the mirrors due on this frame (the cabin's beforeScene stage).
   * @param {object} frame the session's frame  @param {object} L rig.last (cabin view)  @param {{ all?: boolean }} [opt]
   * @returns {number} the pass's own JavaScript, ms (renderer.render's work excluded)
   */
  function render(frame, L, { all = false } = {}) {
    lastPassMs = 0;
    if (!enabled) return 0;
    frameNo++;
    const due = mirrorsDue(frameNo, options, all || (!frame.playing && !rotate));
    if (!due.length) { lastPixels = 0; return 0; }
    const t0 = performance.now();
    _eye.setFromMatrixPosition(L.head);
    _body.copy(L.body);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const traffic = session.part?.('traffic');
    const placed = traffic?.placed?.();
    const vpH = frame.viewport?.height || 720;
    const tw = traffic?.renderer?.draw && placed ? { s: frame.pose.s, range: traffic.renderer.rangeFor(frame.camera, vpH) * TRAFFIC_BEHIND_SHARE } : null;
    for (const k of findSkipped(frameNo)) { k.v = k.o.visible; k.o.visible = false; }
    const carShown = car.visible;
    car.visible = false;
    let pixels = 0, calls = 0, submit = 0;
    // bring the scene's matrices up to date once; the passes skip the scene graph's update, and so does the scene pass
    // that follows on this frame (heldMatrices: the cabin puts the flag back after the frame is drawn)
    scene.updateMatrixWorld();
    swapGround(true, _body.elements[12], -_body.elements[14]);
    if (heldMatrices === null) heldMatrices = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    const info = renderer.info.render;
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
      // mirrorView's off-axis frustum, in this renderer's clip space and depth direction
      cam.projectionMatrix.makePerspective(view.left, view.right, view.top, view.bottom, view.near, view.far, renderer.coordinateSystem, !!renderer.reversedDepthBuffer);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      const [, h] = m.opt.size;
      if (tw) traffic.renderer.draw(placed, cam, h, tw);
      interior.visible = name === 'center';
      renderer.setRenderTarget(m.target);
      renderer.autoClear = true;
      const ts = performance.now();
      const before = info.drawCalls ?? info.calls ?? 0;
      renderer.render(scene, cam);
      submit += performance.now() - ts;
      calls += (info.drawCalls ?? info.calls ?? 0) - before;
      m.u.ready.value = 1;
      if (view.barrel) m.u.barrel.value.set(view.barrel[0], view.barrel[1]);
      m.renders++;
      m.stamp = { simMs: frame.simMs, frame: frameNo, eye: [_eye.x, _eye.y, _eye.z] };
      pixels += m.opt.size[0] * h;
    }
    interior.visible = false;
    swapGround(false);
    for (const k of skipped) k.o.visible = k.v;
    car.visible = carShown;
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

  /** Another preset's mirrors (a quality change): new targets where the size or samples changed. */
  function setOptions(next) {
    if (!next) return;
    const resample = (next.samples || 0) !== (options.samples || 0);
    options = next;
    skipNames = new Set(options.skip || []); skippedAt = -Infinity;
    enabled = options.enabled !== false;
    for (const m of Object.values(mirrors)) {
      const opt = options[m.name];
      if (!opt) continue;
      const same = opt.size[0] === m.opt.size[0] && opt.size[1] === m.opt.size[1];
      m.opt = opt;
      if (same && !resample) continue;
      const target = hdrTarget(opt.size[0], opt.size[1], options.samples || 0);
      target.texture.name = m.target.texture.name;
      m.target.dispose();
      m.target = target;
      m.u.map = target.texture;
      m.material.colorNode = faceNode(m.u);
      m.material.needsUpdate = true;
      m.u.ready.value = 0;
    }
  }

  return {
    mirrors,
    get enabled() { return enabled; },
    get lastPassMs() { return lastPassMs; },
    setSkip(names) { skipNames = new Set(names || []); skippedAt = -Infinity; },
    setEnabled(v) { enabled = !!v; },
    /** Tests: draw the mirrors in rotation, as while playing, even on paused frames (for measuring a playing frame's cost). */
    setRotation(v) { rotate = !!v; },
    /** After the frame is drawn: the scene updates its own matrices again (see render). */
    release() { if (heldMatrices !== null) { scene.matrixWorldAutoUpdate = heldMatrices; heldMatrices = null; } },
    setOptions,
    get options() { return options; },
    setLook(l) { look.dusk = Number.isFinite(l.dusk) ? l.dusk : l.night ? 1 : 0; },
    shade,
    render,
    get frame() { return frameNo; },
    views: () => Object.fromEntries(Object.values(mirrors).map((m) => [m.name, m.view && {
      position: m.view.position.toArray(), x: m.view.x.toArray(), y: m.view.y.toArray(), z: m.view.z.toArray(),
      tan: { ...m.view.tan }, barrel: m.view.barrel, k: m.view.k, fovY: m.view.fovY, near: m.view.near,
    }])),
    stamps: () => Object.fromEntries(Object.values(mirrors).map((m) => [m.name, m.stamp && { ...m.stamp, renders: m.renders }])),
    /**
     * A mirror's image as linear floats (RGBA, rows from the bottom), for tests: { width, height, data }. Scene-referred
     * (pre-exposed HDR, before the reflectance and the tone mapping). Slow.
     */
    async read(name) {
      const m = mirrors[name];
      if (!m) return null;
      const [w, h] = m.opt.size;
      const px = await renderer.readRenderTargetPixelsAsync(m.target, 0, 0, w, h);
      const data = new Float32Array(px.length);
      for (let i = 0; i < px.length; i++) data[i] = px instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat(px[i]) : px[i];
      return { width: w, height: h, data, scene: true };
    },
    marker(at, size = 1.6) {
      if (marker) { scene.remove(marker); marker.geometry.dispose(); marker.material.dispose(); marker = null; }
      if (!at) return null;
      marker = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new MeshBasicNodeMaterial({ color: 0xff00ff, fog: false }));
      marker.name = 'mirror-test-marker';
      marker.position.set(at.x, at.y, at.z);
      marker.updateMatrixWorld(true);
      scene.add(marker);
      return marker.name;
    },
    stats: () => ({
      enabled, renders, frame: frameNo, pixels: lastPixels, calls: lastCalls, js: timing.summary(), submit: submits.summary(),
      ground: { ...rebuilt, lastMs: +rebuilt.lastMs.toFixed(2), maxMs: +rebuilt.maxMs.toFixed(2), maxStepMs: +rebuilt.maxStepMs.toFixed(2), totalMs: +rebuilt.totalMs.toFixed(2) },
      sizes: Object.fromEntries(Object.values(mirrors).map((m) => [m.name, [...m.opt.size, m.opt.every]])),
      samples: options.samples || 0,
    }),
    dispose() {
      this.release();
      for (const m of Object.values(mirrors)) { m.target.dispose(); m.material.dispose(); }
      interior.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      carGroup.remove(interior);
      swapGround(false);
      // the coarse copies share the grids' vertex buffers: only their own index goes (disposing the geometry would free the shared ones)
      scene.remove(coarseGroup);
      if (marker) this.marker(null);
    },
  };
}

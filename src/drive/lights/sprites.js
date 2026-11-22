// A generic instanced light-sprite layer (plan 02, D5.4; section 7.8): street lamps now, vehicle lamps and
// obstruction lights next. One draw call per layer. Each instance is a light of some intensity in candela toward
// a reference direction with an angular pattern; its sprite follows the flux-conserving rule of lamps.js
// spriteFlux (a light smaller than a pixel keeps its summed light, a near one grows a soft disc and a halo),
// additive, depth-tested against the scene and not writing depth, with a tone that keeps colour and does not clip
// to white squares. The shader is sprites.glsl.js; its JavaScript mirror spriteMirror.js.
//
// Usage:
//   const layer = createSpriteLayer({ capacity: 4096, name: 'vehicle-lamps' });
//   scene.add(layer.mesh);
//   const tail = layer.definePattern({ kind: 'lobe', exponent: 2 });          // cos^2 around the axis
//   layer.set(i, { position: [x, y, z], color: [1, 0.05, 0.02], intensity: 30, pattern: tail, axis: [0, 0, 1] });
//   layer.commit(count);           // after writing: uploads the instance textures, draws instances 0..count-1
//   each frame: layer.setFrame({ camera, renderer, gain, ambientLux, onTable, visibility })
// For large static sets (the lamps): write once, commit, then setDrawList(indices, n) after each cull.
//
// Instance fields (see sprites.glsl.js for the texel layout):
//   position   scene metres
//   color      linear sRGB scaled to luminance 1 (any colour; lamps.js type.color is one)
//   intensity  candela for kinds 'isotropic' and 'lobe' (at the axis for a lobe); lumens for the street-lamp
//              kinds 'cutoff', 'droplens', 'highmast' (their patterns are candela per lumen)
//   pattern    an id from definePattern
//   axis       unit vector theta is measured from (default the nadir, as street lamps)
//   aim        radians counter-clockwise from map +x, the way a lamp's arm points (null: the phi-averaged pattern)
//   threshold  lux: lit while the ambient illuminance is below it (default always on)
//   warm       0 none, 1 sodium warm-up (colour and flux from the switch-on time)
//   diameter   luminous opening, metres (default lamps.js LUMINAIRE_DIAMETER_M)
//   mount      metres above the ground: > 0 adds the light of the lamp's own pool seen from afar (street lamps)
//
// Reflected twins (plan 02, D8.1; added for the weather, nothing above changes): a layer made with `reflect: true`
// gets a second mesh, a child of its own (so it shows only when the layer does), that draws a reflected streak of each
// sprite on wet pavement (sprites.glsl.js spriteTwinVertex). It draws a short list of its own: the instances within
// TWIN_LIST_M of the car, rebuilt in commitRows for layers rewritten each frame and, for written-once layers, from a
// grid of their positions when the car has moved TWIN_RELIST_M (the grid is built in idle time after commit, so the
// first rain does not wait for it). Every reflecting layer shares TWIN_UNIFORMS, which
// the weather part sets through setTwins(); with wet 0 (the default, and whenever it is dry) the twin meshes are
// hidden and their lists are not kept.

import * as THREE from 'three';
import { spriteVertex, spriteFragment, spriteTwinVertex, spriteTwinFragment, SPRITE_TEX_WIDTH, MAX_PATTERNS, ON_TABLE_N } from './sprites.glsl.js';
import { PATTERN } from './spriteMirror.js';
import { ON_TABLE } from './switching.js';
import { LUMINAIRE_DIAMETER_M } from './lamps.js';

const ALWAYS_ON = 1e30;

/** Twins are listed for instances within this distance of the car (m), horizontally. */
export const TWIN_LIST_M = 420;
/** A written-once layer's twin list is rebuilt when the car has moved this far (m). */
export const TWIN_RELIST_M = 20;
const TWIN_CELL_M = 64;
/** Instances added to a twin grid per idle slice (about 2 ms). */
const GRID_SLICE = 8192;
/** Uniforms shared by every reflecting layer's twins (see setTwins). */
export const TWIN_UNIFORMS = {
  uTwinWet: { value: 0 },
  uTwinSlope: { value: 0.05 },
  uTwinRoad: { value: new THREE.Vector4(0, 0, 0, -1) },
  uTwinPlane: { value: new THREE.Vector4(0, 0, 24, 300) },
};
const twinLayers = new Set();

/**
 * The twins of every reflecting layer (the weather part calls this each frame while it is wet, and once with wet 0
 * when it dries).
 * @param {{ wet: number, slope?: number, car?: { x: number, z: number }, forward?: { x: number, z: number },
 *   roadY?: number, grade?: number, halfWidth?: number, range?: number }} t
 *   wet: the water's share of the pavement (0 hides every twin); car, forward: the car's road point and the road's
 *   forward direction in the scene's horizontal plane; roadY, grade: the road plane's height at the car and its
 *   rise per metre forward; halfWidth, range: where twins are drawn (across and along from the car, m)
 */
export function setTwins({ wet, slope, car, forward, roadY, grade, halfWidth, range }) {
  const u = TWIN_UNIFORMS;
  u.uTwinWet.value = wet > 0 ? Math.min(1, wet) : 0;
  if (slope > 0) u.uTwinSlope.value = slope;
  if (car && forward) {
    const n = Math.hypot(forward.x, forward.z) || 1;
    u.uTwinRoad.value.set(car.x, car.z, forward.x / n, forward.z / n);
  }
  const pl = u.uTwinPlane.value;
  if (Number.isFinite(roadY)) pl.x = roadY;
  if (Number.isFinite(grade)) pl.y = grade;
  if (halfWidth > 0) pl.z = halfWidth;
  if (range > 0) pl.w = range;
  for (const l of twinLayers) l.twinFrame();
}

/**
 * @param {{ capacity: number, name?: string, minPx?: number, halo?: number, renderOrder?: number, whiten?: number, reflect?: boolean }} opts
 *   whiten: share of a clipping colour's excess turned to white (default 1); reflect: draw reflected twins on wet
 *   pavement (see the header; default false)
 */
export function createSpriteLayer({ capacity, name = 'sprites', minPx = 1.5, halo = 0.006, renderOrder = 10, whiten = 1, reflect = false }) {
  if (!(capacity > 0)) throw new Error('sprites: capacity is required');
  const rows = Math.ceil(capacity / SPRITE_TEX_WIDTH);
  const texels = SPRITE_TEX_WIDTH * rows;
  const data = [0, 1, 2, 3].map(() => new Float32Array(texels * 4));
  const textures = data.map((d) => {
    const t = new THREE.DataTexture(d, SPRITE_TEX_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  });
  const patKind = new Float32Array(MAX_PATTERNS), patK = Array.from({ length: MAX_PATTERNS }, () => new THREE.Vector3());
  let patterns = 1; // 0: isotropic

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // per drawn sprite: (instance index, weight); the weight multiplies its intensity (1 unless a cull thins a far
  // cell to every k-th lamp, which then carries k lamps' light)
  const indexArray = new Float32Array(capacity * 2);
  const identity = () => { for (let i = 0; i < capacity; i++) { indexArray[2 * i] = i; indexArray[2 * i + 1] = 1; } };
  identity();
  const indexAttr = new THREE.InstancedBufferAttribute(indexArray, 2);
  indexAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('spriteIndex', indexAttr);
  geometry.instanceCount = 0;

  const uniforms = {
    tPos: { value: textures[0] }, tColor: { value: textures[1] }, tAxis: { value: textures[2] }, tSwitch: { value: textures[3] },
    uViewport: { value: new THREE.Vector2(1, 1) }, uPixelAngle: { value: 1e-3 }, uMinPx: { value: minPx },
    uVisibility: { value: 80000 }, uGain: { value: 0.1 }, uHalo: { value: halo }, uAmbient: { value: 0 },
    uOnTable: { value: new Float32Array(ON_TABLE_N).fill(1e6) }, uOnSpec: { value: new THREE.Vector3(ON_TABLE.log0, ON_TABLE.step, ON_TABLE.n) },
    uSodium: { value: new THREE.Vector4(0.2, 0.5, 0.25, 0.52) }, uGlowRange: { value: new THREE.Vector2(800, 1000) }, uGroundAlbedo: { value: 0.15 },
    uPatKind: { value: patKind }, uPatK: { value: patK },
    // how much of what would clip turns white (spriteMirror.js toneSprite); 1, the default, for every layer but the
    // vehicle lamps (traffic/lampLayer.js), which keep more of their colour
    uWhiten: { value: whiten },
  };
  const material = new THREE.ShaderMaterial({
    name, uniforms, vertexShader: spriteVertex, fragmentShader: spriteFragment,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;

  let drawCount = 0, usingList = false;
  const size = new THREE.Vector2();

  // ---- reflected twins
  let twin = null, disposed = false;
  if (reflect) {
    const tg = new THREE.InstancedBufferGeometry();
    tg.setAttribute('corner', geometry.getAttribute('corner'));
    tg.setIndex(geometry.getIndex());
    const list = new Float32Array(capacity * 2);
    const listAttr = new THREE.InstancedBufferAttribute(list, 2);
    listAttr.setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('spriteIndex', listAttr);
    tg.instanceCount = 0;
    const tm = new THREE.ShaderMaterial({
      name: `${name}-twins`, uniforms: { ...uniforms, ...TWIN_UNIFORMS }, vertexShader: spriteTwinVertex, fragmentShader: spriteTwinFragment,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    });
    const tmesh = new THREE.Mesh(tg, tm);
    tmesh.name = `${name}-twins`;
    tmesh.frustumCulled = false;
    tmesh.matrixAutoUpdate = false;
    tmesh.renderOrder = renderOrder - 1;
    tmesh.visible = false;
    mesh.add(tmesh);
    twin = { mesh: tmesh, geometry: tg, material: tm, list, listAttr, count: 0, dynamic: false, grid: null, gridAt: 0, gridJob: null, at: [NaN, NaN] };
  }
  /** Rebuild the twin list from instances 0..n-1 (layers rewritten each frame). */
  function twinScan(n) {
    const u = TWIN_UNIFORMS.uTwinRoad.value, cx = u.x, cz = u.y, r2 = TWIN_LIST_M * TWIN_LIST_M;
    const P = data[0], L = twin.list;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const o = 4 * i, dx = P[o] - cx, dz = P[o + 2] - cz;
      if (dx * dx + dz * dz < r2 && P[o + 3] > 0) { L[2 * w] = i; L[2 * w + 1] = 1; w++; }
    }
    twinCommit(w);
  }
  /**
   * Grow the grid of a written-once layer's instances (cells of TWIN_CELL_M) up to instance `until`, from where the last
   * call stopped. The whole valley's street lamps take about 60 ms, too long for the frame the rain starts on: the grid
   * is built ahead in idle time (scheduleGrid), and finished here at once only if the rain comes first.
   */
  function growGrid(until) {
    const P = data[0];
    if (!twin.grid) { twin.grid = new Map(); twin.gridAt = 0; }
    const end = Math.min(capacity, until);
    for (let i = twin.gridAt; i < end; i++) {
      const o = 4 * i;
      if (!(P[o + 3] > 0)) continue;
      const key = (Math.floor(P[o] / TWIN_CELL_M) + 32768) * 65536 + Math.floor(P[o + 2] / TWIN_CELL_M) + 32768;
      let cell = twin.grid.get(key);
      if (!cell) twin.grid.set(key, (cell = []));
      cell.push(i);
    }
    twin.gridAt = Math.max(twin.gridAt, end);
    return twin.gridAt >= capacity;
  }
  /** Build the grid in idle time, a slice at a time (written-once layers; not while the twins are drawn). */
  function scheduleGrid() {
    if (!twin || twin.dynamic || twin.gridJob || (twin.grid && twin.gridAt >= capacity)) return;
    const idle = typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 2000 })
      : (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: false }), 50);
    const step = (deadline) => {
      twin.gridJob = null;
      if (disposed || twin.dynamic) return;
      let done = false;
      while (!done && (deadline.timeRemaining() > 2 || deadline.didTimeout)) {
        done = growGrid((twin.gridAt || 0) + GRID_SLICE);
        if (deadline.didTimeout) break;
      }
      if (!done) twin.gridJob = idle(step);
    };
    twin.gridJob = idle(step);
  }
  /** Rebuild the twin list from the grid of a written-once layer, when the car has moved TWIN_RELIST_M. */
  function twinGridList() {
    const u = TWIN_UNIFORMS.uTwinRoad.value, cx = u.x, cz = u.y;
    if (Math.hypot(cx - twin.at[0], cz - twin.at[1]) < TWIN_RELIST_M) return;
    twin.at[0] = cx; twin.at[1] = cz;
    const P = data[0];
    if (!twin.grid || twin.gridAt < capacity) growGrid(capacity); // the rest of it now
    const r = Math.ceil(TWIN_LIST_M / TWIN_CELL_M), gx = Math.floor(cx / TWIN_CELL_M), gz = Math.floor(cz / TWIN_CELL_M);
    const r2 = TWIN_LIST_M * TWIN_LIST_M, L = twin.list;
    let w = 0;
    for (let a = gx - r; a <= gx + r; a++) {
      for (let b = gz - r; b <= gz + r; b++) {
        const cell = twin.grid.get((a + 32768) * 65536 + b + 32768);
        if (!cell) continue;
        for (const i of cell) {
          const o = 4 * i, dx = P[o] - cx, dz = P[o + 2] - cz;
          if (dx * dx + dz * dz < r2 && w < capacity) { L[2 * w] = i; L[2 * w + 1] = 1; w++; }
        }
      }
    }
    twinCommit(w);
  }
  function twinCommit(w) {
    twin.count = w;
    twin.listAttr.clearUpdateRanges();
    twin.listAttr.addUpdateRange(0, Math.max(2 * w, 2));
    twin.listAttr.needsUpdate = true;
    twin.geometry.instanceCount = w;
  }

  const layer = {
    mesh, material, uniforms, capacity, data,
    get drawn() { return geometry.instanceCount; },
    /** The twins' mesh (reflect layers only), and how many twins it lists. */
    get twins() { return twin ? { mesh: twin.mesh, listed: twin.mesh.visible ? twin.count : 0 } : null; },
    /** Called by setTwins: show or hide the twins and keep the list of a written-once layer. */
    twinFrame() {
      if (!twin) return;
      const on = TWIN_UNIFORMS.uTwinWet.value > 0;
      twin.mesh.visible = on;
      if (!on) { twin.at[0] = NaN; return; }
      if (!twin.dynamic) twinGridList();
    },
    /** For a written-once layer whose instances changed: the twins' grid is rebuilt on the next frame. */
    invalidateTwins() { if (twin) { twin.grid = null; twin.gridAt = 0; twin.at[0] = NaN; scheduleGrid(); } },
    /** Whether a written-once layer's twin grid is built (for tests). */
    get twinGridReady() { return !!(twin && twin.grid && twin.gridAt >= capacity); },

    /**
     * A pattern: { kind: 'isotropic' | 'lobe' | 'cutoff' | 'droplens' | 'highmast', exponent?, kDown?, kUp?, downShare? }.
     * For the street-lamp kinds pass the lamp type's kDown and kUp (lamps.js) and 1 - uplight. Returns its id.
     */
    definePattern({ kind, exponent = 1, kDown = 0, kUp = 0, downShare = 1 }) {
      if (!(kind in PATTERN)) throw new Error(`sprites: unknown pattern kind "${kind}"`);
      if (kind === 'isotropic') return 0;
      if (patterns >= MAX_PATTERNS) throw new Error('sprites: too many patterns');
      const id = patterns++;
      patKind[id] = PATTERN[kind];
      patK[id].set(kDown, kUp, kind === 'lobe' ? exponent : downShare);
      return id;
    },

    /** Write instance i (fields above). Call commit() or markDirty() after a batch of writes. */
    set(i, { position, color = [1, 1, 1], intensity = 0, pattern = 0, axis = [0, -1, 0], aim = null,
      threshold = ALWAYS_ON, warm = 0, diameter = LUMINAIRE_DIAMETER_M, mount = 0 }) {
      const o = i * 4;
      const [a, b, c, d] = data;
      a[o] = position[0]; a[o + 1] = position[1]; a[o + 2] = position[2]; a[o + 3] = intensity;
      b[o] = color[0]; b[o + 1] = color[1]; b[o + 2] = color[2]; b[o + 3] = pattern;
      c[o] = axis[0]; c[o + 1] = axis[1]; c[o + 2] = axis[2]; c[o + 3] = aim == null || !Number.isFinite(aim) ? -10 : aim;
      d[o] = Number.isFinite(threshold) ? threshold : ALWAYS_ON; d[o + 1] = warm; d[o + 2] = diameter; d[o + 3] = mount;
    },
    /** Move instance i (dynamic layers: vehicles). */
    setPosition(i, x, y, z) { const o = i * 4; data[0][o] = x; data[0][o + 1] = y; data[0][o + 2] = z; },

    /** Upload what was written; with a count, draw instances 0..count-1 (and drop any draw list). */
    commit(count) {
      layer.markDirty();
      if (twin && !twin.dynamic) scheduleGrid(); // a written-once layer: its twins' grid built ahead, in idle time
      if (Number.isFinite(count)) {
        if (usingList) { identity(); indexAttr.clearUpdateRanges(); indexAttr.needsUpdate = true; usingList = false; }
        drawCount = Math.min(count, capacity);
        geometry.instanceCount = drawCount;
      }
    },
    markDirty() { for (const t of textures) t.needsUpdate = true; },
    /**
     * For dynamic layers rewritten every frame (vehicle lamps): upload only the texture rows holding instances
     * 0..count-1 and draw those (and drop any draw list). Added for traffic/lampLayer.js; commit() is unchanged.
     */
    commitRows(count) {
      count = Math.max(0, Math.min(count, capacity));
      if (usingList) { identity(); indexAttr.clearUpdateRanges(); indexAttr.needsUpdate = true; usingList = false; }
      const rowsUsed = Math.ceil(count / SPRITE_TEX_WIDTH);
      if (rowsUsed) {
        for (const t of textures) {
          t.clearUpdateRanges();
          for (let r = 0; r < rowsUsed; r++) t.addUpdateRange(r * SPRITE_TEX_WIDTH * 4, Math.min(SPRITE_TEX_WIDTH, count - r * SPRITE_TEX_WIDTH) * 4);
          t.needsUpdate = true;
        }
      }
      drawCount = count;
      geometry.instanceCount = count;
      if (twin) { twin.dynamic = true; if (TWIN_UNIFORMS.uTwinWet.value > 0) twinScan(count); }
    },

    /** Draw these instances only (a cull's result): indices into the instance textures, n of them, each with
     * weight 1 or weights[j]. */
    setDrawList(indices, n, weights) {
      n = Math.min(n, capacity);
      for (let j = 0; j < n; j++) { indexArray[2 * j] = indices[j]; indexArray[2 * j + 1] = weights ? weights[j] : 1; }
      indexAttr.clearUpdateRanges();
      indexAttr.addUpdateRange(0, 2 * n);
      indexAttr.needsUpdate = true;
      usingList = true;
      drawCount = n;
      geometry.instanceCount = n;
    },
    /** The draw array to fill in place before setDrawCount (saves a copy): pairs (index, weight). */
    get drawIndices() { usingList = true; return indexArray; },
    setDrawCount(n) {
      n = Math.min(n, capacity);
      indexAttr.clearUpdateRanges();
      indexAttr.addUpdateRange(0, Math.max(2 * n, 2));
      indexAttr.needsUpdate = true;
      drawCount = n;
      geometry.instanceCount = n;
    },

    /**
     * Per-frame uniforms.
     * @param {{ camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, gain?: number, ambientLux?: number,
     *   onTable?: Float32Array, visibility?: number, sodium?: { startUv: number[], steadyUv: number[] },
     *   glowRange?: number[], groundAlbedo?: number }} f
     *   gain: scene units per cd/m^2 (lighting.units.nit) times any fade
     */
    setFrame({ camera, renderer, gain, ambientLux, onTable, visibility, sodium, glowRange, groundAlbedo }) {
      renderer.getDrawingBufferSize(size);
      uniforms.uViewport.value.copy(size);
      const fov = camera.isPerspectiveCamera ? camera.getEffectiveFOV() : 50;
      uniforms.uPixelAngle.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, size.y);
      if (gain != null) uniforms.uGain.value = gain;
      if (ambientLux != null) uniforms.uAmbient.value = ambientLux;
      if (onTable) uniforms.uOnTable.value.set(onTable.map((v) => (Number.isFinite(v) ? v : -1)));
      if (visibility != null) uniforms.uVisibility.value = visibility;
      if (sodium) uniforms.uSodium.value.set(sodium.startUv[0], sodium.startUv[1], sodium.steadyUv[0], sodium.steadyUv[1]);
      if (glowRange) uniforms.uGlowRange.value.set(glowRange[0], glowRange[1]);
      if (groundAlbedo != null) uniforms.uGroundAlbedo.value = groundAlbedo;
    },

    dispose() {
      disposed = true;
      mesh.parent?.remove(mesh);
      if (twin) { twinLayers.delete(layer); twin.geometry.dispose(); twin.material.dispose(); }
      geometry.dispose();
      material.dispose();
      for (const t of textures) t.dispose();
    },
  };
  if (twin) twinLayers.add(layer);
  return layer;
}

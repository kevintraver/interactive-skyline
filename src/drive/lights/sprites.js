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

import * as THREE from 'three';
import { spriteVertex, spriteFragment, SPRITE_TEX_WIDTH, MAX_PATTERNS, ON_TABLE_N } from './sprites.glsl.js';
import { PATTERN } from './spriteMirror.js';
import { ON_TABLE } from './switching.js';
import { LUMINAIRE_DIAMETER_M } from './lamps.js';

const ALWAYS_ON = 1e30;

/**
 * @param {{ capacity: number, name?: string, minPx?: number, halo?: number, renderOrder?: number }} opts
 */
export function createSpriteLayer({ capacity, name = 'sprites', minPx = 1.5, halo = 0.006, renderOrder = 10 }) {
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

  const layer = {
    mesh, material, uniforms, capacity, data,
    get drawn() { return geometry.instanceCount; },

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
      if (Number.isFinite(count)) {
        if (usingList) { identity(); indexAttr.clearUpdateRanges(); indexAttr.needsUpdate = true; usingList = false; }
        drawCount = Math.min(count, capacity);
        geometry.instanceCount = drawCount;
      }
    },
    markDirty() { for (const t of textures) t.needsUpdate = true; },

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
      mesh.parent?.remove(mesh);
      geometry.dispose();
      material.dispose();
      for (const t of textures) t.dispose();
    },
  };
  return layer;
}

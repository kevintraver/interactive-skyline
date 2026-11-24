// Light ribbons on the route's own road (plan 02, D6.4) as a node material for plan 01's renderer (three r187): the
// sibling of ribbon.js and ribbon.glsl.js (plan 02, third stretch, decision 2), with the same factory, options and
// returned object. tests/manual/traffic-node-shots.mjs draws both and compares them; tests/unit/traffic/
// ribbon-node.test.js holds their geometry and density tables equal.
//
// Beyond the lamp sprites every lane of both carriageways is one emissive strip out to the horizon, its light
// density x per-vehicle intensity: the red river ahead and the white one coming. One draw call. The CPU side
// (geometry per route; three density sets for quantised times, the third worked out a slice per frame) is
// ribbon.js's, line for line. The shader is ribbon.glsl.js's in TSL; its header has the flux rule and the display
// rule: per vehicle, for each of its lights, the tone-mapped far sprite integrated over its profile, spread over the
// strip's pixels, so the colour written is already toned.
//
// What differs from ribbon.js, deliberately:
//  - light units (decision 6): `gain` in update() is the look's fade alone (look.beams), not lighting.units.nit x
//    the fade; the factory's `lightScale` (a number or a TSL node: the pre-exposure in the shipped look, 0.1 at the
//    classic display) carries the scale from cd/m^2. The sprite tone inside runs on gain x lightScale, as the GLSL
//    one runs on uGain.
//  - `toScene` (option): the strip's colour is a toned display value (0..1, linear). The classic renderer wrote it
//    to the canvas untouched (toneMapped false); plan 01's renderer tone-maps the whole frame after the scene pass,
//    so the caller hands a node function that turns a toned value into the scene value its output pass shows as
//    that (plan 01's displayToScene of the sRGB-encoded value, at the classic display). Default: identity, which is
//    right for linear output with no tone mapping (the parity tool).
//  - the uniforms are TSL uniform nodes in the render group (set by `.value`, as the GLSL ones); tDensity stays a
//    { value } holder of the density texture.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, varying, vec2, vec3, vec4, float, int, ivec2, uniform, textureLoad, clamp, floor, min, max, mix,
  exp, pow, dot, length, select, positionGeometry, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, renderGroup,
} from 'three/tsl';
import { LAMP_CD, LOBE, LAMP_RGB, TRUCK_MARKERS } from './lamps.js';
import { WHITEN } from './lightData.js';

export const STEP_M = 50;
export const BIN_M = 100;
export const DENSITY_Q_MS = 10000;
export const LAMP_H = 0.8;
export const WIDTH_PX = 2;
const ROWS = 16; // 2 directions x 8 lanes
const SETS = 3;
/** Frames over which a density set is worked out ahead of need. */
const SPREAD_FRAMES = 24;

const PI = Math.PI;
const shared = (v) => uniform(v).setGroup(renderGroup);
const asNode = (v) => (v && v.isNode ? v : float(v ?? 1));

// ------------------------------------------------------------------ the sprite tone (ribbon.glsl.js)
const acesFit = /*@__PURE__*/ Fn(([x0]) => {
  const x = x0.div(0.6);
  const a = x.mul(x.add(0.0245786)).sub(0.000090537);
  const b = x.mul(x.mul(0.983729).add(0.4329510)).add(0.238081);
  return clamp(a.div(b), 0, 1);
}).setLayout({ name: 'trafficRibbonAces', type: 'float', inputs: [{ name: 'x', type: 'float' }] });

/** The lamp sprites' tone (lights/sprites.glsl.js toneSprite) with the vehicle layer's whitening. */
const toneSprite = /*@__PURE__*/ Fn(([c, whiten]) => {
  const y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  const o = c.mul(acesFit(y).div(max(y, 1e-30)));
  const m = max(o.x, max(o.y, o.z));
  const white = mix(o.div(max(m, 1e-30)), vec3(1), whiten.mul(m.sub(1)).div(max(m, 1e-30)));
  return select(y.lessThanEqual(0), vec3(0), select(m.greaterThan(1), white, o));
}).setLayout({ name: 'trafficRibbonTone', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }, { name: 'whiten', type: 'float' }] });

/**
 * The toned light of one far sprite of colour x illuminance E (lux), integrated over its pixels (px^2): the sprite
 * rule at minPx (a Gaussian core e^{-r^2 / a^2}, a = 0.5 minPx / sqrt(ln 2), peak L x coreNorm), as ribbon.glsl.js.
 * `scale` is the light scale x the gain (the GLSL's uGain).
 */
const spriteDisplay = /*@__PURE__*/ Fn(([colour, E, minPx, pixelAngle, scale, whiten]) => {
  const px = minPx.mul(pixelAngle);
  const solid = px.mul(px).mul(PI / 4);
  const a = minPx.mul(0.5 / 0.8325546111576977);
  const coreNorm = minPx.mul(minPx).mul(PI / 4).div(a.mul(a).mul(PI));
  const P = E.div(solid).mul(scale).mul(coreNorm);
  // integral over u = r^2 / a^2 in [0, 8], trapezoids on a stretched grid (unrolled here: the grid is constant)
  let acc = vec3(0);
  let uPrev = 0;
  let fPrev = toneSprite(colour.mul(P), whiten);
  for (let i = 1; i <= 12; i++) {
    const t = i / 12, u = 8 * t * t;
    const f = toneSprite(colour.mul(P.mul(Math.exp(-u))), whiten);
    acc = acc.add(f.add(fPrev).mul(0.5 * (u - uPrev)));
    uPrev = u; fPrev = f;
  }
  return select(E.lessThanEqual(0), vec3(0), acc.mul(a.mul(a).mul(PI)));
}).setLayout({
  name: 'trafficRibbonSprite', type: 'vec3',
  inputs: [
    { name: 'colour', type: 'vec3' }, { name: 'E', type: 'float' }, { name: 'minPx', type: 'float' },
    { name: 'pixelAngle', type: 'float' }, { name: 'scale', type: 'float' }, { name: 'whiten', type: 'float' },
  ],
});

/**
 * The ribbon material: the vertex stage of ribbon.glsl.js (a strip of uWidthPx pixels across, facing the screen)
 * and its fragment (a Gaussian across whose integral is the width).
 * @param {object} u the uniforms  @param {import('three').Texture} tex the density table
 * @param {import('three/webgpu').Node} lightScale  @param {(c: import('three/webgpu').Node) => import('three/webgpu').Node} toScene
 */
function ribbonMaterial(u, tex, lightScale, toScene) {
  const aTangent = attribute('aTangent', 'vec3'), aInfo = attribute('aInfo', 'vec4'), aTruck = attribute('aTruck', 'float');
  const s = aInfo.x;
  const row = int(aInfo.y.add(0.5));
  const ds = s.sub(u.uCarS);
  const R = select(ds.greaterThanEqual(0), u.uAhead, u.uBehind);
  const B = u.uBand.mul(R);
  const x = clamp(ds.abs().sub(R.sub(B)).div(B), 0, 1);
  const wr = x.mul(x).mul(x.mul(-2).add(3)); // 1 - the sprites' weight (lamps.js spriteWeight)

  const rel = positionGeometry.sub(cameraPosition); // relative to the eye: no large numbers on the GPU
  const d = max(length(rel), 1);
  const toEye = rel.negate().div(d);
  const c0 = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(rel, 0)).xyz, 1));
  const c1 = cameraProjectionMatrix.mul(vec4(cameraViewMatrix.mul(vec4(rel.add(aTangent), 0)).xyz, 1));
  const hidden = wr.lessThanEqual(0).or(c0.w.lessThan(0.05)).or(c1.w.lessThan(0.05));

  const bins = u.uBins;
  const rowAt = (sv, r) => {
    const f = clamp(sv.sub(u.uS0).div(u.uBinM), 0, bins.sub(1));
    const i = floor(f);
    const i1 = min(i.add(1), bins.sub(1));
    const t = f.sub(i);
    return mix(textureLoad(tex, ivec2(int(i), r)).x, textureLoad(tex, ivec2(int(i1), r)).x, t);
  };
  const lam = mix(rowAt(s, int(u.uRows.x).add(row)), rowAt(s, int(u.uRows.y).add(row)), u.uRows.z).mul(aInfo.w);
  const c = dot(aTangent, toEye);
  const fw = max(c, 0), bw = max(c.negate(), 0);
  const T = exp(d.negate().div(u.uVisibility)).div(d.mul(d));
  const scale = u.uGain.mul(lightScale);
  const sd = (colour, E) => spriteDisplay(colour, E, u.uMinPx, u.uPixelAngle, scale, u.uWhiten);
  // a vehicle's lights toward the eye (lamps.js vehicleIntensity), each shown as its far sprite would be
  const S = sd(u.uCw, u.uCd.x.mul(2).mul(pow(fw, u.uLobe.x)).mul(T))
    .add(sd(u.uCr, u.uCd.y.mul(2).mul(pow(bw, u.uLobe.y)).add(aTruck.mul(u.uLobe.w).mul(u.uCd.w).mul(pow(bw, u.uLobe.z))).mul(T)))
    .add(sd(u.uCa, u.uLobe.w.mul(u.uCd.z).mul(pow(fw, u.uLobe.z)).mul(T)).mul(aTruck));

  const p0 = c0.xy.div(c0.w).mul(u.uViewport).mul(0.5);
  const p1 = c1.xy.div(c1.w).mul(u.uViewport).mul(0.5);
  const dp = p1.sub(p0);
  const pxPerM = max(length(dp), 1e-4);
  const dir = dp.div(pxPerM);
  const perp = vec2(dir.y.negate(), dir.x);
  const rad = lam.mul(u.uLit).mul(wr).mul(S).div(pxPerM.mul(u.uWidthPx));
  const across = aInfo.z.mul(u.uWidthPx.mul(1.5));
  const offset = perp.mul(across).mul(2).div(u.uViewport).mul(c0.w);
  const vRad = varying(select(hidden, vec3(0), rad), 'vTrafficRibbonRad');
  const vAcross = varying(select(hidden, float(0), across), 'vTrafficRibbonAcross');

  const material = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  material.name = 'traffic-ribbons';
  // hidden: zero width, the quad degenerates in place
  material.vertexNode = select(hidden, c0, c0.add(vec4(offset, 0, 0)));
  material.fragmentNode = Fn(() => {
    // a Gaussian across whose integral is uWidthPx: sigma = W / sqrt(pi), peak 1; the colour is already toned
    const sigma = u.uWidthPx.mul(0.5641895835);
    const q = vAcross.div(sigma);
    return vec4(toScene(vRad.mul(exp(q.mul(q).negate()))), 1);
  })();
  return material;
}

/**
 * @param {{ parent: THREE.Object3D, traffic: object, laneMap: object, frame: object,
 *   lightScale?: number | import('three/webgpu').Node, toScene?: (c: import('three/webgpu').Node) => import('three/webgpu').Node }} opts
 *   lightScale: physical units -> what the material writes (default 1); toScene: see the header (default identity)
 */
export function createRibbons({ parent, traffic, laneMap, frame, lightScale = 1, toScene = (c) => c }) {
  const [S0, S1] = traffic.range;
  const nPts = Math.ceil((S1 - S0) / STEP_M) + 1;
  const sAt = (i) => Math.min(S1, S0 + i * STEP_M);
  // ---- geometry
  const strips = [];
  for (const [di, dir] of [[0, 'with'], [1, 'against']]) {
    const lanes = traffic.lanes(dir).map((L) => L.lane);
    const segs = traffic.segments(dir).slice().sort((p, q) => p.s0 - q.s0);
    for (const lane of lanes) if (lane <= 8) strips.push({ di, dir, lane, segs });
  }
  const nV = strips.length * nPts * 2;
  const pos = new Float32Array(nV * 3), tan = new Float32Array(nV * 3), info = new Float32Array(nV * 4), truck = new Float32Array(nV);
  const index = [];
  const lm = { sRoad: 0, d: 0, dds: 0, w: 0 }, r = {};
  let v = 0;
  for (const st of strips) {
    const ld = laneMap.dirs[st.dir];
    let g = 0;
    const base = v;
    for (let i = 0; i < nPts; i++) {
      const s = sAt(i);
      while (g + 1 < st.segs.length && st.segs[g + 1].s0 <= s) g++;
      laneMap.atDir(ld, st.lane, s, lm);
      ld.refline.at(lm.sRoad, r);
      const ch = Math.cos(r.heading), sh = Math.sin(r.heading);
      const mx = r.x - sh * lm.d, my = r.y + ch * lm.d;
      const Y = frame.sceneY(r.h + r.crossfall * lm.d, mx, my) + LAMP_H;
      const tx = ch - sh * lm.dds, ty = sh + ch * lm.dds;
      const tl = Math.hypot(tx, ty, r.grade);
      for (let side = -1; side <= 1; side += 2) {
        pos[3 * v] = mx; pos[3 * v + 1] = Y; pos[3 * v + 2] = -my;
        tan[3 * v] = tx / tl; tan[3 * v + 1] = r.grade / tl; tan[3 * v + 2] = -ty / tl;
        info[4 * v] = s; info[4 * v + 1] = st.di * 8 + st.lane - 1; info[4 * v + 2] = side; info[4 * v + 3] = lm.w;
        truck[v] = st.segs[g].truckShare || 0;
        v++;
      }
      if (i > 0) {
        const a = base + 2 * (i - 1);
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(tan, 3));
  geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  geometry.setAttribute('aTruck', new THREE.BufferAttribute(truck, 1));
  geometry.setIndex(nV > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));

  // ---- density table
  const bins = Math.ceil((S1 - S0) / BIN_M) + 1;
  const texData = new Float32Array(bins * ROWS * SETS);
  const tex = new THREE.DataTexture(texData, bins, ROWS * SETS, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const setQ = [NaN, NaN, NaN]; // the quantum each set holds (complete)
  let pending = null; // { set, q, next: bin index }
  const dens = new Float32Array(8);

  function fillBins(set, q, b0, b1) {
    const ms = q * DENSITY_Q_MS;
    for (let b = b0; b < b1; b++) {
      const s = Math.min(S1, S0 + b * BIN_M);
      for (let di = 0; di < 2; di++) {
        traffic.laneDensities(di === 0 ? 'with' : 'against', s, ms, dens);
        for (let l = 0; l < 8; l++) texData[(set * ROWS + di * 8 + l) * bins + b] = dens[l];
      }
    }
  }
  /** The set holding quantum q, worked out now if it is not there; keep: quanta not to evict. */
  function ensureSet(q, keep) {
    let set = setQ.indexOf(q);
    if (set >= 0) return set;
    if (pending && pending.q === q) {
      fillBins(pending.set, q, pending.next, bins);
      setQ[pending.set] = q; set = pending.set; pending = null;
      tex.needsUpdate = true;
      return set;
    }
    set = freeSet(keep);
    fillBins(set, q, 0, bins);
    setQ[set] = q;
    tex.needsUpdate = true;
    return set;
  }
  /** A set not holding any of the quanta in `keep` (and not pending). */
  function freeSet(keep) {
    for (let k = 0; k < SETS; k++) if (!keep.includes(setQ[k]) && !(pending && pending.set === k)) return k;
    return 0;
  }

  const uniforms = {
    tDensity: { value: tex }, uS0: shared(S0), uBinM: shared(BIN_M), uBins: shared(bins), uRows: shared(new THREE.Vector3(0, 0, 0)),
    uCarS: shared(0), uAhead: shared(4000), uBehind: shared(2000), uBand: shared(0.25),
    uViewport: shared(new THREE.Vector2(1, 1)), uPixelAngle: shared(1e-3), uWidthPx: shared(WIDTH_PX),
    uVisibility: shared(80000), uGain: shared(1), uLit: shared(1),
    uCw: shared(new THREE.Vector3(...LAMP_RGB.white)), uCr: shared(new THREE.Vector3(...LAMP_RGB.red)), uCa: shared(new THREE.Vector3(...LAMP_RGB.amber)),
    uCd: shared(new THREE.Vector4(LAMP_CD.head, LAMP_CD.tail, LAMP_CD.amber, LAMP_CD.red)),
    uLobe: shared(new THREE.Vector4(LOBE.head, LOBE.tail, LOBE.marker, TRUCK_MARKERS)),
    uMinPx: shared(1.5), uWhiten: shared(WHITEN),
  };
  const material = ribbonMaterial(uniforms, tex, asNode(lightScale), toScene);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'traffic-ribbons';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  parent.add(mesh);
  const size = new THREE.Vector2();
  const stats = { filledBins: 0 };

  /**
   * Per frame. @param {{ simMs: number, carS: number, ahead: number, behind: number, band: number, camera, renderer,
   *   gain: number, lit: number, visibility: number, on: boolean }} f  gain: the look's fade (no light units)
   */
  function update({ simMs, carS, ahead, behind, band, camera, renderer, gain, lit, visibility, on }) {
    mesh.visible = !!on && gain > 0 && lit > 0;
    if (!mesh.visible) return;
    const q = Math.floor(simMs / DENSITY_Q_MS);
    const a = ensureSet(q, [q, q + 1]), b = ensureSet(q + 1, [q, q + 1]);
    // work out the next quantum ahead of need, a slice per frame
    if (setQ.indexOf(q + 2) < 0) {
      if (!pending || pending.q !== q + 2) {
        const keep = [q, q + 1];
        pending = null;
        pending = { set: freeSet(keep), q: q + 2, next: 0 };
        setQ[pending.set] = NaN;
      }
      const n = Math.ceil(bins / SPREAD_FRAMES);
      const b1 = Math.min(bins, pending.next + n);
      fillBins(pending.set, pending.q, pending.next, b1);
      stats.filledBins += b1 - pending.next;
      pending.next = b1;
      if (b1 >= bins) { setQ[pending.set] = pending.q; pending = null; tex.needsUpdate = true; }
    }
    uniforms.uRows.value.set(a * ROWS, b * ROWS, (simMs - q * DENSITY_Q_MS) / DENSITY_Q_MS);
    uniforms.uCarS.value = carS;
    uniforms.uAhead.value = ahead; uniforms.uBehind.value = behind; uniforms.uBand.value = band;
    renderer.getDrawingBufferSize(size);
    uniforms.uViewport.value.copy(size);
    const fov = camera.isPerspectiveCamera ? camera.getEffectiveFOV() : 50;
    uniforms.uPixelAngle.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, size.y);
    uniforms.uGain.value = gain; uniforms.uLit.value = lit; uniforms.uVisibility.value = visibility || 80000;
  }

  return {
    mesh, update, uniforms,
    /** Forget the density sets (the traffic's lanes were shifted or the model changed). */
    invalidate() { setQ.fill(NaN); pending = null; },
    stats: () => ({ strips: strips.length, vertices: nV, bins, filledBins: stats.filledBins, visible: mesh.visible }),
    dispose() { parent.remove(mesh); geometry.dispose(); material.dispose(); tex.dispose(); },
  };
}

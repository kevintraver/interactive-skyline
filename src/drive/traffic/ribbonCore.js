// Light ribbons on the route's own road (plan 02, D6.4): the work on the CPU, with no shader in it. ribbon.js
// hands this its material and the way it makes a uniform.
//
// Geometry (per route, once): each lane's centre line from the lane map (lanemap.js), sampled every STEP_M of
// route chainage, at LAMP_H above the pavement, with its direction of travel, lane weight and truck share.
// Density (per frame, cheap): demand.js laneDensities at every BIN_M of route chainage for three quantised
// times t_q, t_q + Q, t_q + 2Q (Q = DENSITY_Q_MS); the shader mixes the first two by (t - t_q) / Q, so the light
// changes continuously with time, and the third is worked out a slice per frame while the first two are in use
// (all of it at once after a seek). The rows are a pure function of t_q.

import * as THREE from 'three';
import { LAMP_CD, LOBE, LAMP_RGB, TRUCK_MARKERS } from './lamps.js';

export const STEP_M = 50;
export const BIN_M = 100;
export const DENSITY_Q_MS = 10000;
export const LAMP_H = 0.8;
export const WIDTH_PX = 2;
export const ROWS = 16; // 2 directions x 8 lanes
const SETS = 3;
/** Frames over which a density set is worked out ahead of need. */
const SPREAD_FRAMES = 24;

/**
 * The ribbons of one route.
 * @param {{ parent: THREE.Object3D, traffic: object, laneMap: object, frame: object,
 *   uniform: (value: *) => { value: * }, gain0: number,
 *   material: (uniforms: object, tex: THREE.DataTexture) => THREE.Material }} opts
 *   uniform: makes one uniform holding `value` (a { value } object, or a TSL uniform node); gain0: uGain's first value;
 *   material: the renderer's ribbon material for these uniforms and the density table
 */
export function createRibbonsWith({ parent, traffic, laneMap, frame, uniform, gain0, material: makeMaterial }) {
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

  const u = uniform;
  const uniforms = {
    tDensity: { value: tex }, uS0: u(S0), uBinM: u(BIN_M), uBins: u(bins), uRows: u(new THREE.Vector3(0, 0, 0)),
    uCarS: u(0), uAhead: u(4000), uBehind: u(2000), uBand: u(0.25),
    uViewport: u(new THREE.Vector2(1, 1)), uPixelAngle: u(1e-3), uWidthPx: u(WIDTH_PX),
    uVisibility: u(80000), uGain: u(gain0), uLit: u(1),
    uCw: u(new THREE.Vector3(...LAMP_RGB.white)), uCr: u(new THREE.Vector3(...LAMP_RGB.red)), uCa: u(new THREE.Vector3(...LAMP_RGB.amber)),
    uCd: u(new THREE.Vector4(LAMP_CD.head, LAMP_CD.tail, LAMP_CD.amber, LAMP_CD.red)),
    uLobe: u(new THREE.Vector4(LOBE.head, LOBE.tail, LOBE.marker, TRUCK_MARKERS)),
  };
  const material = makeMaterial(uniforms, tex);
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
   *   gain: number, lit: number, visibility: number, on: boolean }} f
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

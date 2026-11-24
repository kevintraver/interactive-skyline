// The mirrors' geometry (plan 02, D4.3; section 7.6), shared by both renderers' mirror passes (mirrors.js on the classic
// renderer, mirrors.node.js on plan 01's): the reflected camera of each mirror (mirrorView, pure; the construction is
// described at the top of mirrors.js), where a point shows on a mirror's face, the coarser ground index the passes draw,
// and the constants of the passes (reflectance, the door mirrors' flank, the near-ground ring).

import * as THREE from 'three';

/** Metres around the car within which the mirrors draw each ground grid at its full resolution, and how far the car
 * moves before that ring is moved with it. */
export const FINE_M = 1200, FINE_STEP_M = 400;
/** Milliseconds of a mirror frame the near-ground rebuild may take (it is spread over frames: swapGround). */
export const GROUND_BUDGET_MS = 2;
export const MIRROR_FAR = 150000; // the main camera's far plane (rig.js FAR): the sky dome is 120 km out
/** The share of the traffic part's body range kept behind the car when it looks ahead (traffic/index.js BEHIND_SHARE). */
export const TRAFFIC_BEHIND_SHARE = 0.35;
/** Reflectance (assumed): door mirrors about half (FMVSS 111 asks at least 35%; chromium-coated glass is about 50%);
 * the interior mirror's silvered glass 0.8 by day, dimmed toward 0.3 at night as an auto-dimming mirror does. */
export const REFLECTANCE = Object.freeze({ door: 0.5, centerDay: 0.8, centerNight: 0.3 });
/** The door mirrors' flank: share of the face at the bottom and top, and the beltline's height (assumed, by eye). */
export const FLANK = Object.freeze({ bottom: 0.15, top: 0.09, belt: 0.48 });
export const FLANK_PAINT = [0.32, 0.32, 0.31]; // cabin.js's hood paint
const RAD = Math.PI / 180;

/** sRGB-encoded 0..1 to linear. */
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

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
 * the triangles. Blocks that touch `fine` (a range of cells [i0, i1] x [j0, j1], inclusive) keep their fine cells
 * too: a coarse triangle spans stride^2 cells and lies metres above or below the ground drawn on screen, so near
 * the car it would rise through the road behind it in a mirror.
 * @param {ArrayLike<number>} index the full index (two triangles a, b, d / b, e, d per cell)  @param {number} nx
 * @param {number} ny  @param {number} stride  @param {number[]|null} [fine] [i0, i1, j0, j1]
 * @returns {Uint32Array}
 */
export function coarseGridIndex(index, nx, ny, stride, fine = null) {
  const it = coarseGridSteps(index, nx, ny, stride, fine);
  let r;
  do r = it.next(); while (!r.done);
  return r.value;
}

/** The cells (nx - 1) x (ny - 1) a full grid index draws: 1 where it has a cell's two triangles. */
export function gridCells(index, nx, ny) {
  const cells = new Uint8Array((nx - 1) * (ny - 1));
  for (let t = 0; t < index.length; t += 6) {
    const a = index[t], i = a % nx, j = (a - i) / nx;
    if (i < nx - 1 && j < ny - 1) cells[j * (nx - 1) + i] = 1;
  }
  return cells;
}

/**
 * coarseGridIndex as a generator that yields after each row of blocks (and every 1024 blocks) and returns the index, so that the work can be
 * spread over frames (the mirrors' near-ground rebuild); `cells` (gridCells of `index`) may be passed in when known.
 */
export function* coarseGridSteps(index, nx, ny, stride, fine = null, cells = null) {
  cells ||= gridCells(index, nx, ny);
  let out = new Uint32Array(Math.max(64, Math.ceil(index.length / (stride * stride)) + 6 * 1024)), n = 0;
  const push6 = (a, b, c, d, e, f) => {
    if (n + 6 > out.length) { const o = new Uint32Array(out.length * 2); o.set(out); out = o; }
    out[n++] = a; out[n++] = b; out[n++] = c; out[n++] = d; out[n++] = e; out[n++] = f;
  };
  let blocks = 0;
  for (let j = 0; j < ny - 1; j += stride) {
    const j1 = Math.min(j + stride, ny - 1);
    for (let i = 0; i < nx - 1; i += stride) {
      if (++blocks % 1024 === 0) yield j; // and within a long row
      const i1 = Math.min(i + stride, nx - 1);
      let all = !(fine && i1 > fine[0] && i <= fine[1] && j1 > fine[2] && j <= fine[3]);
      for (let jj = j; jj < j1 && all; jj++) for (let ii = i; ii < i1; ii++) if (!cells[jj * (nx - 1) + ii]) { all = false; break; }
      if (all) {
        const a = j * nx + i, b = j * nx + i1, d = j1 * nx + i, e = j1 * nx + i1;
        push6(a, b, d, b, e, d);
        continue;
      }
      for (let jj = j; jj < j1; jj++) {
        for (let ii = i; ii < i1; ii++) {
          if (!cells[jj * (nx - 1) + ii]) continue;
          const a = jj * nx + ii;
          push6(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
        }
      }
    }
    yield j;
  }
  return out.slice(0, n);
}


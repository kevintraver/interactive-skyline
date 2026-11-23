// Keeping the explore camera valid: the pivot (controls.target) stays over real terrain and rides it, and the
// camera stays above the ground. It wraps controls.update(), so it sees every update: the frame loop's, the ones
// the controls make inside their own pointer handlers, and setView's.
//
// It acts only on the visitor's own motion. A controls 'start' (a pointer or wheel gesture on the canvas) arms it;
// any change to the camera or the pivot made outside controls.update() (a journey, setView, focusOn's flight, a
// test or the landmark checker through window.__skyline) disarms it until the next gesture, so those moves are
// never altered, delayed or fought. Switching `enabled` off (other modes) passes every update straight through.
//
// Pure maths on {x, y, z} objects, no three.js: the unit tests drive it with fake controls and a fake height field.
// World: x east, y up, z south. Height functions here take world (x, z); the app's groundY takes map (x, north).
import { curveDrop } from '../core/earth.js';

/** How far inside the outer terrain grid the pivot must stay, in meters. */
export const BOUNDS_MARGIN = 3000;
/** Where the fine grid gives way to the coarse one, the pivot's ground blends between them over this band. */
const BLEND_BAND = 400;

/** World-space box for the pivot: the extent of the grid `{x0, y0, nx, ny, step}` less `margin`. */
export function boundsFromGrid(g, margin = BOUNDS_MARGIN) {
  const x1 = g.x0 + (g.nx - 1) * g.step, y1 = g.y0 + (g.ny - 1) * g.step;
  const m = Math.min(margin, (x1 - g.x0) / 4, (y1 - g.y0) / 4);
  return { minX: g.x0 + m, maxX: x1 - m, minZ: -y1 + m, maxZ: -g.y0 - m };
}

/**
 * Clamp `v` to [lo, hi], except that a value that was already outside (`prev`, placed there by something else) may
 * stay where it was: it can only move back towards the box, never jump to it.
 */
export function clampAxis(v, lo, hi, prev) {
  const a = Math.min(lo, prev), b = Math.max(hi, prev);
  return v < a ? a : v > b ? b : v;
}

/** The camera's clearance above the ground: the larger of 10 m and 1 % of its distance to the pivot. */
export const clearanceFor = (dist) => Math.max(10, 0.01 * dist);

/**
 * The height above ground the camera must keep after an update. A camera that was clear before the update
 * (`before` at least `clearanceBefore`, the clearance for its old distance) must keep the full clearance for its new
 * distance. One that was already lower (a street-level view puts it there) may not go lower than it was, and is
 * not pushed up while it stays where it is. Once the visitor moves it sideways it climbs, half a metre for each
 * metre travelled (`moved`), until it has the full clearance: a low eye that orbits or pans away from its spot would
 * otherwise skim the slope, and the near plane (5 m) cuts into ground that close, which shows the sky under the hill.
 */
export const LOW_CAMERA_RISE = 0.5;
export const allowedHeight = (clearance, before, clearanceBefore = clearance, moved = 0) =>
  (before >= clearanceBefore - 1e-6 ? clearance : Math.min(clearance, before + LOW_CAMERA_RISE * moved));

/** How wide an area the pivot's ground is averaged over: wider as the camera pulls back. */
export const smoothRadius = (dist) => Math.min(1500, Math.max(30, 0.08 * dist));

/** The ground under the pivot, averaged over a cross of five points `r` apart: rides relief without bobbing. */
export function smoothGround(h, x, z, r) {
  return (h(x, z) * 2 + h(x + r, z) + h(x - r, z) + h(x, z + r) + h(x, z - r)) / 6;
}

/**
 * The pivot's own height function (world x, z): the fine grid where it reaches, the coarse one beyond, blended
 * over a band at the fine grid's edge so the pivot does not step where the drawn ground has a seam.
 */
export function makePivotGround(near, far, base) {
  const nx1 = near.x0 + (near.nx - 1) * near.step, ny1 = near.y0 + (near.ny - 1) * near.step;
  return (x, z) => {
    const y = -z;
    const f = far.sample(x, y);
    const d = Math.min(x - near.x0, nx1 - x, y - near.y0, ny1 - y);
    let h = f;
    if (d > 0) {
      const t = Math.min(d / BLEND_BAND, 1), w = t * t * (3 - 2 * t);
      h = f + (near.sample(x, y) - f) * w;
    }
    return h - base - curveDrop(x, y);
  };
}

/**
 * Lift `cam` along its orbit about `tgt` (same distance, same compass direction, a steeper angle) until it is at
 * least `agl` above `ground(x, z)`; straight up if even overhead is too low. Mutates `cam`; true if it moved.
 */
export function liftAlongOrbit(cam, tgt, ground, agl, iterations = 8) {
  const ox = cam.x - tgt.x, oz = cam.z - tgt.z, oy = cam.y - tgt.y;
  const r = Math.sqrt(ox * ox + oy * oy + oz * oz), hr = Math.sqrt(ox * ox + oz * oz);
  const ux = hr > 1e-9 ? ox / hr : 0, uz = hr > 1e-9 ? oz / hr : 0;
  let moved = false;
  for (let i = 0; i < iterations; i++) {
    const need = ground(cam.x, cam.z) + agl;
    if (cam.y >= need) return moved;
    moved = true;
    const cy = need - tgt.y;
    if (cy >= r) { cam.y = need; return moved; }
    const h = Math.sqrt(r * r - cy * cy);
    cam.x = tgt.x + ux * h; cam.y = need; cam.z = tgt.z + uz * h;
  }
  const need = ground(cam.x, cam.z) + agl;
  if (cam.y < need) { cam.y = need; moved = true; }
  return moved;
}

const dist3 = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
/** Moved by more than a micrometre: the controls' own spherical round trip shifts the camera by less each frame. */
const moved = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 > 1e-12;
const copy = (to, from) => { to.x = from.x; to.y = from.y; to.z = from.z; return to; };

/**
 * Wrap `controls.update` so every update by the visitor leaves a valid camera.
 * @param {object} o
 * @param {{x:number,y:number,z:number, lookAt?:Function}} o.camera  the camera (its `position` is read and written)
 * @param {object} o.controls  OrbitControls (or a fake with target, update, addEventListener)
 * @param {(x:number, z:number) => number} o.ground  drawn ground height at world (x, z)
 * @param {(x:number, z:number) => number} o.pivotGround  the pivot's ground at world (x, z), see makePivotGround
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} o.bounds
 * @param {() => void} [o.invalidate]
 */
export function createCameraLimits({ camera, controls, ground, pivotGround, bounds, invalidate = () => {} }) {
  const pos = camera.position, tgt = controls.target;
  const update = controls.update.bind(controls);
  const lastCam = copy({}, pos), lastTgt = copy({}, tgt); // the camera as the last update left it
  const cam0 = { x: 0, y: 0, z: 0 }, tgt0 = { x: 0, y: 0, z: 0 }, c1 = { x: 0, y: 0, z: 0 }, t1 = { x: 0, y: 0, z: 0 };
  const hist = { x: NaN, z: NaN, r: NaN, h: 0 }; // the pivot's ground where it stood last, so a drag samples it once
  const limits = {
    enabled: true,
    /** True between a visitor's gesture and the next move by anything else. */
    armed: false,
    bounds,
    clearance: clearanceFor,
    /** Corrections made since the page loaded: pivot clamped, camera lifted, zoom stopped. */
    stats: { clamped: 0, lifted: 0, zoomStopped: 0 },
    update: limitedUpdate,
  };

  const pivotH = (x, z, r) => {
    if (x === hist.x && z === hist.z && r === hist.r) return hist.h;
    return smoothGround(pivotGround, x, z, r);
  };

  function limitedUpdate(deltaTime) {
    if (!same(pos, lastCam) || !same(tgt, lastTgt) || !limits.enabled || controls.enabled === false) limits.armed = false;
    copy(cam0, pos); copy(tgt0, tgt);
    let changed = update(deltaTime);
    if (limits.armed) holdInsideDistances();
    if (limits.armed && (moved(pos, cam0) || moved(tgt, tgt0)) && correct()) {
      if (camera.lookAt) camera.lookAt(tgt.x, tgt.y, tgt.z);
      invalidate();
      changed = true;
    }
    copy(lastCam, pos); copy(lastTgt, tgt);
    return changed;
  }

  /**
   * Zoomed fully in or out, the controls' spherical round trip can land the distance a hair outside minDistance or
   * maxDistance; clamping it back then counts as a zoom, and 'change' fires on every frame for ever (the loop never
   * goes idle). Keep the distance a ten-millionth inside: 15 micrometres at 150 m.
   */
  function holdInsideDistances() {
    const lo = controls.minDistance, hi = controls.maxDistance;
    if (!(lo > 0) && !Number.isFinite(hi)) return;
    const r = dist3(pos, tgt);
    let want = 0;
    if (lo > 0 && r < lo * (1 + 1e-9)) want = lo * (1 + 1e-7);
    else if (Number.isFinite(hi) && r > hi * (1 - 1e-9)) want = hi * (1 - 1e-7);
    if (!want || r === 0) return;
    const k = want / r;
    pos.x = tgt.x + (pos.x - tgt.x) * k; pos.y = tgt.y + (pos.y - tgt.y) * k; pos.z = tgt.z + (pos.z - tgt.z) * k;
  }

  /** After an armed update: bounds, the terrain shift, the clearance. True if it moved anything. */
  function correct() {
    let fixed = false;
    // 1. the pivot stays over the terrain; damping does not keep pushing at the edge
    const nx = clampAxis(tgt.x, bounds.minX, bounds.maxX, tgt0.x), nz = clampAxis(tgt.z, bounds.minZ, bounds.maxZ, tgt0.z);
    if (nx !== tgt.x || nz !== tgt.z) {
      const pan = controls._panOffset;
      if (pan) {
        if ((nx < tgt.x && pan.x > 0) || (nx > tgt.x && pan.x < 0)) pan.x = 0;
        if ((nz < tgt.z && pan.z > 0) || (nz > tgt.z && pan.z < 0)) pan.z = 0;
      }
      pos.x += nx - tgt.x; pos.z += nz - tgt.z; tgt.x = nx; tgt.z = nz;
      limits.stats.clamped++;
      fixed = true;
    }
    // 2. the pivot and camera ride the ground under the pivot, relatively
    const dist = dist3(pos, tgt);
    if (tgt.x !== tgt0.x || tgt.z !== tgt0.z) {
      const r = smoothRadius(dist);
      const h0 = pivotH(tgt0.x, tgt0.z, r), h1 = smoothGround(pivotGround, tgt.x, tgt.z, r);
      hist.x = tgt.x; hist.z = tgt.z; hist.r = r; hist.h = h1;
      const dy = h1 - h0;
      if (dy !== 0) { tgt.y += dy; pos.y += dy; fixed = true; }
    }
    // 3. the camera stays above the ground
    const r0 = dist3(cam0, tgt0);
    const before = cam0.y - ground(cam0.x, cam0.z);
    const moved = Math.hypot(pos.x - cam0.x, pos.z - cam0.z); // sideways travel of the camera in this update
    const agl = allowedHeight(clearanceFor(dist), before, clearanceFor(r0), moved);
    if (pos.y - ground(pos.x, pos.z) >= agl) return fixed;
    if (Math.abs(dist - r0) > 1e-4 * r0) {
      // a zoom: stop it where it meets the clearance (bisect between where the camera was and where it went)
      copy(c1, pos); copy(t1, tgt);
      let lo = 0, hi = 1;
      for (let i = 0; i < 6; i++) {
        const m = (lo + hi) / 2;
        const x = cam0.x + (c1.x - cam0.x) * m, y = cam0.y + (c1.y - cam0.y) * m, z = cam0.z + (c1.z - cam0.z) * m;
        if (y - ground(x, z) >= agl) lo = m; else hi = m;
      }
      pos.x = cam0.x + (c1.x - cam0.x) * lo; pos.y = cam0.y + (c1.y - cam0.y) * lo; pos.z = cam0.z + (c1.z - cam0.z) * lo;
      tgt.x = tgt0.x + (t1.x - tgt0.x) * lo; tgt.y = tgt0.y + (t1.y - tgt0.y) * lo; tgt.z = tgt0.z + (t1.z - tgt0.z) * lo;
      limits.stats.zoomStopped++;
    }
    // a tilt or a turn (or what the zoom left): limit the polar angle by lifting the camera along its orbit
    // (lifted straight up, the distance grows and so does its 1 %: lift once more for that)
    // (1 cm above the line, so the controls' own round trip of the position next frame cannot dip under it)
    const lifted = liftAlongOrbit(pos, tgt, ground, agl + 0.01);
    if (lifted) {
      liftAlongOrbit(pos, tgt, ground, 0.01 + Math.max(agl, allowedHeight(clearanceFor(dist3(pos, tgt)), before, clearanceFor(r0), moved)));
      // a straight-up lift past maxDistance would be clamped back down into the slope by the controls next frame:
      // bring it inside and lift along the orbit again
      if (dist3(pos, tgt) > controls.maxDistance * (1 - 1e-9)) {
        holdInsideDistances();
        liftAlongOrbit(pos, tgt, ground, agl + 0.01, 12);
      }
      const spin = controls._sphericalDelta;
      if (spin && spin.phi > 0) spin.phi = 0; // stop the tilt here rather than push against it each frame
      limits.stats.lifted++;
    }
    return true;
  }

  controls.update = limitedUpdate;
  controls.addEventListener('start', () => {
    // the visitor takes the camera from wherever it is now
    copy(lastCam, pos); copy(lastTgt, tgt);
    limits.armed = limits.enabled;
  });
  return limits;
}

/** Set up the limits for the app's explore camera; returns window.__skyline.cameraLimits. */
export function initCameraLimits(app) {
  const { camera, controls, near, far, base, groundY, invalidate } = app;
  const limits = createCameraLimits({
    camera, controls, invalidate,
    ground: (x, z) => groundY(x, -z),
    pivotGround: makePivotGround(near, far, base),
    bounds: boundsFromGrid(far),
  });
  /** The drawn ground at world (x, z), for the tests. */
  limits.groundAt = (x, z) => groundY(x, -z);
  /** The outer terrain grid's own extent in world coordinates, without the margin. */
  limits.terrain = boundsFromGrid(far, 0);
  app.cameraLimits = limits;
  return limits;
}

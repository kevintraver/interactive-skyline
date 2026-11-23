// The explore camera's limits (src/interaction/cameraLimits.js) on fake controls and fake height fields: the
// bounds clamp, the relative terrain shift, the clearance rule and standing down for anything that is not the
// visitor's gesture.
import { describe, it, expect } from 'vitest';
import {
  boundsFromGrid, clampAxis, clearanceFor, allowedHeight, smoothRadius, smoothGround, makePivotGround,
  liftAlongOrbit, createCameraLimits, BOUNDS_MARGIN,
} from '../../../src/interaction/cameraLimits.js';
import { curveDrop } from '../../../src/core/earth.js';

const v = (x, y, z) => ({ x, y, z });
const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Minimal OrbitControls: update() applies whatever the test queued, like a gesture's deltas. */
function fakeControls(camera, target) {
  const listeners = {};
  const c = {
    target, enabled: true, queued: null, updates: 0,
    _panOffset: v(0, 0, 0), _sphericalDelta: { theta: 0, phi: 0, radius: 1 },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    emit(type) { for (const fn of listeners[type] || []) fn(); },
    update() {
      c.updates++;
      const q = c.queued; c.queued = null;
      if (q) q(camera.position, c.target);
      return !!q;
    },
  };
  return c;
}

/** A gesture: 'start', then one update that applies `move`. */
const gesture = (controls, move) => { controls.emit('start'); controls.queued = move; return controls.update(); };

function rig({ ground = () => 0, pivotGround = ground, bounds = { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
  cam = v(0, 500, 1000), tgt = v(0, 0, 0) } = {}) {
  const camera = { position: cam, lookAt() {} };
  const controls = fakeControls(camera, tgt);
  let invalidations = 0;
  const limits = createCameraLimits({ camera, controls, ground, pivotGround, bounds, invalidate: () => invalidations++ });
  return { camera, controls, limits, invalidations: () => invalidations };
}

describe('bounds', () => {
  it('are the outer grid less the margin, in world x and z (z = -north)', () => {
    const lv = { x0: -48000, y0: -34000, nx: 976, ny: 901, step: 80 };
    expect(boundsFromGrid(lv)).toEqual({ minX: -48000 + BOUNDS_MARGIN, maxX: 30000 - BOUNDS_MARGIN, minZ: -38000 + BOUNDS_MARGIN, maxZ: 34000 - BOUNDS_MARGIN });
    expect(boundsFromGrid(lv, 0)).toEqual({ minX: -48000, maxX: 30000, minZ: -38000, maxZ: 34000 });
  });
  it('never take more than a quarter of a small grid', () => {
    const b = boundsFromGrid({ x0: 0, y0: 0, nx: 11, ny: 11, step: 100 });
    expect(b.minX).toBe(250);
    expect(b.maxX).toBe(750);
  });
  it('clamp a value, but let one already outside stay where it was', () => {
    expect(clampAxis(5, 0, 10, 5)).toBe(5);
    expect(clampAxis(12, 0, 10, 9)).toBe(10);
    expect(clampAxis(-3, 0, 10, 1)).toBe(0);
    expect(clampAxis(15, 0, 10, 15)).toBe(15); // placed outside by something else: no jump
    expect(clampAxis(16, 0, 10, 15)).toBe(15); // and no further out
    expect(clampAxis(13, 0, 10, 15)).toBe(13); // back towards the box is free
  });
});

describe('clearance', () => {
  it('is the larger of 10 m and 1 % of the distance', () => {
    expect(clearanceFor(150)).toBe(10);
    expect(clearanceFor(1000)).toBe(10);
    expect(clearanceFor(30000)).toBe(300);
  });
  it('never pushes a camera up that was already lower', () => {
    expect(allowedHeight(10, 50)).toBe(10);
    expect(allowedHeight(35, 1.7)).toBe(1.7);
    expect(allowedHeight(10, -5)).toBe(-5);
  });
  it('lets a low camera climb as the visitor moves it sideways, up to the full clearance and no further', () => {
    expect(allowedHeight(35, 1.7, 35, 0)).toBe(1.7);        // standing still: left alone
    expect(allowedHeight(35, 1.7, 35, 10)).toBeCloseTo(6.7); // ten metres sideways: five metres up
    expect(allowedHeight(35, 1.7, 35, 1000)).toBe(35);       // far enough: the ordinary clearance
    expect(allowedHeight(35, 50, 35, 1000)).toBe(35);        // a clear camera is not lifted beyond it
  });
  it('holds a camera that was clear to the clearance for its new distance', () => {
    expect(allowedHeight(301, 300, 300)).toBe(301); // was exactly clear at 30 km; zoomed out 100 m
    expect(allowedHeight(301, 250, 300)).toBe(250); // was already low
  });
});

describe('the pivot ground', () => {
  it('averages a plane exactly and flattens a spike', () => {
    const plane = (x, z) => 0.3 * x - 0.1 * z + 7;
    expect(smoothGround(plane, 120, -40, 25)).toBeCloseTo(plane(120, -40), 9);
    const spike = (x, z) => (x === 0 && z === 0 ? 600 : 0);
    expect(smoothGround(spike, 0, 0, 20)).toBe(200);
    expect(smoothRadius(150)).toBe(30);
    expect(smoothRadius(3000)).toBe(240);
    expect(smoothRadius(30000)).toBe(1500);
  });
  it('blends the fine grid into the coarse one with no step at the seam', () => {
    const grid = (x0, y0, n, step, h) => ({ x0, y0, nx: n, ny: n, step, sample: h });
    const near = grid(-1000, -1000, 201, 10, () => 50); // fine grid 50 m higher than the coarse one
    const far = grid(-20000, -20000, 401, 100, () => 0);
    const h = makePivotGround(near, far, 0);
    expect(h(0, 0)).toBeCloseTo(50 - curveDrop(0, 0), 9);
    expect(h(5000, 0)).toBeCloseTo(-curveDrop(5000, 0), 9);
    let worst = 0;
    for (let x = 500; x < 1100; x += 1) worst = Math.max(worst, Math.abs(h(x + 1, 0) - h(x, 0)));
    expect(worst).toBeLessThan(0.25); // 50 m over a 400 m band, smoothstep: at most 0.19 m a metre
  });
});

describe('lifting along the orbit', () => {
  it('keeps the distance and the compass direction and clears the ground', () => {
    const tgt = v(0, 0, 0), cam = v(0, -40, 300); // under a flat ground at 0
    const r = len(cam, tgt);
    expect(liftAlongOrbit(cam, tgt, () => 0, 10)).toBe(true);
    expect(cam.y).toBeCloseTo(10, 6);
    expect(len(cam, tgt)).toBeCloseTo(r, 6);
    expect(cam.x).toBeCloseTo(0, 9);
    expect(cam.z).toBeGreaterThan(0);
  });
  it('follows a slope under the camera', () => {
    const slope = (x, z) => 0.5 * z; // rising behind the camera
    const tgt = v(0, 0, 0), cam = v(0, 50, 400);
    liftAlongOrbit(cam, tgt, slope, 10);
    expect(cam.y - slope(cam.x, cam.z)).toBeGreaterThanOrEqual(10 - 1e-9);
  });
  it('goes straight up when even overhead is too low', () => {
    const tgt = v(0, 0, 0), cam = v(0, 0, 200);
    liftAlongOrbit(cam, tgt, () => 500, 10);
    expect(cam.y).toBe(510);
  });
  it('leaves a camera that is high enough alone', () => {
    const cam = v(0, 300, 300);
    expect(liftAlongOrbit(cam, v(0, 0, 0), () => 0, 10)).toBe(false);
    expect(cam).toEqual(v(0, 300, 300));
  });
});

describe('the limits on the controls', () => {
  const hills = (x, z) => 200 * Math.sin(x / 700) * Math.cos(z / 900) + 0.05 * x;

  it('do nothing until the visitor starts a gesture', () => {
    const { controls, camera } = rig({ ground: hills });
    controls.queued = (p, t) => { t.x = 5000; p.x = 5000; p.y = -900; }; // e.g. setView or the landmark checker
    controls.update();
    expect(controls.target.x).toBe(5000);
    expect(camera.position.y).toBe(-900);
  });

  it('keep the pivot inside the bounds and stop the damping pushing out', () => {
    const { controls, camera, limits } = rig();
    controls._panOffset = v(400, 0, -30);
    gesture(controls, (p, t) => { t.x += 1500; p.x += 1500; t.z -= 50; p.z -= 50; });
    expect(controls.target.x).toBe(1000);
    expect(camera.position.x).toBe(1000); // the camera keeps its offset from the pivot
    expect(controls.target.z).toBe(-50);
    expect(controls._panOffset).toEqual(v(0, 0, -30)); // only the outward part is cancelled
    expect(limits.stats.clamped).toBe(1);
  });

  it('shift pivot and camera by the change in ground under the pivot, keeping a raised pivot raised', () => {
    const ground = (x) => 0.2 * x; // a steady slope: the smoothing average is exact
    const { controls, camera } = rig({ ground, cam: v(0, 600, 1000), tgt: v(0, 110, 0) });
    gesture(controls, (p, t) => { t.x += 500; p.x += 500; });
    expect(controls.target.y).toBeCloseTo(110 + 100, 6);
    expect(camera.position.y).toBeCloseTo(600 + 100, 6);
    expect(controls.target.y - ground(controls.target.x)).toBeCloseTo(110, 6);
  });

  it('ride rough relief smoothly: no step bigger than the smoothed slope allows', () => {
    const rough = (x, z) => 15 * Math.sin(x / 12) + 150 * Math.sin(x / 400) + 0 * z; // grid-scale ripples on hills
    const { controls, camera } = rig({ ground: rough, cam: v(0, 300, 300), tgt: v(0, rough(0, 0), 0) });
    let last = camera.position.y, worst = 0;
    for (let i = 0; i < 200; i++) {
      gesture(controls, (p, t) => { t.x += 5; p.x += 5; });
      worst = Math.max(worst, Math.abs(camera.position.y - last));
      last = camera.position.y;
    }
    // raw, the ground climbs up to 1.6 m per metre (ripples 1.25, hills 0.375); averaged, well under that
    expect(worst / 5).toBeLessThan(1);
  });

  it('stop a tilt at the clearance and cancel the push', () => {
    const { controls, camera, limits } = rig({ cam: v(0, 100, 1000), tgt: v(0, 0, 0) });
    controls._sphericalDelta.phi = 0.3;
    gesture(controls, (p) => { p.y = -100; p.z = Math.sqrt(1000 ** 2 + 100 ** 2 - 100 ** 2); });
    expect(camera.position.y).toBeCloseTo(clearanceFor(Math.hypot(1000, 100)) + 0.01, 6);
    expect(len(camera.position, controls.target)).toBeCloseTo(Math.hypot(1000, 100), 6);
    expect(controls._sphericalDelta.phi).toBe(0);
    expect(limits.stats.lifted).toBe(1);
  });

  it('stop a zoom into a hillside where it meets the clearance', () => {
    const wall = (x, z) => (z < 400 ? 300 : 0); // a cliff between the camera and the pivot
    const { controls, camera, limits } = rig({ ground: wall, cam: v(0, 330, 800), tgt: v(0, 300, 0) });
    gesture(controls, (p) => { p.z = 200; p.y = 305; }); // zoomed into the cliff top
    expect(camera.position.y - wall(camera.position.x, camera.position.z)).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(limits.stats.zoomStopped).toBe(1);
  });

  it('hold the line every update of a long tilt, with no oscillation once still', () => {
    const { controls, camera } = rig({ ground: hills, cam: v(300, 900, 3000), tgt: v(300, hills(300, 0), 0) });
    controls.emit('start');
    const t = controls.target;
    for (let i = 0; i < 60; i++) {
      controls.queued = (p) => { // tilt 1.5 degrees further towards the horizon and below
        const ox = p.x - t.x, oy = p.y - t.y, oz = p.z - t.z, r = Math.hypot(ox, oy, oz);
        const phi = Math.acos(oy / r) + 0.026, h = Math.hypot(ox, oz);
        p.x = t.x + (ox / h) * r * Math.sin(phi); p.z = t.z + (oz / h) * r * Math.sin(phi); p.y = t.y + r * Math.cos(phi);
      };
      controls.update();
      const dist = len(camera.position, t);
      expect(camera.position.y - hills(camera.position.x, camera.position.z)).toBeGreaterThanOrEqual(clearanceFor(dist) - 1e-6);
    }
    const still = { ...camera.position };
    for (let i = 0; i < 10; i++) controls.update();
    expect(camera.position).toEqual(still);
  });

  it('stand down after any move made outside the controls, until the next gesture', () => {
    const { controls, camera, limits } = rig({ ground: hills });
    controls.emit('start');
    expect(limits.armed).toBe(true);
    camera.position.y = -50; // a journey, focusOn's flight, a test
    controls.queued = (p, t) => { t.x += 3000; p.x += 3000; };
    controls.update();
    expect(limits.armed).toBe(false);
    expect(controls.target.x).toBe(3000);
    expect(camera.position.y).toBe(-50);
  });

  it('pass everything through when switched off, and while a tower is dragged', () => {
    const { controls, camera, limits } = rig();
    limits.enabled = false;
    gesture(controls, (p, t) => { t.x = 9000; p.y = -400; });
    expect(controls.target.x).toBe(9000);
    expect(camera.position.y).toBe(-400);
    limits.enabled = true;
    controls.emit('start');
    controls.enabled = false;
    controls.queued = (p, t) => { t.x = 9500; };
    controls.update();
    expect(controls.target.x).toBe(9500);
  });

  it('cost nothing when nothing moves: no height lookups, no invalidation', () => {
    let calls = 0;
    const ground = () => { calls++; return 0; };
    const { controls, invalidations } = rig({ ground });
    controls.emit('start');
    for (let i = 0; i < 100; i++) controls.update();
    expect(calls).toBe(0);
    expect(invalidations()).toBe(0);
  });

  it('sample the ground a few times per update during a drag', () => {
    let calls = 0;
    const ground = (x) => { calls++; return 0.1 * x; };
    const { controls } = rig({ ground });
    controls.emit('start');
    controls.queued = (p, t) => { t.x += 10; p.x += 10; };
    controls.update(); // first frame: the old spot's average too
    calls = 0;
    for (let i = 0; i < 10; i++) { controls.queued = (p, t) => { t.x += 10; p.x += 10; }; controls.update(); }
    expect(calls / 10).toBeLessThanOrEqual(7); // five for the pivot, two for the camera
  });

  it('keep a fully zoomed camera a hair inside the distance limits, so the controls do not report a zoom every frame', () => {
    // level with a pivot 1 km above flat ground, so the clearance plays no part
    const { controls, camera } = rig({ cam: v(0, 1000, 200), tgt: v(0, 1000, 0) });
    controls.minDistance = 150; controls.maxDistance = 30000;
    gesture(controls, (p) => { p.z = 149.999999999; });
    expect(len(camera.position, controls.target)).toBeCloseTo(150 * (1 + 1e-7), 9);
    gesture(controls, (p) => { p.z = 30000.0000001; });
    expect(len(camera.position, controls.target)).toBeCloseTo(30000 * (1 - 1e-7), 6);
  });
});
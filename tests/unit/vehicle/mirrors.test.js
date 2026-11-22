// The mirrors (plan 02, D4.3): the reflected cameras built from cabin.json, where points behind the car land on
// each face, and the refresh schedule (every mirror current on a settled frame; pixels per frame within 9.1).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mirrorView, projectToMirror, reflectPoint, coarseGridIndex } from '../../../src/drive/vehicle/mirrors.js';
import { GLASS_PRESETS, mirrorsDue, mirrorPixels, MIRROR_NAMES, glassPresetFor } from '../../../src/drive/vehicle/glassPresets.js';

const meta = JSON.parse(readFileSync(new URL('../../../public/models/drive/cabin.json', import.meta.url), 'utf8'));
const v3 = (a) => new THREE.Vector3(...a);
/** A face as cabin.js builds it. */
const face = (m) => ({
  center: v3(m.center), normal: v3(m.normal).normalize(), right: v3(m.right), up: v3(m.up), width: m.width, height: m.height,
  corners: Object.fromEntries(Object.entries(m.corners).map(([k, v]) => [k, v3(v)])), kind: m.kind || 'flat',
  ...(m.radiusM ? { radiusM: m.radiusM } : {}), ...(m.minFovDeg ? { minFovDeg: m.minFovDeg } : {}),
});
const faces = { left: face(meta.mirrors.left), right: face(meta.mirrors.right), center: face(meta.mirrors.center) };
const EYE = v3(meta.eye);
const CAR_X = meta.carCenterX; // the car's centre line, cabin x
const LANE = 3.7;
/** A point behind the car (cabin coordinates: +z is back): `lateral` metres from the car's centre line (+ right). */
const behind = (dist, lateral, height = 1.0) => new THREE.Vector3(CAR_X + lateral, height, dist);
const DEG = 180 / Math.PI;

describe('reflected cameras', () => {
  it('sit at the eye reflected in each mirror plane, and look back', () => {
    for (const [name, f] of Object.entries(faces)) {
      const v = mirrorView(EYE, f);
      const want = reflectPoint(EYE, f.center, f.normal);
      expect(v.position.distanceTo(want), name).toBeLessThan(1e-9);
      // the eye and its image are equidistant from the plane, on opposite sides
      expect(EYE.clone().sub(f.center).dot(f.normal)).toBeCloseTo(-v.position.clone().sub(f.center).dot(f.normal), 9);
      // the camera looks along -z: backward (cabin +z) for every mirror
      const look = v.z.clone().negate();
      expect(look.z, name).toBeGreaterThan(0.9);
      // a proper rotation (no handedness flip): x cross y = z
      expect(new THREE.Vector3().crossVectors(v.x, v.y).distanceTo(v.z)).toBeLessThan(1e-9);
      // level: the camera's x has no vertical part to speak of
      expect(Math.abs(v.x.y), `${name} roll`).toBeLessThan(0.02);
    }
  });

  it('a flat mirror shows the eye\'s reflected rays: a corner of the glass projects to that corner of the face', () => {
    for (const name of ['left', 'center']) {
      const f = faces[name], v = mirrorView(EYE, f);
      const at = (P) => projectToMirror(v, P.clone().add(P.clone().sub(v.position).multiplyScalar(5))); // beyond the glass, on the same ray
      const bl = at(f.corners.bottomLeft), tr = at(f.corners.topRight);
      if (name === 'left') { // no widening on the driver's door mirror
        expect(bl.u).toBeCloseTo(0, 6); expect(bl.v).toBeCloseTo(0, 6);
        expect(tr.u).toBeCloseTo(1, 6); expect(tr.v).toBeCloseTo(1, 6);
      }
      // the centre of the glass shows the eye's ray reflected at the centre
      const d = f.center.clone().sub(EYE).normalize();
      const r = d.clone().addScaledVector(f.normal, -2 * d.dot(f.normal));
      const p = projectToMirror(v, f.center.clone().addScaledVector(r, 40));
      expect(p.u, name).toBeGreaterThan(0.4); expect(p.u, name).toBeLessThan(0.6);
      expect(p.v, name).toBeGreaterThan(0.4); expect(p.v, name).toBeLessThan(0.6);
    }
  });

  it('the interior mirror shows at least 20 degrees (FMVSS 111); the door mirror is unit magnification', () => {
    const c = mirrorView(EYE, faces.center);
    expect((Math.atan(c.tan.r) - Math.atan(c.tan.l)) * DEG).toBeGreaterThanOrEqual(19.99);
    const l = mirrorView(EYE, faces.left);
    const seen = 2 * Math.atan(faces.left.width / 2 / EYE.distanceTo(faces.left.center)) * DEG; // as the eye sees the glass, about
    const field = (Math.atan(l.tan.r) - Math.atan(l.tan.l)) * DEG;
    expect(field / seen).toBeGreaterThan(0.8);
    expect(field / seen).toBeLessThan(1.05);
  });

  it('the convex passenger mirror has a wider field (k = 1 + 2D/R) and a barrel mapping', () => {
    const r = mirrorView(EYE, faces.right);
    const D = EYE.distanceTo(faces.right.center);
    expect(r.k).toBeCloseTo(1 + (2 * D) / faces.right.radiusM, 9);
    expect(r.k).toBeGreaterThan(3);
    expect(r.barrel).not.toBeNull();
    const field = 2 * Math.atan(r.tan.r) * DEG;
    expect(field).toBeGreaterThan(18);
    expect(field).toBeLessThan(30);
  });

  it('a car 30 m behind in the next lane to the left shows in the left mirror on its outboard side, not in the right', () => {
    const P = behind(30, -LANE);
    const L = projectToMirror(mirrorView(EYE, faces.left), P);
    expect(L.inside).toBe(true);
    // the same distance behind in our own lane is inboard of it (or off the glass): the left car is to the left
    const own = projectToMirror(mirrorView(EYE, faces.left), behind(30, 0));
    expect(!own.inside || own.u > L.u).toBe(true);
    expect(projectToMirror(mirrorView(EYE, faces.right), P).inside).toBe(false);
    // in the interior mirror it is on the left half, as the driver sees it
    const C = projectToMirror(mirrorView(EYE, faces.center), P);
    expect(C.inside).toBe(true);
    expect(C.u).toBeLessThan(0.5);
    // level: a point at the eye's height behind shows near mid-height of the interior mirror
    expect(C.v).toBeGreaterThan(0.1);
    expect(C.v).toBeLessThan(0.9);
  });

  it('a car 30 m behind in the next lane to the right shows in the right mirror and on the right of the interior one', () => {
    const P = behind(30, LANE);
    const R = projectToMirror(mirrorView(EYE, faces.right), P);
    expect(R.inside).toBe(true);
    expect(projectToMirror(mirrorView(EYE, faces.left), P).inside).toBe(false);
    const C = projectToMirror(mirrorView(EYE, faces.center), P);
    expect(C.inside).toBe(true);
    expect(C.u).toBeGreaterThan(0.5);
    // farther out shows farther out on the right mirror's face
    const far = projectToMirror(mirrorView(EYE, faces.right), behind(30, LANE + 2));
    expect(far.u).toBeGreaterThan(R.u);
  });

  it('follows the head: turning toward the left mirror moves its view, and the reflection stays consistent', () => {
    const a = mirrorView(EYE, faces.left);
    const head = EYE.clone().add(new THREE.Vector3(-0.05, 0.02, 0.03));
    const b = mirrorView(head, faces.left);
    expect(b.position.distanceTo(reflectPoint(head, faces.left.center, faces.left.normal))).toBeLessThan(1e-9);
    // moving the head right (+x) shows more of the outside in a left mirror: the view swings left (outboard)
    const right = mirrorView(EYE.clone().add(new THREE.Vector3(0.1, 0, 0)), faces.left);
    const mid = (v) => (Math.atan(v.tan.l) + Math.atan(v.tan.r)) / 2;
    const dirOf = (v) => v.z.clone().negate().applyAxisAngle(v.y, -mid(v)); // the centre of the frustum
    expect(dirOf(right).x).toBeLessThan(dirOf(a).x);
    expect(a.position.distanceTo(b.position)).toBeGreaterThan(0.01);
  });
});

describe('refresh schedule', () => {
  for (const [preset, opts] of Object.entries(GLASS_PRESETS)) {
    it(`${preset}: every mirror is current on a settled (paused) frame, whatever the frame count`, () => {
      for (let f = 0; f < 12; f++) expect(mirrorsDue(f, opts.mirrors, true)).toEqual(MIRROR_NAMES);
    });
    it(`${preset}: each mirror is drawn at its rate while playing, and the pixels per frame fit section 9.1`, () => {
      const budget = preset === 'high' ? 100000 : 25000;
      const counts = Object.fromEntries(MIRROR_NAMES.map((n) => [n, 0]));
      const N = 24;
      for (let f = 0; f < N; f++) {
        for (const n of mirrorsDue(f, opts.mirrors)) counts[n]++;
        expect(mirrorPixels(f, opts.mirrors), `frame ${f}`).toBeLessThanOrEqual(budget);
      }
      for (const n of MIRROR_NAMES) expect(counts[n], n).toBe(N / opts.mirrors[n].every);
    });
  }
  it('both presets draw one mirror a frame at most; high rotates interior, left, interior, right', () => {
    for (const opts of Object.values(GLASS_PRESETS)) for (let f = 0; f < 16; f++) expect(mirrorsDue(f, opts.mirrors).length).toBeLessThanOrEqual(1);
    const m = GLASS_PRESETS.high.mirrors;
    expect([0, 1, 2, 3].map((f) => mirrorsDue(f, m))).toEqual([['center'], ['left'], ['center'], ['right']]);
    expect(glassPresetFor('low')).toBe(GLASS_PRESETS.low);
    expect(glassPresetFor('anything')).toBe(GLASS_PRESETS.high);
  });
  it('the coarse ground keeps the grid\'s holes and about 1 / stride^2 of its triangles', () => {
    // a 9 x 7 grid of posts with a hole of 2 x 2 cells at cells (3..4, 1..2), across four 2 x 2 blocks
    const nx = 9, ny = 7, full = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      if (i >= 3 && i <= 4 && j >= 1 && j <= 2) continue;
      const a = j * nx + i;
      full.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
    }
    const c = coarseGridIndex(full, nx, ny, 2);
    // 4 x 3 coarse blocks; the hole straddles four of them, which keep their fine cells around it (3 each)
    expect(c.length / 6).toBe(8 + 4 * 3);
    const tris = new Set();
    for (let t = 0; t < c.length; t += 3) tris.add([c[t], c[t + 1], c[t + 2]].join());
    // no triangle covers a hole cell: every hole cell's corner post a = j * nx + i is not a triangle's first vertex
    for (const [i, j] of [[3, 1], [4, 1], [3, 2], [4, 2]]) { const a = j * nx + i; expect(tris.has([a, a + 1, a + nx].join())).toBe(false); }
    // an odd remainder is closed by a narrower last column
    const c3 = coarseGridIndex(full, nx, ny, 3);
    expect(Math.max(...c3) % nx).toBe(nx - 1);
  });
  it('the coarse ground keeps its own cells near the car, so it cannot rise through the road behind it', () => {
    const nx = 9, ny = 7, full = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i; full.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx); }
    const coarse = coarseGridIndex(full, nx, ny, 2);
    expect(coarse.length / 6).toBe(4 * 3); // six indices (two triangles) a block
    // cells 2..3 x 2..3 near the car: the one block over them is drawn from its four fine cells
    const near = coarseGridIndex(full, nx, ny, 2, [2, 3, 2, 3]);
    expect(near.length / 6).toBe(11 + 4);
    const tris = new Set();
    for (let t = 0; t < near.length; t += 3) tris.add([near[t], near[t + 1], near[t + 2]].join());
    for (const [i, j] of [[2, 2], [3, 2], [2, 3], [3, 3]]) { const a = j * nx + i; expect(tris.has([a, a + 1, a + nx].join())).toBe(true); }
  });
  it('targets keep each face\'s aspect within 10%', () => {
    for (const opts of Object.values(GLASS_PRESETS)) {
      for (const n of MIRROR_NAMES) {
        const [w, h] = opts.mirrors[n].size, f = meta.mirrors[n];
        expect(Math.abs(w / h / (f.width / f.height) - 1), n).toBeLessThan(0.1);
      }
    }
  });
});

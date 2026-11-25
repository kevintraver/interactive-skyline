// The flight's view layers and the cabin v0 (plan 03, sections 7.4 and 7.6; F1.5). Expected values: the window
// opening of section 6.5 (10.5 x 14.4 in), the cabin budget (20,000 triangles), the near plane of a few centimetres
// and the far plane (the eye's horizon plus the highest summit's, at most 700 km; F6.2).
import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion, PerspectiveCamera, Scene, Mesh, Triangle } from 'three';
import { createCabin } from '../../../src/flight/cabin/cabin.js';
import { createAirframe } from '../../../src/flight/aircraft/airframe.js';
import { createHeadRig, headPose } from '../../../src/flight/cabin/headRig.js';
import { seat, defaultSeat, bodyZ, stationOf } from '../../../src/flight/cabin/lopa.js';
import { createFlightLayers, nearFar, eyeInScene, CABIN_LAYER, FAR_MAX, CABIN_NEAR, CABIN_FAR } from '../../../src/flight/view/layers.js';
import { HIGHEST } from '../../../src/flight/terrain/nested.js';
import { horizonDistance } from '../../../src/core/earth.js';
import { FUSELAGE } from '../../../src/flight/aircraft/dimensions.js';

const IN = 0.0254;

/** Every triangle of a group's meshes, in the group's frame. */
function triangles(group) {
  const out = [];
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const p = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : p.count;
    for (let i = 0; i < n; i += 3) {
      const t = new Triangle();
      const get = (k) => new Vector3().fromBufferAttribute(p, idx ? idx.getX(k) : k).applyMatrix4(o.matrixWorld);
      t.set(get(i), get(i + 1), get(i + 2));
      out.push({ t, mesh: o.name });
    }
  });
  return out;
}

describe('cabin', () => {
  const s = defaultSeat();
  const cabin = createCabin({ seat: s });

  it('cuts the real window opening, 10.5 x 14.4 in, at the skin end of the reveal', () => {
    const p = cabin.parts.reveals.geometry.attributes.position;
    const w = s.nearest[0].station;
    let zMin = Infinity, zMax = -Infinity, aMin = Infinity, aMax = -Infinity;
    const R = FUSELAGE.width / 2;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i) - FUSELAGE.axisY, z = p.getZ(i);
      if (Math.abs(Math.hypot(x, y) - R) > 1e-3 || Math.abs(stationOf(z) - w) > 0.3) continue;
      const arc = R * Math.atan2(y, Math.abs(x));
      zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); aMin = Math.min(aMin, arc); aMax = Math.max(aMax, arc);
    }
    expect(zMax - zMin).toBeCloseTo(10.5 * IN, 2);
    expect(aMax - aMin).toBeCloseTo(14.4 * IN, 2);
  });

  it('opens every window position on its side except the blanks', () => {
    const c10 = createCabin({ seat: seat(10, 'A') });
    const opened = c10.windows.filter((w) => w.open).map((w) => w.station);
    const blanks = c10.windows.filter((w) => !w.open).map((w) => w.station);
    expect(blanks.some((b) => Math.abs(b - 13.65) < 0.1)).toBe(true);
    expect(blanks.some((b) => Math.abs(b - 14.67) < 0.1)).toBe(true);
    expect(opened.length).toBeGreaterThan(10);
    expect(opened.every((st) => Math.abs(st - 13.65) > 0.1 && Math.abs(st - 14.67) > 0.1)).toBe(true);
  });

  it('faces its walls into the cabin', () => {
    for (const { t, mesh } of triangles(cabin.parts.wall)) {
      const n = t.getNormal(new Vector3()), c = t.getMidpoint(new Vector3());
      const toAxis = new Vector3(-c.x, FUSELAGE.axisY - c.y, 0);
      expect(n.dot(toAxis), mesh).toBeGreaterThan(0);
    }
  });

  it('closes its ends without slivers: each end wall meets the shell at the same vertices', () => {
    // the fuselage skin is culled from inside, so any gap between the end walls and the shell shows the sky
    const key = (v) => `${v.x.toFixed(4)},${v.y.toFixed(4)}`;
    const at = (mesh, z) => {
      const p = mesh.geometry.attributes.position, set = new Set();
      for (let i = 0; i < p.count; i++) if (Math.abs(p.getZ(i) - z) < 1e-5) set.add(key({ x: p.getX(i), y: p.getY(i) }));
      return set;
    };
    const zs = [...new Set(Array.from({ length: cabin.parts.ends.geometry.attributes.position.count }, (_, i) => +cabin.parts.ends.geometry.attributes.position.getZ(i).toFixed(5)))];
    expect(zs).toHaveLength(2);
    for (const z of zs) {
      const wall = at(cabin.parts.wall, z), ends = at(cabin.parts.ends, z);
      ends.delete(key({ x: 0, y: FUSELAGE.axisY })); // the fan's centre
      expect([...ends].filter((k) => !wall.has(k))).toEqual([]);
      expect([...wall].filter((k) => !ends.has(k))).toEqual([]);
    }
  });

  it('stays inside the cabin budget of 20,000 triangles', () => {
    expect(cabin.triangles).toBeLessThan(20000);
    expect(cabin.triangles).toBeGreaterThan(500);
  });

  it('keeps every cabin surface at least 4 cm from the eye at any allowed look (the near plane is 2 cm)', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const id of ['22F', '22A', '9F', '16F', '10A']) {
      const st = seat(id);
      const c = createCabin({ seat: st });
      const tris = triangles(c.group);
      const looks = [{}, { yaw: 80, slide: 0.18, lean: 0.25 }, { yaw: -80, slide: -0.18, lean: 0.25, rise: 0.1 }, { pitch: -60, rise: -0.1, lean: 0.25 }];
      for (let i = 0; i < 40; i++) looks.push({ yaw: (rnd() - 0.5) * 170, pitch: -60 + rnd() * 95, lean: -0.15 + rnd() * 0.4, slide: (rnd() - 0.5) * 0.36, rise: (rnd() - 0.5) * 0.2 });
      for (const l of looks) {
        const eye = headPose(st, { yaw: 0, pitch: -8, lens: 26, lean: 0, slide: 0, rise: 0, ...l }).eye;
        let min = Infinity, which = '';
        const q = new Vector3();
        for (const { t, mesh } of tris) { const d = t.closestPointToPoint(eye, q).distanceTo(eye); if (d < min) { min = d; which = mesh; } }
        expect(min, `${id} ${JSON.stringify(l)} nearest ${which}`).toBeGreaterThanOrEqual(0.04);
      }
    }
  });

  it('puts the cabin on its own layer so a pick through the window reaches the world', () => {
    cabin.group.traverse((o) => { if (o instanceof Mesh) { expect(o.layers.isEnabled(CABIN_LAYER)).toBe(true); expect(o.layers.isEnabled(0)).toBe(false); } });
  });
});

describe('nearFar()', () => {
  // the horizon of the eye and the horizon of the highest summit in the region (Mount Whitney, 4,421 m): a summit
  // further than their sum is under the horizon, nearer than it may show above it (section 7.9's "how far")
  const seen = (alt) => horizonDistance(alt) + horizonDistance(HIGHEST);

  it('keeps the near plane at 2 cm and reaches every summit that can show above the horizon', () => {
    expect(nearFar(600).near).toBe(0.02);
    expect(nearFar(600).far).toBeCloseTo(seen(600), 6); // on the runway at Las Vegas (eye about 640 m above sea level)
    expect(nearFar(3000).far).toBeCloseTo(seen(3000), 6);
    expect(nearFar(10668).far).toBeCloseTo(seen(10668), 6); // 35,000 ft: 398 km + 256 km
    expect(nearFar(10668).far).toBeGreaterThan(640000);
  });

  it('is capped at FAR_MAX (above 41,000 ft, and for a broken height) and never collapses below the ground', () => {
    expect(FAR_MAX).toBe(700000);
    expect(nearFar(14000).far).toBe(FAR_MAX);
    expect(nearFar(Infinity).far).toBeGreaterThan(seen(2));
    expect(nearFar(NaN).far).toBeCloseTo(seen(2), 6);
    expect(nearFar(-50).far).toBeCloseTo(seen(2), 6);
  });

  // The depth schemes of plan 01 (src/render/renderer.js): reversed float depth on WebGPU, logarithmic depth on WebGL2
  // (three's: depth = log2(1 + w) / log2(1 + far), written to a 24-bit buffer at worst). The smallest step in distance
  // either can tell apart at a distance w:
  const reversedStep = (w, near, far) => w * 2 ** -23 * ((far - near) / far) * 2; // float32 ulp of near/w, rounded up
  const logStep = (w, far) => 2 ** -24 * (1 + w) * Math.LN2 * Math.log2(1 + far);

  it('costs WebGL2 under 3% of its depth resolution over the old 480 km cap, and WebGPU nothing it can measure', () => {
    const { near, far } = nearFar(10668);
    expect(logStep(1000, far) / logStep(1000, 480000)).toBeLessThan(1.03);
    expect(reversedStep(1000, near, far) / reversedStep(1000, near, 480000)).toBeLessThan(1.0001);
  });

  it('still separates what lies close together, at the distances it is seen from, on both backends', () => {
    const { near, far } = nearFar(10668);
    const cases = [
      // [what, distance along the ray (m), separation along the ray (m)]
      ['cabin trim 5 cm from the eye over the pane behind it', 0.05, 0.005],
      ['runway paint (3 cm up) at 30 m from a 4 m eye on the rollout', 30, 0.03 / (4 / 30)],
      ['pavement over the sunk terrain (0.29 m) from 1,000 ft at 3 km', 3000, 0.29 / (300 / 3000)],
      ['a 3 km summit 600 km away over the ground 5 km behind it', 600000, 5000],
    ];
    for (const [what, w, gap] of cases) {
      expect(logStep(w, far), `WebGL2: ${what}`).toBeLessThan(gap / 10);
      expect(reversedStep(w, near, far), `WebGPU: ${what}`).toBeLessThan(gap / 10);
    }
  });
});

describe('eyeInScene()', () => {
  it('carries the eye from body axes into the scene by the state', () => {
    const state = { position: new Vector3(1000, 600, -500), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2) };
    const pose = { eye: new Vector3(1.5, 4, 3), quaternion: new Quaternion() };
    const p = new Vector3(), q = new Quaternion();
    eyeInScene(state, pose, p, q);
    // a quarter turn about up takes body +X to scene -Z and body +Z to scene +X
    expect(p.x).toBeCloseTo(1003, 9);
    expect(p.y).toBeCloseTo(604, 9);
    expect(p.z).toBeCloseTo(-501.5, 9);
    expect(q.equals(state.quaternion)).toBe(true);
  });
});

describe('createFlightLayers()', () => {
  const setup = () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(27, 1.5, 5, 150000);
    camera.position.set(10, 2000, 3000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const airframe = createAirframe();
    const st = defaultSeat();
    const cabin = createCabin({ seat: st });
    const rig = createHeadRig({ seat: st });
    return { scene, camera, airframe, cabin, rig, layers: createFlightLayers({ scene, camera, airframe, cabin, rig }) };
  };
  const state = { position: new Vector3(0, 600, 0), quaternion: new Quaternion() };

  it('adds the aircraft to the scene, places the camera at the eye and sets near and far', () => {
    const { scene, camera, rig, layers } = setup();
    layers.attach();
    expect(scene.children).toContain(layers.body);
    layers.update(state, { aspect: 16 / 9, });
    const pose = rig.pose();
    expect(camera.position.distanceTo(pose.eye.clone().add(state.position))).toBeLessThan(1e-9);
    expect(camera.near).toBe(0.02);
    // base 0: the eye's scene height is its altitude, near enough at the origin (the sphere's drop there is nil)
    expect(camera.far).toBeCloseTo(horizonDistance(600 + pose.eye.y) + horizonDistance(HIGHEST), 0);
    expect(camera.fov).toBeCloseTo(rig.fov(16 / 9), 9);
    // the cabin is not drawn by the scene pass (F3.9): the camera does not take its layer
    expect(camera.layers.isEnabled(CABIN_LAYER)).toBe(false);
    expect(layers.body.position.equals(state.position)).toBe(true);
  });

  it('keeps the cabin out of the scene, in a scene of its own that follows the body (F3.9)', () => {
    const { scene, cabin, layers } = setup();
    layers.attach();
    const turned = { position: new Vector3(12, 600, -40), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7) };
    layers.update(turned, { aspect: 16 / 9 });
    let inScene = false;
    scene.traverse((o) => { if (o === cabin.group) inScene = true; });
    expect(inScene).toBe(false);
    let inCabinScene = false;
    layers.cabinScene.traverse((o) => { if (o === cabin.group) inCabinScene = true; });
    expect(inCabinScene).toBe(true);
    // a cabin point lands where it would on the body
    layers.body.updateMatrixWorld(true);
    expect(cabin.group.matrixWorld.equals(layers.body.matrixWorld)).toBe(true);
    layers.detach();
    expect(layers.cabinScene.children[0].visible).toBe(false);
  });

  it('gives the cabin pass a camera at the eye with the cabin layer and its own near and far', () => {
    const { camera, layers } = setup();
    layers.attach();
    layers.update(state, { aspect: 16 / 9 });
    const c = layers.cabinCamera();
    expect(c.position.equals(camera.position)).toBe(true);
    expect(c.quaternion.equals(camera.quaternion)).toBe(true);
    expect([c.fov, c.aspect, c.near, c.far]).toEqual([camera.fov, camera.aspect, CABIN_NEAR, CABIN_FAR]);
    expect(c.layers.isEnabled(CABIN_LAYER)).toBe(true);
    expect(c.layers.isEnabled(0)).toBe(false);
    expect(c.matrixWorld.equals(camera.matrixWorld)).toBe(true);
    // a view offset (the map's tiles) carries over
    camera.setViewOffset(1600, 900, 100, 50, 800, 450);
    expect(layers.cabinCamera().view).toEqual(camera.view);
    camera.clearViewOffset();
  });

  it('passes the head shake to the rig: the eye drops and nods by it, and without it the camera is as before', () => {
    const { camera, layers } = setup();
    layers.attach();
    layers.update(state, { aspect: 16 / 9 });
    const still = { p: camera.position.clone(), q: camera.quaternion.clone() };
    layers.update(state, { aspect: 16 / 9, shake: { rise: -0.015, pitch: -0.8 } });
    // 1.5 cm down, and a little more from the nod (the head turns about a pivot behind the eye)
    expect(camera.position.y - still.p.y).toBeLessThan(-0.015);
    expect(camera.position.y - still.p.y).toBeGreaterThan(-0.02);
    expect(camera.quaternion.angleTo(still.q) * 180 / Math.PI).toBeCloseTo(0.8, 3);
    layers.update(state, { aspect: 16 / 9, shake: { rise: 0, pitch: 0 } });
    expect(camera.position.distanceTo(still.p)).toBeLessThan(1e-12);
  });

  it('restores the camera exactly on detach', () => {
    const { scene, camera, layers } = setup();
    const before = { p: camera.position.clone(), q: camera.quaternion.clone(), fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect, mask: camera.layers.mask, proj: camera.projectionMatrix.clone() };
    layers.attach();
    layers.update(state, { aspect: 2, });
    layers.detach();
    expect(scene.children).not.toContain(layers.body);
    expect(camera.position.equals(before.p)).toBe(true);
    expect(camera.quaternion.equals(before.q)).toBe(true);
    expect([camera.fov, camera.near, camera.far, camera.aspect, camera.layers.mask]).toEqual([before.fov, before.near, before.far, before.aspect, before.mask]);
    expect(camera.projectionMatrix.equals(before.proj)).toBe(true);
  });

  it('hides the cabin and puts the eye at the pane in the clean view', () => {
    const { camera, cabin, rig, layers } = setup();
    layers.attach();
    layers.cleanView(true);
    layers.update(state, { aspect: 16 / 9, });
    expect(cabin.group.visible).toBe(false);
    const eye = camera.position.clone().sub(state.position);
    expect(Math.hypot(eye.x, eye.y - FUSELAGE.axisY)).toBeCloseTo(FUSELAGE.trimRadius, 6);
    layers.cleanView(false);
    layers.update(state, { aspect: 16 / 9, });
    expect(cabin.group.visible).toBe(true);
    expect(camera.position.distanceTo(rig.pose().eye.clone().add(state.position))).toBeLessThan(1e-9);
  });
});

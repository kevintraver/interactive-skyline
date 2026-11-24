// The flight's view layers and the cabin v0 (plan 03, sections 7.4 and 7.6; F1.5). Expected values: the window
// opening of section 6.5 (10.5 x 14.4 in), the cabin budget (20,000 triangles), the near plane of a few centimetres
// and the far plane of section 7.6's table (horizon distance + 80 km, at most 480 km).
import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion, PerspectiveCamera, Scene, Mesh, Triangle } from 'three';
import { createCabin } from '../../../src/flight/cabin/cabin.js';
import { createAirframe } from '../../../src/flight/aircraft/airframe.js';
import { createHeadRig, headPose } from '../../../src/flight/cabin/headRig.js';
import { seat, defaultSeat, bodyZ, stationOf } from '../../../src/flight/cabin/lopa.js';
import { createFlightLayers, nearFar, eyeInScene, CABIN_LAYER } from '../../../src/flight/view/layers.js';
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
  it('keeps the near plane at 2 cm and puts the far plane 80 km past the horizon, at most 480 km', () => {
    expect(nearFar(600).near).toBe(0.02);
    expect(nearFar(600).far).toBeCloseTo(horizonDistance(600) + 80000, 6);
    expect(nearFar(11000).far).toBe(480000);
    expect(nearFar(-5).far).toBeGreaterThan(80000); // on the ground or below the datum: still past the airport
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
    layers.update(state, { aspect: 16 / 9, heightAboveGround: 600 });
    const pose = rig.pose();
    expect(camera.position.distanceTo(pose.eye.clone().add(state.position))).toBeLessThan(1e-9);
    expect(camera.near).toBe(0.02);
    expect(camera.far).toBeCloseTo(horizonDistance(600 + pose.eye.y) + 80000, 0);
    expect(camera.fov).toBeCloseTo(rig.fov(16 / 9), 9);
    expect(camera.layers.isEnabled(CABIN_LAYER)).toBe(true);
    expect(layers.body.position.equals(state.position)).toBe(true);
  });

  it('restores the camera exactly on detach', () => {
    const { scene, camera, layers } = setup();
    const before = { p: camera.position.clone(), q: camera.quaternion.clone(), fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect, mask: camera.layers.mask, proj: camera.projectionMatrix.clone() };
    layers.attach();
    layers.update(state, { aspect: 2, heightAboveGround: 600 });
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
    layers.update(state, { aspect: 16 / 9, heightAboveGround: 600 });
    expect(cabin.group.visible).toBe(false);
    const eye = camera.position.clone().sub(state.position);
    expect(Math.hypot(eye.x, eye.y - FUSELAGE.axisY)).toBeCloseTo(FUSELAGE.trimRadius, 6);
    layers.cleanView(false);
    layers.update(state, { aspect: 16 / 9, heightAboveGround: 600 });
    expect(cabin.group.visible).toBe(true);
    expect(camera.position.distanceTo(rig.pose().eye.clone().add(state.position))).toBeLessThan(1e-9);
  });
});

// The modelled cabin (plan 03, F3.5): cabin.glb as the app places it. The layout covers the window side from end to
// end with bays on the open windows and plain strips elsewhere (blanks included); the real model's window opening
// at the skin is the published one within 5 mm (section 6.5, [B4]) and its triangles are inside the 20,000 budget;
// the left side is a mirror that still faces the cabin; the loader shows the v0 cabin at once, swaps the model in, and
// keeps the v0 cabin when loading fails.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Box3, Vector3, Matrix4, BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cabinLayout, buildModelledCabin, createModelledCabin, mirrorGeometryX, CABIN_LAYER, MODEL_HALF_LENGTH } from '../../../src/flight/cabin/cabin.js';
import { seat, windowStations, defaultSeat } from '../../../src/flight/cabin/lopa.js';
import { FUSELAGE, WINDOW, CABIN, bodyZ } from '../../../src/flight/aircraft/dimensions.js';
import { createEnvNodes } from '../../../src/env/nodes.js';

const ROOT = new URL('../../../', import.meta.url);
const nodes = createEnvNodes({ state: null });

async function realModel() {
  const buf = readFileSync(new URL('public/models/aircraft/cabin.glb', ROOT));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  const info = JSON.parse(readFileSync(new URL('public/models/aircraft/cabin.json', ROOT), 'utf8'));
  return { scene: gltf.scene, info };
}

/** A stand-in for cabin.glb: one box per node, named as the model's. */
function fakeModel() {
  const scene = new Group();
  const root = new Group();
  root.name = 'Cabin';
  scene.add(root);
  for (const name of ['Bay', 'Filler', 'Shade', 'PaneInner', 'PaneMiddle', 'PaneOuter', 'Seat', 'Armrest', 'Bin']) {
    const m = new Mesh(new BoxGeometry(0.1, 0.1, 0.1).translate(1.5, 3.9, 0), new MeshStandardMaterial({ name: name === 'Seat' ? 'Fabric' : 'Trim' }));
    m.name = name;
    root.add(m);
  }
  return { scene, info: { shade: { axis: [-0.2, 0.98, 0], travel: 0.4 } } };
}

describe('cabinLayout()', () => {
  for (const id of ['23F', '23A', '10A', '11F', '16F', '1F', '30A']) {
    it(`closes the window side from end to end without overlaps for ${id}`, () => {
      const s = seat(id), l = cabinLayout(s);
      const spans = [...l.bays.map((b) => [b.station - CABIN.panelHalfLength, b.station + CABIN.panelHalfLength]), ...l.fillers.map((f) => [f.from, f.to])].sort((a, b) => a[0] - b[0]);
      expect(spans[0][0]).toBeCloseTo(s.eyeStation - MODEL_HALF_LENGTH, 9);
      expect(spans.at(-1)[1]).toBeCloseTo(s.eyeStation + MODEL_HALF_LENGTH, 9);
      for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeCloseTo(spans[i - 1][1], 9);
    });
  }

  it('puts a bay on every open window in the run and none on a blank', () => {
    const l = cabinLayout(seat('10A'));
    const open = windowStations('left').filter((w) => !w.blank && w.station - 0.235 >= l.from && w.station + 0.235 <= l.to).map((w) => w.station);
    expect(l.bays.map((b) => b.station)).toEqual(open);
    for (const b of WINDOW.blanksLeft) expect(l.bays.some((x) => Math.abs(x.station - b) < 0.01)).toBe(false);
  });

  it('names the own window: the nearest open one (none of its own for a blank-wall seat... but the next one)', () => {
    expect(cabinLayout(seat('23F')).own).toBe(seat('23F').nearest[0].station);
    const blank = cabinLayout(seat('11F'));
    expect(blank.own).not.toBe(seat('11F').nearest[0].station);
  });

  it('seats three across on the seat side with four armrests a row, mirrored on the left', () => {
    const r = cabinLayout(seat('23F')), l = cabinLayout(seat('23A'));
    expect((r.seats.length + 1) % 3).toBe(0); // every row's three, less the passenger's own
    expect(r.armrests.length).toBe(((r.seats.length + 1) / 3) * 4);
    expect(r.seats.every((s) => s.x > 0) && l.seats.every((s) => s.x < 0)).toBe(true);
    expect(r.seats.some((s) => s.row === 23 && s.letter === 'F')).toBe(false);
    expect(r.seats.some((s) => s.row === 23 && s.letter === 'E')).toBe(true);
    expect(r.seats.some((s) => s.row === 22 && s.letter === 'F')).toBe(true);
  });
});

describe('mirrorGeometryX()', () => {
  it('negates x and keeps each triangle facing the same way relative to its mirrored normal', () => {
    const g = new BoxGeometry(1, 1, 1).translate(2, 0, 0), m = mirrorGeometryX(g);
    const b = new Box3().setFromBufferAttribute(m.getAttribute('position'));
    expect(b.max.x).toBeCloseTo(-1.5, 9);
    // winding: the geometric normal of the first triangle agrees with its vertex normal
    const p = m.getAttribute('position'), n = m.getAttribute('normal'), ix = m.index;
    const a = new Vector3().fromBufferAttribute(p, ix.getX(0)), c1 = new Vector3().fromBufferAttribute(p, ix.getX(1)), c2 = new Vector3().fromBufferAttribute(p, ix.getX(2));
    const face = c1.sub(a).cross(c2.sub(a));
    expect(face.dot(new Vector3().fromBufferAttribute(n, ix.getX(0)))).toBeGreaterThan(0);
  });
});

describe('cabin.glb', () => {
  it('has the window opening of section 6.5 at the skin, within 5 mm, at its centre height, and the bay on its pitch', async () => {
    const { scene } = await realModel();
    const bay = scene.getObjectByName('Bay');
    const pts = [];
    bay.traverse((o) => { if (o.isMesh) { const p = o.geometry.getAttribute('position'); for (let i = 0; i < p.count; i++) pts.push(new Vector3().fromBufferAttribute(p, i)); } });
    const rs = FUSELAGE.width / 2 - 0.002, axis = FUSELAGE.axisY;
    const skin = pts.filter((v) => Math.abs(Math.hypot(v.x, v.y - axis) - rs) < 2e-4);
    const zs = skin.map((v) => v.z), ang = skin.map((v) => Math.atan2(v.y - axis, v.x));
    expect(Math.abs(Math.max(...zs) - Math.min(...zs) - WINDOW.width)).toBeLessThan(0.005);
    expect(Math.abs(rs * (Math.max(...ang) - Math.min(...ang)) - WINDOW.height)).toBeLessThan(0.005);
    const centreY = axis + rs * Math.sin((Math.max(...ang) + Math.min(...ang)) / 2);
    expect(Math.abs(centreY - (FUSELAGE.floorAtWing + WINDOW.centreAboveFloor))).toBeLessThan(0.005);
    const zAll = pts.map((v) => v.z);
    expect(Math.max(...zAll)).toBeCloseTo(CABIN.panelHalfLength, 3);
  });

  it('stays inside its triangle budget and carries the baked attribute on every part', async () => {
    const { scene, info } = await realModel();
    let tris = 0;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      tris += o.geometry.index.count / 3;
      const a = o.geometry.getAttribute('_cabin');
      expect(a, o.name).toBeTruthy();
      expect(a.itemSize).toBe(4);
      for (let i = 0; i < a.count * 4; i++) { expect(a.array[i]).toBeGreaterThanOrEqual(0); expect(a.array[i]).toBeLessThanOrEqual(1); }
    });
    expect(tris).toBeLessThanOrEqual(20000);
    expect(info.triangles).toBe(tris);
    expect(info.shade.travel).toBeCloseTo(CABIN.shadeTravel, 4);
  });
});

describe('buildModelledCabin()', () => {
  it('instances the real model round a right seat, on the cabin layer, inside the fuselage', async () => {
    const c = buildModelledCabin(await realModel(), seat('23F'), { nodes });
    const l = c.layout;
    expect(c.meshes.get('Bay').every((m) => m.count === l.bays.length)).toBe(true);
    expect(c.meshes.get('Filler')[0].count).toBe(l.fillers.length);
    expect(c.meshes.get('Seat').every((m) => m.count === l.seats.length)).toBe(true);
    c.group.traverse((o) => { if (o.isMesh) { expect(o.layers.isEnabled(CABIN_LAYER)).toBe(true); expect(o.layers.isEnabled(0)).toBe(false); } });
    const box = new Box3().setFromObject(c.group);
    expect(box.max.x).toBeLessThan(FUSELAGE.width / 2 + 1e-3);
    expect(box.min.z).toBeGreaterThan(bodyZ(l.from) - 1e-3);
    expect(c.meshes.get('PaneInner')[0].visible).toBe(false);
    expect(c.triangles).toBeGreaterThan(1000);
    expect(c.drawCalls).toBeLessThan(25);
    c.dispose();
  });

  it('mirrors the window side for a left seat', async () => {
    const c = buildModelledCabin(await realModel(), seat('23A'), { nodes });
    const box = new Box3().setFromObject(c.meshes.get('Bay')[0]);
    expect(box.max.x).toBeLessThan(0);
    expect(box.min.x).toBeGreaterThan(-FUSELAGE.width / 2 - 1e-3);
    c.dispose();
  });

  it('slides the own shade round its track about the fuselage axis, up behind the trim', async () => {
    const model = fakeModel();
    model.info.shade.radius = FUSELAGE.trimRadius + 0.004;
    const c = buildModelledCabin(model, seat('23F'), { nodes });
    const mesh = c.meshes.get('Shade')[0], own = c.layout.bays.findIndex((b) => b.station === c.layout.own);
    const m = new Matrix4();
    const centre = (k) => { mesh.getMatrixAt(own, m); return new Vector3(k * Math.cos(0.5), FUSELAGE.axisY + k * Math.sin(0.5), 0).applyMatrix4(m); };
    const r = model.info.shade.radius;
    const open = centre(r);
    // every point of the track stays on its circle, moved up it by the travel
    expect(Math.hypot(open.x, open.y - FUSELAGE.axisY)).toBeCloseTo(r, 6);
    expect(Math.atan2(open.y - FUSELAGE.axisY, open.x) - 0.5).toBeCloseTo(0.4 / r, 6);
    c.setShade(1);
    const shut = centre(r);
    expect(shut.x).toBeCloseTo(r * Math.cos(0.5), 6);
    expect(shut.z).toBeCloseTo(bodyZ(c.layout.own), 6);
    // the left side's goes up its own side
    c.setSeat(seat('23A'));
    const ownL = c.layout.bays.findIndex((b) => b.station === c.layout.own);
    c.meshes.get('Shade')[0].getMatrixAt(ownL, m);
    const p = new Vector3(-r * Math.cos(0.5), FUSELAGE.axisY + r * Math.sin(0.5), 0).applyMatrix4(m);
    expect(Math.atan2(p.y - FUSELAGE.axisY, -p.x) - 0.5).toBeCloseTo(0.4 / r, 6);
    c.dispose();
  });

  it('moves only the own shade, along its track, closed at 1', async () => {
    const model = fakeModel();
    const c = buildModelledCabin(model, seat('23F'), { nodes });
    const mesh = c.meshes.get('Shade')[0], own = c.layout.bays.findIndex((b) => b.station === c.layout.own);
    const at = (i) => new Vector3().setFromMatrixPosition((() => { const m = new Matrix4(); mesh.getMatrixAt(i, m); return m; })());
    const open = at(own);
    expect(open.y).toBeCloseTo(0.98 * 0.4, 6); // open: up its track by the whole travel
    c.setShade(1);
    expect(at(own).y).toBeCloseTo(0, 6);
    expect(at(own).z).toBeCloseTo(bodyZ(c.layout.own), 6);
    c.dispose();
  });

  it('re-places itself round another seat', async () => {
    const c = buildModelledCabin(fakeModel(), seat('23F'), { nodes });
    c.setSeat(seat('9A'));
    expect(c.layout.side).toBe('left');
    expect(c.meshes.get('Bay')[0].count).toBe(c.layout.bays.length);
    c.dispose();
  });

  it('refuses a model without its parts', () => {
    const scene = new Group();
    expect(() => buildModelledCabin({ scene }, seat('23F'), { nodes })).toThrow(/Bay/);
  });
});

describe('createModelledCabin()', () => {
  it('shows the v0 cabin at once and swaps the model in when it has loaded', async () => {
    const c = createModelledCabin({ nodes, seat: defaultSeat(), load: async () => fakeModel() });
    expect(c.model).toBeNull();
    expect(c.group.children[0].name).toBe('cabin');
    const v0 = c.triangles;
    expect(v0).toBeGreaterThan(0);
    await c.ready;
    expect(c.model).toBeTruthy();
    expect(c.group.children).toHaveLength(1);
    expect(c.group.children[0].name).toBe('cabin-model');
    c.dispose();
  });

  it('keeps the v0 cabin when loading fails, and still changes seat', async () => {
    const c = createModelledCabin({ nodes, seat: defaultSeat(), load: async () => { throw new Error('404'); } });
    await c.ready;
    expect(c.model).toBeNull();
    expect(c.error.message).toBe('404');
    c.setSeat(seat('9A'));
    expect(c.seat.id).toBe('9A');
    expect(c.windows.length).toBeGreaterThan(5);
    c.dispose();
  });

  it('slides the shade toward its target with time, at once with reduced motion', async () => {
    const c = createModelledCabin({ nodes, seat: defaultSeat(), load: async () => fakeModel() });
    await c.ready;
    c.toggleShade();
    c.update(null, { dtS: 0.5 });
    expect(c.shade).toBeCloseTo(0.4, 6);
    c.update(null, { dtS: 0.5 });
    expect(c.shade).toBeCloseTo(0.8, 6);
    c.update(null, { reducedMotion: true, dtS: 0.016 });
    expect(c.shade).toBe(1);
    c.toggleShade();
    c.update(null, {});
    expect(c.shade).toBe(0);
    c.update(null, { cabinLight: 0.3, night: true });
    expect(c.model.materials.cabinLight).toBeCloseTo(0.3, 6);
    c.dispose();
  });

  it('disposes a model that arrives after dispose()', async () => {
    let resolve;
    const c = createModelledCabin({ nodes, seat: defaultSeat(), load: () => new Promise((r) => { resolve = r; }) });
    await Promise.resolve(); // the load starts on the next microtask
    c.dispose();
    resolve(fakeModel());
    expect(await c.ready).toBeNull();
    expect(c.model).toBeNull();
  });
});

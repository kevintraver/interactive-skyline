// Plan 03, Phase 5: createWindowPane, the one entry point the session uses. The pane is drawn on the modelled cabin's
// inner-pane quads (one instanced draw over every window of the run), lives inside the cabin's group (so the clean
// view, which hides the cabin, shows no glass), follows a seat change, takes the journey's pane state, and goes away
// completely when disabled or disposed.
import { describe, it, expect } from 'vitest';
import { Group, InstancedMesh, BufferGeometry, Float32BufferAttribute, Matrix4, Vector3, Quaternion } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { createWindowPane } from '../../../src/flight/window/index.js';
import { CABIN_LAYER } from '../../../src/flight/cabin/cabin.js';
import { createFrame } from '../../../src/world/frame.js';
import { parseTrack } from '../../../src/flight/track.js';
import { syntheticArrival } from '../../helpers/flightTrack.js';
import cities from '../../../data/cities.json' with { type: 'json' };

function paneMesh(count) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([1.8, 3.7, -0.14, 1.8, 3.7, 0.14, 1.75, 4.1, 0.14, 1.75, 4.1, -0.14, 1.8, 3.7, -0.14, 1.75, 4.1, 0.14], 3));
  const m = new InstancedMesh(g, new MeshBasicNodeMaterial(), count);
  m.name = 'cabin-PaneInner';
  for (let i = 0; i < count; i++) m.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, i * 0.5));
  m.visible = false;
  return m;
}

/** A cabin shaped like createModelledCabin()'s, with a model that has `count` windows. */
function fakeCabin(count = 4) {
  const group = new Group();
  const modelGroup = new Group();
  group.add(modelGroup);
  let resolve;
  const mats = { cabinLight: 1, set(o) { this.cabinLight = o.cabinLight; } };
  const model = {
    group: modelGroup, info: { panes: { PaneInner: 1.8368, PaneMiddle: 1.851, PaneOuter: 1.868 } }, materials: mats,
    meshes: new Map([['PaneInner', [paneMesh(count)]]]),
    layout: { own: 12.3, sign: 1, bays: Array.from({ length: count }, (_, i) => ({ station: 12.3 + i * 0.5 })) },
  };
  const cabin = {
    group, model: null, seat: { id: '22F', side: 'right' },
    ready: new Promise((r) => { resolve = r; }),
    load() { cabin.model = model; resolve(model); return cabin.ready; },
    setSeat(seat, n) {
      cabin.seat = seat;
      const old = model.meshes.get('PaneInner')[0];
      modelGroup.remove(old);
      const m = paneMesh(n);
      modelGroup.add(m);
      model.meshes.set('PaneInner', [m]);
      model.layout = { ...model.layout, sign: seat.side === 'left' ? -1 : 1, bays: Array.from({ length: n }, (_, i) => ({ station: 10 + i * 0.5 })), own: 10 };
    },
  };
  modelGroup.add(model.meshes.get('PaneInner')[0]);
  return cabin;
}

const noLoad = { loadAsync: () => new Promise(() => {}) };
const level = { quaternion: new Quaternion(), airVelocity: new Vector3(0, 0, 72), tas: 72, altMsl: 1000, position: new Vector3(), t: 0, cabinLight: 1 };

describe('createWindowPane', () => {
  it('draws nothing until the cabin model is in, then one instanced draw over every window, on the cabin layer', async () => {
    const cabin = fakeCabin(4);
    const pane = createWindowPane({ nodes: {}, cabin, quality: 'high', textureLoader: noLoad });
    expect(pane.stats().instances).toBe(0);
    await cabin.load();
    await pane.ready;
    const s = pane.stats();
    expect(s.instances).toBe(4);
    expect(s.drawCalls).toBe(1);
    const mesh = pane.mesh;
    expect(mesh).toBeInstanceOf(InstancedMesh);
    expect(mesh.geometry).toBe(cabin.model.meshes.get('PaneInner')[0].geometry);
    expect(mesh.material).not.toBe(cabin.model.meshes.get('PaneInner')[0].material);
    expect(mesh.layers.isEnabled(CABIN_LAYER)).toBe(true);
    expect(mesh.layers.isEnabled(0)).toBe(false); // picking passes through the glass
    expect(mesh.renderOrder).toBeGreaterThan(1000); // last of the transparent objects
    const m4 = new Matrix4();
    mesh.getMatrixAt(2, m4);
    expect(new Vector3().setFromMatrixPosition(m4).z).toBeCloseTo(1.0, 9);
  });

  it('lives inside the cabin group, so the clean view (which hides the cabin) shows no glass', async () => {
    const cabin = fakeCabin(3);
    const pane = createWindowPane({ nodes: {}, cabin, textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    let o = pane.mesh, inside = false;
    while (o) { if (o === cabin.group) inside = true; o = o.parent; }
    expect(inside).toBe(true);
  });

  it('setEnabled(false) removes the glass from the picture and from the frame cost', async () => {
    const cabin = fakeCabin(3);
    const pane = createWindowPane({ nodes: {}, cabin, textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    pane.setEnabled(false);
    expect(pane.group.visible).toBe(false);
    expect(pane.stats().drawCalls).toBe(0);
    pane.setEnabled(true);
    expect(pane.group.visible).toBe(true);
  });

  it('follows a seat change: the panes of the new run', async () => {
    const cabin = fakeCabin(3);
    const pane = createWindowPane({ nodes: {}, cabin, textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    cabin.setSeat({ id: '9A', side: 'left' }, 5);
    pane.setSeat(cabin.seat);
    expect(pane.stats().instances).toBe(5);
    expect(pane.mesh.geometry).toBe(cabin.model.meshes.get('PaneInner')[0].geometry);
  });

  it('takes the journey: with a track, update() reads the pane state at the state\'s journey time', async () => {
    const frame = createFrame(cities.lv);
    const sy = syntheticArrival();
    const track = parseTrack(sy.header, sy.buffer, { frame });
    const cabin = fakeCabin(2);
    const pane = createWindowPane({ nodes: {}, cabin, textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    pane.setTrack(track);
    const cruise = track.sample(10), low = track.sample(1500);
    pane.update(cruise, { wallS: 1, cabinLight: 1, exposure: 1e-4 });
    expect(pane.stats().pane.frost).toBeGreaterThan(0.3);
    expect(pane.uniforms.frost.value).toBeGreaterThan(0.3);
    pane.update(low, { wallS: 2, cabinLight: 1, exposure: 1e-4 });
    expect(pane.uniforms.frost.value).toBe(0);
  });

  it('a debug override of the pane state wins over the track (the harness, the effects panel)', async () => {
    const cabin = fakeCabin(2);
    const pane = createWindowPane({ nodes: {}, cabin, textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    pane.setOverride({ frost: 0.7, wet: 0.5, rainRateMmH: 6 });
    pane.update(level, { wallS: 3, cabinLight: 0.4, exposure: 1e-4 });
    expect(pane.uniforms.frost.value).toBe(0.7);
    expect(pane.uniforms.wet.value).toBe(0.5);
    expect(pane.uniforms.rain.value).toBe(6);
    pane.setOverride(null);
    pane.update(level, { wallS: 3, cabinLight: 0.4, exposure: 1e-4 });
    expect(pane.uniforms.frost.value).toBe(0);
  });

  it('under reduced motion the drops stand still', async () => {
    const cabin = fakeCabin(2);
    const pane = createWindowPane({ nodes: {}, cabin, textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    pane.update(level, { wallS: 5, reducedMotion: true, exposure: 1e-4 });
    const a = pane.uniforms.timeS.value;
    pane.update(level, { wallS: 50, reducedMotion: true, exposure: 1e-4 });
    expect(pane.uniforms.timeS.value).toBe(a);
    pane.update(level, { wallS: 50, exposure: 1e-4 });
    expect(pane.uniforms.timeS.value).toBe(50);
  });

  it('reports what it costs: draws, triangles, taps per pixel, texture memory', async () => {
    const cabin = fakeCabin(4);
    const pane = createWindowPane({ nodes: {}, cabin, quality: 'low', textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    const s = pane.stats();
    expect(s.level).toBe('low');
    expect(s.taps).toBeLessThanOrEqual(5);
    expect(s.triangles).toBe(4 * 2);
    expect(s.textureBytes).toBeGreaterThanOrEqual(0);
    expect(s.textureBytes).toBeLessThan(16 * 1024 * 1024); // section 9.2: 16 MB on the GPU
  });

  it('dispose() takes the glass out of the cabin and is safe to call twice', async () => {
    const cabin = fakeCabin(2);
    const pane = createWindowPane({ nodes: {}, cabin, textureLoader: noLoad });
    await cabin.load();
    await pane.ready;
    pane.dispose();
    let found = false;
    cabin.group.traverse((o) => { if (o.name === 'window-pane') found = true; });
    expect(found).toBe(false);
    expect(() => pane.dispose()).not.toThrow();
  });
});

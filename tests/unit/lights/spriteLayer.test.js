// The light-sprite layer (src/drive/lights/sprites.js) on the CPU side: what it writes into its instance textures (the
// texel layout of its header), its draw lists and counts, the per-frame values and the reflected twins' lists. What it
// draws is measured on the GPU by tests/manual/lights-probe.mjs; spriteMirror.js holds the arithmetic.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSpriteLayer, setTwins, TWIN_UNIFORMS } from '../../../src/drive/lights/sprites.js';
import { MAX_PATTERNS, ON_TABLE_N, PATTERN } from '../../../src/drive/lights/spriteData.js';
import { ON_TABLE } from '../../../src/drive/lights/switching.js';
import { LUMINAIRE_DIAMETER_M } from '../../../src/drive/lights/lamps.js';

const LAMP = { kDown: 0.62, kUp: 0.04, downShare: 0.96 };
const texel = (layer, t, i) => Array.from(layer.data[t].slice(4 * i, 4 * i + 4));

describe('the layer', () => {
  it('is an additive, depth-tested node material that writes no depth, drawn after the opaque scene', () => {
    const l = createSpriteLayer({ capacity: 8, reflect: true });
    const m = l.mesh.material;
    expect(m.isNodeMaterial).toBe(true);
    expect(m.transparent && !m.depthWrite && m.depthTest).toBe(true);
    expect(l.mesh.renderOrder).toBe(10);
    expect(l.twins.mesh.renderOrder).toBe(9);
    expect(ON_TABLE_N).toBe(ON_TABLE.n);
    l.dispose();
  });

  it('rejects a layer without capacity, an unknown pattern and one pattern too many', () => {
    expect(() => createSpriteLayer({})).toThrow(/capacity/);
    const l = createSpriteLayer({ capacity: 4 });
    expect(() => l.definePattern({ kind: 'spot' })).toThrow(/unknown pattern/);
    for (let i = 1; i < MAX_PATTERNS; i++) l.definePattern({ kind: 'lobe' });
    expect(() => l.definePattern({ kind: 'lobe' })).toThrow(/too many/);
    l.dispose();
  });

  it('writes each instance into the four textures as its header lays them out', () => {
    const l = createSpriteLayer({ capacity: 2100 });
    expect(l.definePattern({ kind: 'isotropic' })).toBe(0);
    const lobe = l.definePattern({ kind: 'lobe', exponent: 3 });
    const cut = l.definePattern({ kind: 'cutoff', ...LAMP });
    expect(l.uniforms.uPatKind.array.slice(0, 3)).toEqual([0, PATTERN.lobe, PATTERN.cutoff]);
    expect(l.uniforms.uPatK.array[cut].toArray()).toEqual([LAMP.kDown, LAMP.kUp, LAMP.downShare]);
    expect(l.uniforms.uPatK.array[lobe].z).toBe(3);
    l.set(0, { position: [1, 2, 3], color: [1, 0.5, 0.25], intensity: 30, pattern: lobe, axis: [0, 0, 1] });
    l.set(1, { position: [-40, 9, -300], intensity: 9000, pattern: cut, aim: 1.2, threshold: 12, warm: 1, mount: 9 });
    l.set(2, { position: [5, 9, -10], intensity: 9000, pattern: cut, aim: NaN, diameter: 0.3 });
    expect(texel(l, 0, 0)).toEqual([1, 2, 3, 30]);
    expect(texel(l, 1, 0)).toEqual([1, 0.5, 0.25, lobe]);
    expect(texel(l, 2, 0)).toEqual([0, 0, 1, expect.any(Number)]);
    expect(texel(l, 2, 0)[3]).toBeLessThan(-9); // no aim: the phi-averaged pattern
    expect(texel(l, 2, 1)[3]).toBeCloseTo(1.2, 6);
    expect(texel(l, 2, 1).slice(0, 3)).toEqual([0, -1, 0]); // the nadir by default
    expect(texel(l, 3, 1)).toEqual([12, 1, expect.any(Number), 9]);
    expect(texel(l, 3, 1)[2]).toBeCloseTo(LUMINAIRE_DIAMETER_M, 6);
    expect(texel(l, 3, 0)[0]).toBeGreaterThan(1e20); // always on
    expect(texel(l, 3, 2)[2]).toBeCloseTo(0.3, 6);
    expect(texel(l, 2, 2)[3]).toBeLessThan(-9);
    l.setPosition(2, 7, 8, 9);
    expect(texel(l, 0, 2).slice(0, 3)).toEqual([7, 8, 9]);
    l.dispose();
  });

  it('draws instances 0..n-1 after commit, a list after setDrawList (dropped by the next commit), and rows after commitRows', () => {
    const l = createSpriteLayer({ capacity: 2100 });
    for (let i = 0; i < 4; i++) l.set(i, { position: [i, 0, 0], intensity: 1 });
    l.commit(4);
    expect(l.drawn).toBe(4);
    const idx = () => Array.from(l.mesh.geometry.getAttribute('spriteIndex').array.slice(0, 4));
    expect(idx()).toEqual([0, 1, 1, 1]);
    l.setDrawList([3, 1], 2, [2, 0.5]);
    expect(l.drawn).toBe(2);
    expect(idx()).toEqual([3, 2, 1, 0.5]);
    l.commit(4);
    expect(idx()).toEqual([0, 1, 1, 1]);
    const d = l.drawIndices; d[0] = 2; d[1] = 3; l.setDrawCount(1);
    expect(l.drawn).toBe(1);
    expect(l.mesh.geometry.instanceCount).toBe(1);
    l.commitRows(1500);
    expect(l.drawn).toBe(1500);
    l.dispose();
  });

  it('takes the per-frame values', () => {
    const l = createSpriteLayer({ capacity: 4 });
    l.setFrame({ ambientLux: 7, visibility: 9000, glowRange: [100, 200], groundAlbedo: 0.3, onTable: [1, NaN, 3],
      sodium: { startUv: [0.1, 0.2], steadyUv: [0.3, 0.4] } });
    expect(l.uniforms.uAmbient.value).toBe(7);
    expect(l.uniforms.uVisibility.value).toBe(9000);
    expect(l.uniforms.uGlowRange.value.toArray()).toEqual([100, 200]);
    expect(l.uniforms.uGroundAlbedo.value).toBe(0.3);
    expect(l.uniforms.uOnTable.array.slice(0, 3)).toEqual([1, -1, 3]);
    expect(l.uniforms.uSodium.value.toArray()).toEqual([0.1, 0.2, 0.3, 0.4]);
    l.dispose();
  });

  it('imports no classic renderer and none of the CPU mirrors', () => {
    for (const f of ['sprites.js', 'surfaceLight.js', 'photometry.js', 'spriteData.js']) {
      const src = readFileSync(new URL(`../../../src/drive/lights/${f}`, import.meta.url), 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/spriteMirror|headlampMirror/);
      expect(src, f).not.toMatch(/onBeforeCompile|ShaderMaterial|gl_FragColor/);
    }
  });
});

describe('reflected twins', () => {
  it('lists the instances near the car while wet (written-once and per-frame layers alike) and hides them when dry', () => {
    const once = createSpriteLayer({ capacity: 64, reflect: true }), frame = createSpriteLayer({ capacity: 64, reflect: true });
    for (const l of [once, frame]) {
      for (let i = 0; i < 40; i++) l.set(i, { position: [(i % 8) * 90 - 300, 9, -Math.floor(i / 8) * 120], intensity: i % 5 ? 1000 : 0 });
    }
    once.commit(40);
    frame.commitRows(40);
    setTwins({ wet: 0.7, slope: 0.08, car: { x: 10, z: -50 }, forward: { x: 0, z: -2 }, roadY: 1, grade: 0.01, halfWidth: 15, range: 250 });
    frame.commitRows(40); // a per-frame layer lists its twins as it commits
    expect(TWIN_UNIFORMS.uTwinWet.value).toBe(0.7);
    expect(TWIN_UNIFORMS.uTwinRoad.value.toArray()).toEqual([10, -50, 0, -1]);
    expect(TWIN_UNIFORMS.uTwinPlane.value.toArray()).toEqual([1, 0.01, 15, 250]);
    const list = (l) => Array.from(l.twins.mesh.geometry.getAttribute('spriteIndex').array.slice(0, 2 * l.twins.listed));
    for (const l of [once, frame]) {
      expect(l.twins.listed).toBeGreaterThan(0);
      expect(l.twins.listed).toBeLessThan(40);
      const idx = list(l).filter((_, k) => k % 2 === 0);
      expect(idx.every((i) => i % 5 !== 0)).toBe(true); // dark instances have no twin
    }
    const listed = (l) => list(l).filter((_, k) => k % 2 === 0).sort((x, y) => x - y);
    expect(listed(frame)).toEqual(listed(once)); // the same instances, each in its own order
    setTwins({ wet: 0 });
    for (const l of [once, frame]) {
      expect(l.twins.mesh.visible).toBe(false);
      expect(l.twins.listed).toBe(0);
      l.dispose();
    }
  });
});

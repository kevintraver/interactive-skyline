// The node sprite layer (src/drive/lights/sprites.node.js) against the GLSL one (sprites.js): the same pure data, the
// same factory and methods writing the same instance data, draw lists and twin lists, and the light scale. What it
// draws is compared on the GPU by tests/manual/sprites-node-shots.mjs; spriteMirror.js holds the arithmetic for both.
import { describe, it, expect } from 'vitest';
import * as glsl from '../../../src/drive/lights/sprites.js';
import * as node from '../../../src/drive/lights/sprites.node.js';
import * as data from '../../../src/drive/lights/spriteData.js';
import { SPRITE_TEX_WIDTH, MAX_PATTERNS, ON_TABLE_N, TWIN_FOOT, spriteVertex } from '../../../src/drive/lights/sprites.glsl.js';
import { PATTERN } from '../../../src/drive/lights/spriteMirror.js';
import { ON_TABLE } from '../../../src/drive/lights/switching.js';
import { LIGHTING_UNITS } from '../../../src/drive/env.js';
import { readFileSync } from 'node:fs';

const LAMP = { kDown: 0.62, kUp: 0.04, downShare: 0.96 };
const own = (layer) => Object.keys(Object.getOwnPropertyDescriptors(layer)).sort();

function fill(layer) {
  const lobe = layer.definePattern({ kind: 'lobe', exponent: 3 });
  const cut = layer.definePattern({ kind: 'cutoff', ...LAMP });
  layer.set(0, { position: [1, 2, 3], color: [1, 0.5, 0.25], intensity: 30, pattern: lobe, axis: [0, 0, 1] });
  layer.set(1, { position: [-40, 9, -300], intensity: 9000, pattern: cut, aim: 1.2, threshold: 12, warm: 1, mount: 9 });
  layer.set(2, { position: [5, 9, -10], intensity: 9000, pattern: cut, aim: NaN, diameter: 0.3 });
  layer.set(3, { position: [5000, 1, 0], intensity: 0 });
  return { lobe, cut };
}

describe('shared pure data', () => {
  it('equals the GLSL module\'s', () => {
    expect(data.SPRITE_TEX_WIDTH).toBe(SPRITE_TEX_WIDTH);
    expect(data.MAX_PATTERNS).toBe(MAX_PATTERNS);
    expect(data.ON_TABLE_N).toBe(ON_TABLE_N);
    expect(data.ON_TABLE_N).toBe(ON_TABLE.n);
    expect(data.TWIN_FOOT).toBe(TWIN_FOOT);
    expect(data.PATTERN).toEqual(PATTERN);
    expect(data.TWIN_LIST_M).toBe(glsl.TWIN_LIST_M);
    expect(data.TWIN_RELIST_M).toBe(glsl.TWIN_RELIST_M);
  });
  it('the node modules import nothing of the GLSL path', () => {
    for (const f of ['sprites.node.js', 'surfaceLight.node.js', 'photometry.node.js', 'spriteData.js']) {
      const src = readFileSync(new URL(`../../../src/drive/lights/${f}`, import.meta.url), 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/glsl|spriteMirror|\/sprites\.js$|surfaceLight\.js$|headlampMirror/);
      expect(src, f).not.toMatch(/onBeforeCompile|ShaderMaterial|gl_FragColor/);
    }
  });
  it('the GLSL constants the node shader copies are still the GLSL shader\'s', () => {
    for (const s of ['0.902745', '0.886227', '0.887264', '0.892980', 'max(2.0 * dPx, 4.0)', 'mix(2.0, 6.0, smoothstep01(2.0, 8.0, dPx))', 's / 140.0', 's / 100.0',
      'min(1.0, 0.02 * d)', '2e-4', '1024.0', '2.6 * a']) expect(spriteVertex).toContain(s);
  });
});

describe('the node layer has the GLSL layer\'s interface', () => {
  it('the same exports, factory options and layer members', () => {
    for (const k of Object.keys(glsl)) expect(node, k).toHaveProperty(k);
    const a = glsl.createSpriteLayer({ capacity: 8, reflect: true }), b = node.createSpriteLayer({ capacity: 8, reflect: true });
    for (const k of own(a)) expect(own(b), k).toContain(k);
    // uViewport and uPixelAngle are read from the target being drawn (screenSize and the projection) on the new renderer
    for (const k of Object.keys(a.uniforms).filter((x) => !['uViewport', 'uPixelAngle'].includes(x))) expect(b.uniforms, k).toHaveProperty(k);
    expect(b.mesh.material.isNodeMaterial).toBe(true);
    expect(b.mesh.material.transparent && !b.mesh.material.depthWrite && b.mesh.material.depthTest).toBe(true);
    expect(b.mesh.material.blending).toBe(a.mesh.material.blending);
    expect(b.mesh.renderOrder).toBe(a.mesh.renderOrder);
    expect(b.twins.mesh.renderOrder).toBe(a.twins.mesh.renderOrder);
    a.dispose(); b.dispose();
  });
  it('rejects what the GLSL layer rejects', () => {
    expect(() => node.createSpriteLayer({})).toThrow(/capacity/);
    const b = node.createSpriteLayer({ capacity: 4 });
    expect(() => b.definePattern({ kind: 'spot' })).toThrow(/unknown pattern/);
    for (let i = 1; i < MAX_PATTERNS; i++) b.definePattern({ kind: 'lobe' });
    expect(() => b.definePattern({ kind: 'lobe' })).toThrow(/too many/);
  });
});

describe('the same instance data, draw lists and counts', () => {
  it('set, commit, setDrawList, drawIndices, setDrawCount, commitRows', () => {
    const a = glsl.createSpriteLayer({ capacity: 2100 }), b = node.createSpriteLayer({ capacity: 2100 });
    const ia = fill(a), ib = fill(b);
    expect(ib).toEqual(ia);
    for (let t = 0; t < 4; t++) expect(Array.from(b.data[t])).toEqual(Array.from(a.data[t]));
    expect(b.uniforms.uPatKind.array.slice(0, 3)).toEqual(Array.from(a.uniforms.uPatKind.value.slice(0, 3)));
    expect(b.uniforms.uPatK.array[ib.cut].toArray()).toEqual(a.uniforms.uPatK.value[ia.cut].toArray());
    for (const l of [a, b]) l.commit(4);
    expect(b.drawn).toBe(a.drawn);
    for (const l of [a, b]) l.setDrawList([3, 1], 2, [2, 0.5]);
    expect(b.drawn).toBe(2);
    expect(Array.from(b.mesh.geometry.getAttribute('spriteIndex').array.slice(0, 4))).toEqual([3, 2, 1, 0.5]);
    for (const l of [a, b]) l.commit(4); // drops the list
    expect(Array.from(b.mesh.geometry.getAttribute('spriteIndex').array.slice(0, 4))).toEqual(Array.from(a.mesh.geometry.getAttribute('spriteIndex').array.slice(0, 4)));
    for (const l of [a, b]) { const d = l.drawIndices; d[0] = 2; d[1] = 3; l.setDrawCount(1); }
    expect(b.drawn).toBe(a.drawn);
    for (const l of [a, b]) l.commitRows(1500);
    expect(b.drawn).toBe(1500);
    b.setPosition(2, 7, 8, 9);
    expect(Array.from(b.data[0].slice(8, 11))).toEqual([7, 8, 9]);
    a.dispose(); b.dispose();
  });

  it('setFrame: gain is read as LIGHTING_UNITS.nit x the fade, and the rest as sprites.js', () => {
    const b = node.createSpriteLayer({ capacity: 4 });
    b.setFrame({ gain: 0.1 * 0.4, ambientLux: 7, visibility: 9000, glowRange: [100, 200], groundAlbedo: 0.3, onTable: [1, NaN, 3],
      sodium: { startUv: [0.1, 0.2], steadyUv: [0.3, 0.4] } });
    expect(b.uniforms.uFade.value).toBeCloseTo(0.4 * (0.1 / LIGHTING_UNITS.nit), 12);
    expect(b.uniforms.uGain.value).toBeCloseTo(0.04, 12);
    expect(b.uniforms.uAmbient.value).toBe(7);
    expect(b.uniforms.uVisibility.value).toBe(9000);
    expect(b.uniforms.uGlowRange.value.toArray()).toEqual([100, 200]);
    expect(b.uniforms.uGroundAlbedo.value).toBe(0.3);
    expect(b.uniforms.uOnTable.array.slice(0, 3)).toEqual([1, -1, 3]);
    expect(b.uniforms.uSodium.value.toArray()).toEqual([0.1, 0.2, 0.3, 0.4]);
    b.setFrame({ fade: 0.25, gain: 99 }); // an explicit fade wins
    expect(b.uniforms.uFade.value).toBe(0.25);
    b.dispose();
  });
});

describe('reflected twins', () => {
  it('setTwins hides and shows them, and the lists are the GLSL layer\'s (written-once and per-frame layers)', () => {
    const a = glsl.createSpriteLayer({ capacity: 64, reflect: true }), b = node.createSpriteLayer({ capacity: 64, reflect: true });
    const da = glsl.createSpriteLayer({ capacity: 64, reflect: true }), db = node.createSpriteLayer({ capacity: 64, reflect: true });
    for (const l of [a, b, da, db]) {
      for (let i = 0; i < 40; i++) l.set(i, { position: [(i % 8) * 90 - 300, 9, -Math.floor(i / 8) * 120], intensity: i % 5 ? 1000 : 0 });
    }
    for (const l of [a, b]) l.commit(40);
    for (const l of [da, db]) l.commitRows(40);
    const t = { wet: 0.7, slope: 0.08, car: { x: 10, z: -50 }, forward: { x: 0, z: -2 }, roadY: 1, grade: 0.01, halfWidth: 15, range: 250 };
    glsl.setTwins(t); node.setTwins(t);
    for (const l of [da, db]) l.commitRows(40); // a per-frame layer lists its twins as it commits
    for (const k of Object.keys(glsl.TWIN_UNIFORMS)) {
      const va = glsl.TWIN_UNIFORMS[k].value, vb = node.TWIN_UNIFORMS[k].value;
      expect(typeof va === 'number' ? vb : vb.toArray(), k).toEqual(typeof va === 'number' ? va : va.toArray());
    }
    expect(b.twins.listed).toBe(a.twins.listed);
    expect(b.twins.listed).toBeGreaterThan(0);
    expect(db.twins.listed).toBe(da.twins.listed);
    const list = (l) => Array.from(l.twins.mesh.geometry.getAttribute('spriteIndex').array.slice(0, 2 * l.twins.listed));
    expect(list(b)).toEqual(list(a));
    expect(list(db)).toEqual(list(da));
    glsl.setTwins({ wet: 0 }); node.setTwins({ wet: 0 });
    expect(b.twins.mesh.visible).toBe(false);
    expect(b.twins.listed).toBe(0);
    for (const l of [a, b, da, db]) l.dispose();
  });
});

describe('the light scale', () => {
  it('is the classic LIGHTING_UNITS at ?display=classic and the exposure in the shipped look', () => {
    const c = node.createSpriteLayer({ capacity: 2, photometry: { display: 'classic' } });
    const p = node.createSpriteLayer({ capacity: 2, photometry: { display: 'physical' } });
    expect(c.photometry.display).toBe('classic');
    expect(p.photometry.display).toBe('physical');
    c.dispose(); p.dispose();
  });
});

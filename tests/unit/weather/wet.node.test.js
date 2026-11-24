// The wet road on plan 01's renderer (src/drive/weather/wetRoad.node.js, wet.node.js): the same rules as the GLSL term
// (wetMirror.js, tests in wet.test.js) as a `filter` term of surfaceLight.node.js on node materials. Here: it is put on
// at wetness 0 from the start (no recompile at the first rain) and kept last, one term object per kind so all road
// materials share a program, the uniforms carry the same numbers as wetRoad.js's, and dry it skips its whole block.
// What it draws is compared with the GLSL term on the GPU by tests/manual/drive-parity.mjs and rain-node-probe.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { float } from 'three/tsl';
import * as THREE from 'three';
import { createWetRoad as createNodeWet, TERM_ID } from '../../../src/drive/weather/wetRoad.node.js';
import { createWetRoad as createGlslWet } from '../../../src/drive/weather/wetRoad.js';
import { wetTerm } from '../../../src/drive/weather/wet.node.js';
import { addSurfaceTerm, surfaceTerms } from '../../../src/drive/lights/surfaceLight.node.js';

const vec = (v) => (v.isVector4 ? v.toArray() : v.isVector2 ? v.toArray() : v.isColor ? v.toArray() : v);

describe('the wet term on node materials', () => {
  it('is on at wetness 0 from prepare(), kept last, and gone with dispose (the material as it was)', () => {
    const road = new MeshLambertNodeMaterial(), near = new MeshLambertNodeMaterial(), ground = new MeshLambertNodeMaterial();
    const key0 = ground.customProgramCacheKey();
    addSurfaceTerm(road, { id: 'lampPools', lux: () => float(1) });
    const wet = createNodeWet({ road: [road, near], ground: [ground] });
    expect(wet.attached).toBe(0);
    wet.prepare();
    expect(wet.attached).toBe(3);
    expect(surfaceTerms(road)).toEqual(['lampPools', TERM_ID]);
    expect(surfaceTerms(ground)).toEqual([TERM_ID]);
    addSurfaceTerm(road, { id: 'beam', lux: () => float(2) });
    wet.tick();
    expect(surfaceTerms(road)).toEqual(['lampPools', 'beam', TERM_ID]);
    const late = new MeshLambertNodeMaterial();
    wet.add(late, 'ground');
    expect(surfaceTerms(late)).toEqual([TERM_ID]);
    wet.dispose();
    expect(surfaceTerms(ground)).toEqual([]);
    expect(ground.customProgramCacheKey()).toBe(key0);
    expect(surfaceTerms(road)).toEqual(['lampPools', 'beam']);
  });

  it('shares one program per kind: one term object for every road material, another for the ground', () => {
    const a = new MeshLambertNodeMaterial(), b = new MeshLambertNodeMaterial(), g = new MeshLambertNodeMaterial();
    const wet = createNodeWet({ road: [a, b], ground: [g] });
    wet.prepare();
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(a.customProgramCacheKey()).not.toBe(g.customProgramCacheKey());
    wet.dispose();
  });

  it('carries the GLSL term\'s numbers in its uniforms, and sets wetness and the sky like it', () => {
    const glsl = createGlslWet({ road: [new THREE.MeshLambertMaterial()], ground: [] });
    const node = createNodeWet({ road: [new MeshLambertNodeMaterial()], ground: [] });
    for (const k of ['uWetLanes', 'uWetPath', 'uWetDirt', 'uWetRoad', 'uWetGround']) expect(vec(node.uniforms[k].value)).toEqual(vec(glsl.uniforms[k].value));
    node.set({ wetness: 0.7, sky: new THREE.Color(1, 2, 3) });
    expect(node.uniforms.uWetRoad.value.x).toBe(0.7);
    expect(node.uniforms.uWetGround.value.x).toBe(0.7);
    expect(node.uniforms.uWetSky.value.toArray()).toEqual([1, 2, 3]);
    node.set({ wetness: 3 });
    expect(node.uniforms.uWetRoad.value.x).toBe(1);
    node.set({ wetness: -1 });
    expect(node.uniforms.uWetRoad.value.x).toBe(0);
    node.dispose(); glsl.dispose();
  });

  it('builds a filter whose whole block sits behind a branch on the wetness, and imports nothing of the GLSL path', () => {
    const t = wetTerm('road', { uWet: { value: null } });
    expect(t.id).toBe(TERM_ID);
    expect(typeof t.filter).toBe('function');
    for (const f of ['wet.node.js', 'wetRoad.node.js', 'rain.node.js', 'spray.node.js']) {
      const src = readFileSync(new URL(`../../../src/drive/weather/${f}`, import.meta.url), 'utf8');
      const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n');
      expect(imports).not.toMatch(/glsl|surfaceLight\.js'|sprites\.js'|'\.\/(wet|rain|spray|wetRoad)\.js'/);
      expect(src).not.toMatch(/onBeforeCompile|new THREE\.ShaderMaterial|gl_FragColor/);
    }
    const src = readFileSync(new URL('../../../src/drive/weather/wet.node.js', import.meta.url), 'utf8');
    expect(src).toMatch(/If\(\s*U\.uWet\.x\.greaterThan\(0\)/);
  });
});

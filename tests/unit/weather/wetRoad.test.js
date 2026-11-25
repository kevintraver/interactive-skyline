// The wet road (src/drive/weather/wetRoad.js, wet.js): the rules of wetMirror.js (tests in wet.test.js) as a `filter`
// term of surfaceLight.js on node materials. Here: it is put on at wetness 0 from the start (no recompile at the first
// rain) and kept last, one term object per kind so all road materials share a program, the uniforms carry the rules'
// numbers, and dry it skips its whole block. What it draws is measured on the GPU by tests/manual/rain-probe.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { float } from 'three/tsl';
import * as THREE from 'three';
import { createWetRoad, TERM_ID } from '../../../src/drive/weather/wetRoad.js';
import { WET_DIFFUSE, WET_RETRO, GLOSS, GROUND_DIFFUSE } from '../../../src/drive/weather/wetMirror.js';
import { wetTerm } from '../../../src/drive/weather/wet.js';
import { addSurfaceTerm, surfaceTerms } from '../../../src/drive/lights/surfaceLight.js';

const vec = (v) => (v.isVector4 ? v.toArray() : v.isVector2 ? v.toArray() : v.isColor ? v.toArray() : v);

describe('the wet term on node materials', () => {
  it('is on at wetness 0 from prepare(), kept last, and gone with dispose (the material as it was)', () => {
    const road = new MeshLambertNodeMaterial(), near = new MeshLambertNodeMaterial(), ground = new MeshLambertNodeMaterial();
    const key0 = ground.customProgramCacheKey();
    addSurfaceTerm(road, { id: 'lampPools', lux: () => float(1) });
    const wet = createWetRoad({ road: [road, near], ground: [ground] });
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
    const wet = createWetRoad({ road: [a, b], ground: [g] });
    wet.prepare();
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(a.customProgramCacheKey()).not.toBe(g.customProgramCacheKey());
    wet.dispose();
  });

  it('carries the rules\' numbers in its uniforms, and sets wetness and the sky', () => {
    const node = createWetRoad({ road: [new MeshLambertNodeMaterial()], ground: [] });
    const all = ['uWetLanes', 'uWetPath', 'uWetDirt', 'uWetRoad', 'uWetGround'].flatMap((k) => vec(node.uniforms[k].value));
    for (const v of [WET_DIFFUSE, WET_RETRO, GROUND_DIFFUSE]) expect(all.some((x) => Math.abs(x - v) < 1e-6), String(v)).toBe(true);
    expect(GLOSS.road).toBeGreaterThan(0);
    node.set({ wetness: 0.7, sky: new THREE.Color(1, 2, 3) });
    expect(node.uniforms.uWetRoad.value.x).toBe(0.7);
    expect(node.uniforms.uWetGround.value.x).toBe(0.7);
    expect(node.uniforms.uWetSky.value.toArray()).toEqual([1, 2, 3]);
    node.set({ wetness: 3 });
    expect(node.uniforms.uWetRoad.value.x).toBe(1);
    node.set({ wetness: -1 });
    expect(node.uniforms.uWetRoad.value.x).toBe(0);
    node.dispose();
  });

  it('builds a filter whose whole block sits behind a branch on the wetness, and has no classic shader code', () => {
    const t = wetTerm('road', { uWet: { value: null } });
    expect(t.id).toBe(TERM_ID);
    expect(typeof t.filter).toBe('function');
    for (const f of ['wet.js', 'wetRoad.js', 'rain.js', 'spray.js']) {
      const src = readFileSync(new URL(`../../../src/drive/weather/${f}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/onBeforeCompile|new THREE\.ShaderMaterial|gl_FragColor/);
    }
    const src = readFileSync(new URL('../../../src/drive/weather/wet.js', import.meta.url), 'utf8');
    expect(src).toMatch(/If\(\s*U\.uWet\.x\.greaterThan\(0\)/);
  });
});

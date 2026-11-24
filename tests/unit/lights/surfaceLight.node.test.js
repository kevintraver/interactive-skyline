// surfaceLight.node.js: terms added, replaced and removed on node materials, each material restored exactly by the last
// removal, and the program cache key following the terms. What the terms draw is compared with surfaceLight.js on the
// GPU by tests/manual/sprites-node-shots.mjs (surface-lambert, surface-standard, building-term).
import { describe, it, expect } from 'vitest';
import { MeshLambertNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { MeshLambertMaterial } from 'three';
import { uniform, float, vec3, dot, max } from 'three/tsl';
import { addSurfaceTerm, removeSurfaceTerm, surfaceTerms } from '../../../src/drive/lights/surfaceLight.node.js';
import { createBuildingMaterial } from '../../../src/render/materials/buildingMaterial.js';

const lux = (v) => () => float(v);
const own = (m, k) => Object.prototype.hasOwnProperty.call(m, k);

describe('adding and removing terms', () => {
  it('keeps the order, replaces an id in place, and the last removal restores the material', () => {
    const m = new MeshLambertNodeMaterial();
    const v0 = m.version, key0 = m.customProgramCacheKey();
    const off = addSurfaceTerm(m, { id: 'pools', lux: lux(10) });
    addSurfaceTerm(m, { id: 'retro', radiance: ({ normalWorld, viewWorld }) => max(dot(normalWorld, viewWorld), 0) });
    addSurfaceTerm(m, { id: 'wet', filter: (s, acc) => ({ lux: acc.lux.mul(0.5), radiance: acc.radiance, diffuse: 0.8 }) });
    expect(surfaceTerms(m)).toEqual(['pools', 'retro', 'wet']);
    expect(m.version).toBeGreaterThan(v0);
    addSurfaceTerm(m, { id: 'pools', key: 'v2', lux: lux(20) });
    expect(surfaceTerms(m)).toEqual(['pools', 'retro', 'wet']);
    expect(own(m, 'setupLightingModel') && own(m, 'customProgramCacheKey')).toBe(true);
    expect(m.customProgramCacheKey()).not.toBe(key0);
    off();
    removeSurfaceTerm(m, 'wet');
    expect(surfaceTerms(m)).toEqual(['retro']);
    removeSurfaceTerm(m, 'retro');
    expect(surfaceTerms(m)).toEqual([]);
    expect(own(m, 'setupLightingModel') || own(m, 'customProgramCacheKey')).toBe(false);
    expect(m.customProgramCacheKey()).toBe(key0);
    removeSurfaceTerm(m, 'nothing'); // harmless
  });

  it('puts back a material\'s own hooks and leaves its nodes alone (plan 01\'s building material)', () => {
    const m = createBuildingMaterial({ variant: 'landmark' });
    const emissive = m.emissiveNode, factor = m.diffuseFactorNode;
    const ownModel = () => null, ownKey = () => 'mine';
    const plain = new MeshStandardNodeMaterial();
    plain.setupLightingModel = ownModel;
    plain.customProgramCacheKey = ownKey;
    for (const mat of [m, plain]) addSurfaceTerm(mat, { id: 'beam', lux: lux(5) });
    expect(m.emissiveNode).toBe(emissive);
    expect(m.diffuseFactorNode).toBe(factor);
    expect(plain.customProgramCacheKey()).toMatch(/^mine\|sl:beam@/);
    for (const mat of [m, plain]) removeSurfaceTerm(mat, 'beam');
    expect(plain.setupLightingModel).toBe(ownModel);
    expect(plain.customProgramCacheKey).toBe(ownKey);
    expect(own(m, 'setupLightingModel')).toBe(false);
    expect(m.emissiveNode).toBe(emissive);
  });

  it('wraps the material\'s lighting model, which then runs the terms after its own lights', () => {
    const m = new MeshLambertNodeMaterial();
    const base = Object.getPrototypeOf(m).setupLightingModel.call(m);
    addSurfaceTerm(m, { id: 'a', lux: lux(1) });
    const wrapped = m.setupLightingModel({});
    expect(wrapped).toBeInstanceOf(base.constructor);
    expect(Object.getPrototypeOf(wrapped)).toBeInstanceOf(base.constructor); // the model the material made, inherited
    expect(own(wrapped, 'start')).toBe(true);
    expect(wrapped.direct).toBe(base.direct);
  });

  it('keys the program on the term\'s nodes: one term object shares a program, other uniforms do not', () => {
    const term = (u) => ({ id: 'pool', key: 'v1', lux: () => vec3(u) });
    const a = new MeshLambertNodeMaterial(), b = new MeshLambertNodeMaterial();
    addSurfaceTerm(a, term(uniform(1)));
    addSurfaceTerm(b, term(uniform(1)));
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
    // one term object on many materials: its nodes are built once, and the materials share one program
    const one = term(uniform(2));
    const c = new MeshLambertNodeMaterial(), d = new MeshLambertNodeMaterial();
    addSurfaceTerm(c, one);
    addSurfaceTerm(d, one);
    expect(c.customProgramCacheKey()).toBe(d.customProgramCacheKey());
    expect(c.customProgramCacheKey()).toBe(new MeshLambertNodeMaterial().customProgramCacheKey() + c.customProgramCacheKey().slice(c.customProgramCacheKey().indexOf('|sl:')));
  });

  it('refuses a classic material and a term without light', () => {
    expect(() => addSurfaceTerm(new MeshLambertMaterial(), { id: 'x', lux: lux(1) })).toThrow(/node material/);
    expect(() => addSurfaceTerm(new MeshLambertNodeMaterial(), { id: 'x' })).toThrow(/term/);
  });
});

// T2.1: the backend choice of plan 01, section 7.1, in this order: ?backend=webgl|webgpu; no navigator.gpu ->
// WebGL2, decided synchronously; requestAdapter() null or a fallback (software) adapter -> WebGL2; else WebGPU.
// ?renderer=legacy keeps the classic WebGLRenderer until phase 3.
import { describe, it, expect } from 'vitest';
import { readParams, chooseBackend } from '../../../src/render/renderer.js';

const gpu = (adapter) => ({ gpu: { requestAdapter: async () => adapter } });

describe('readParams', () => {
  it('defaults to the new renderer and an automatic backend', () => {
    expect(readParams('')).toEqual({ renderer: 'webgpu', backend: 'auto' });
  });
  it('reads ?renderer=legacy and ?backend=', () => {
    expect(readParams('?renderer=legacy').renderer).toBe('legacy');
    expect(readParams('?backend=webgl').backend).toBe('webgl');
    expect(readParams('?backend=webgpu').backend).toBe('webgpu');
    expect(readParams('?backend=nonsense').backend).toBe('auto');
  });
});

describe('chooseBackend', () => {
  it('?backend=webgl is decided synchronously, without asking for an adapter', () => {
    const asked = [];
    const nav = { gpu: { requestAdapter: () => { asked.push(1); return Promise.resolve({}); } } };
    const r = chooseBackend({ backend: 'webgl' }, nav);
    expect(r).toEqual({ backend: 'webgl2', reason: '?backend=webgl' });
    expect(asked).toEqual([]);
  });
  it('no navigator.gpu: WebGL2, synchronously', () => {
    expect(chooseBackend({ backend: 'auto' }, {})).toEqual({ backend: 'webgl2', reason: 'no navigator.gpu' });
  });
  it('a null adapter: WebGL2', async () => {
    expect(await chooseBackend({ backend: 'auto' }, gpu(null))).toEqual({ backend: 'webgl2', reason: 'no WebGPU adapter' });
  });
  it('a fallback (software) adapter: WebGL2, unless WebGPU is forced', async () => {
    const soft = { isFallbackAdapter: true, info: { architecture: 'swiftshader' } };
    expect((await chooseBackend({ backend: 'auto' }, gpu(soft))).backend).toBe('webgl2');
    const soft2 = { info: { isFallbackAdapter: true } };
    expect((await chooseBackend({ backend: 'auto' }, gpu(soft2))).reason).toBe('software WebGPU adapter');
    expect((await chooseBackend({ backend: 'webgpu' }, gpu(soft))).backend).toBe('webgpu');
  });
  it('a hardware adapter: WebGPU', async () => {
    expect(await chooseBackend({ backend: 'auto' }, gpu({ info: { vendor: 'apple' } }))).toEqual({ backend: 'webgpu', reason: 'hardware adapter' });
  });
  it('?backend=webgpu with no WebGPU at all still falls back to WebGL2', async () => {
    expect(chooseBackend({ backend: 'webgpu' }, {})).toEqual({ backend: 'webgl2', reason: 'no navigator.gpu' });
    expect((await chooseBackend({ backend: 'webgpu' }, gpu(null))).backend).toBe('webgl2');
  });
  it('requestAdapter throwing: WebGL2', async () => {
    const nav = { gpu: { requestAdapter: async () => { throw new Error('blocked'); } } };
    expect((await chooseBackend({ backend: 'auto' }, nav)).backend).toBe('webgl2');
  });
});

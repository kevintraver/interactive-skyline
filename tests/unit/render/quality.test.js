// T2.7: quality presets (plan 01, section 7.14): the decision table on recorded adapter strings, Ultra refused on
// the WebGL2 backend, and the governor's hysteresis on synthetic frame times.
import { describe, it, expect } from 'vitest';
import { detectLevel, allowed, createGovernor, createQuality, PROFILES } from '../../../src/render/quality.js';

// renderer strings as browsers report them (WEBGL_debug_renderer_info, or WebGPU adapter info joined)
const SAMPLES = [
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)', 'webgl2', 'high'],
  ['apple metal-3 Apple M4', 'webgpu', 'high'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)', 'webgpu', 'ultra'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)', 'webgl2', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'webgpu', 'ultra'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)', 'webgpu', 'high'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'webgl2', 'low'],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)', 'webgl2', 'low'],
  ['google swiftshader', 'webgpu', 'low'],
  ['Mali-G78', 'webgl2', 'low'],
];

describe('detectLevel', () => {
  for (const [gpu, backend, level] of SAMPLES) {
    it(`${gpu} on ${backend}: ${level}`, () => {
      expect(detectLevel({ backend, gpu, cores: 10, deviceMemory: 8 }).level).toBe(level);
    });
  }
  it('a phone, few cores or little memory: Low', () => {
    expect(detectLevel({ backend: 'webgpu', gpu: 'apple metal-3 Apple M4', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)' }).level).toBe('low');
    expect(detectLevel({ backend: 'webgpu', gpu: 'nvidia geforce rtx 4080', cores: 4 }).level).toBe('low');
    expect(detectLevel({ backend: 'webgpu', gpu: 'nvidia geforce rtx 4080', deviceMemory: 4 }).level).toBe('low');
  });
  it('a slow fill-rate benchmark drops a tier', () => {
    expect(detectLevel({ backend: 'webgpu', gpu: 'nvidia geforce gtx 1060', cores: 8, fillRateMs: 20 }).level).toBe('low');
    expect(detectLevel({ backend: 'webgpu', gpu: 'nvidia geforce gtx 1060', cores: 8, fillRateMs: 2 }).level).toBe('high');
  });
});

describe('the user choice', () => {
  it('Ultra on the WebGL2 backend is refused with an explanation', () => {
    expect(allowed('ultra', 'webgl2').ok).toBe(false);
    expect(allowed('ultra', 'webgl2').reason).toMatch(/WebGPU/);
    const applied = [];
    const q = createQuality({ backend: 'webgl2', detected: { level: 'high', reasons: [] }, apply: (p) => applied.push(p.level) });
    expect(q.set('ultra').ok).toBe(false);
    expect(q.level).toBe('high');
    expect(q.message).toMatch(/WebGPU/);
    expect(q.set('low').ok).toBe(true);
    expect(q.level).toBe('low');
    expect(q.set('auto').ok).toBe(true);
    expect(q.level).toBe('high');
    expect(applied).toEqual(['high', 'low', 'high']);
    expect(q.profile).toBe(PROFILES.high);
  });
});

describe('the governor', () => {
  const run = (g, fromMs, toMs, frameMs, events) => {
    for (let t = fromMs; t < toMs; t += 16.7) { const r = g.feed(t, frameMs); if (r) events.push({ t: Math.round(t), ...r }); }
  };
  it('lowers the scale in 0.1 steps after two seconds over budget, then drops a tier, never raises one', () => {
    const g = createGovernor({ budgetMs: 16.7 }), ev = [];
    run(g, 0, 1500, 25, ev);
    expect(ev).toEqual([]); // not yet two seconds over budget
    run(g, 1500, 12000, 25, ev);
    // the app replaces the governor after a drop (createQuality); this one would carry on at the lower tier
    expect(ev.slice(0, 5).map((e) => e.action)).toEqual(['scale', 'scale', 'scale', 'scale', 'drop']);
    expect(ev.slice(0, 4).map((e) => e.scale)).toEqual([0.9, 0.8, 0.7, 0.6]);
    // each decision waits a full window after the last: no change twice within two seconds
    for (let i = 1; i < 5; i++) expect(ev[i].t - ev[i - 1].t).toBeGreaterThanOrEqual(2000);
  });
  it('a short spike does nothing (hysteresis); a sustained calm raises the scale back slowly', () => {
    const g = createGovernor({ budgetMs: 16.7 }), ev = [];
    run(g, 0, 3000, 10, ev);
    run(g, 3000, 3300, 40, ev); // 300 ms of slow frames: under 5 % of the window? no: p95 sees them
    run(g, 3300, 6000, 10, ev);
    expect(ev.filter((e) => e.action === 'drop')).toEqual([]);
    const g2 = createGovernor({ budgetMs: 16.7 }), ev2 = [];
    run(g2, 0, 4500, 25, ev2); // over budget for 4.5 s: the scale comes down
    run(g2, 4500, 7000, 8, ev2); // calm, while the window still holds the slow frames
    const low = g2.scale;
    expect(low).toBeLessThan(1);
    run(g2, 7000, 14000, 8, ev2);
    expect(g2.scale).toBe(low); // not raised within ten seconds of calm
    run(g2, 14000, 30000, 8, ev2);
    expect(g2.scale).toBeGreaterThan(low);
  });
});

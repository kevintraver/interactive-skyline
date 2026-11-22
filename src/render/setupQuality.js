// Quality on the running app (plan 01, T2.7): detect the level, apply a profile to the renderer, the pipeline and
// the shadow map, run the governor on rendered frames, and the fill-rate micro-benchmark (once per GPU, cached).
import { RenderTarget, QuadMesh, MeshBasicNodeMaterial, HalfFloatType } from 'three/webgpu';
import { Fn, vec4, vec3, float, uv, sin, Loop, int, uniform } from 'three/tsl';
import { createQuality, detectLevel } from './quality.js';
import { glOf } from './perf.js';

const BENCH_KEY = 'skyline-fillrate';

/** The GPU's name as WebGL or WebGPU reports it. */
export function gpuName(renderer) {
  const gl = glOf(renderer);
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }
  const a = (renderer.backend.device && renderer.backend.device.adapterInfo) || {};
  return [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' ');
}

/** 30 frames of a full-canvas, 32-step ray march into a half-float target: ms per frame (throughput). */
export async function fillRateBench(renderer, width, height) {
  const target = new RenderTarget(width, height, { type: HalfFloatType, depthBuffer: false });
  const t = uniform(0);
  const material = new MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const acc = vec3(0).toVar();
    const p = vec3(uv(), t).toVar();
    Loop({ start: int(0), end: int(32) }, () => {
      acc.addAssign(sin(p.mul(7.1)).mul(0.03));
      p.addAssign(vec3(0.013, 0.021, 0.017).add(acc.mul(0.01)));
    });
    return vec4(acc, float(1));
  })();
  const quad = new QuadMesh(material);
  const draw = () => { t.value += 0.01; renderer.setRenderTarget(target); quad.render(renderer); renderer.setRenderTarget(null); };
  const sync = async () => { await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1); };
  for (let i = 0; i < 3; i++) draw();
  await sync();
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) draw();
  await sync();
  const ms = (performance.now() - t0) / 30;
  target.dispose(); material.dispose();
  return ms;
}

export function initQuality(app) {
  const { renderer, pipeline, sky, settings, backend, invalidate } = app;
  const classic = !app.look || app.look.display === 'classic';
  const gpu = pipeline.legacy ? '' : gpuName(renderer);
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(BENCH_KEY) || 'null'); } catch { cached = null; }
  const fillRateMs = cached && cached.gpu === gpu && cached.backend === backend ? cached.ms : null;
  const env = { backend, gpu, deviceMemory: navigator.deviceMemory, cores: navigator.hardwareConcurrency, userAgent: navigator.userAgent,
    canvasPixels: innerWidth * innerHeight * devicePixelRatio ** 2, fillRateMs };
  const detected = detectLevel(env);
  let lastShadow = sky.sun.shadow.mapSize.x;

  function apply(profile, scale) {
    if (classic || pipeline.legacy) return; // the classic display keeps the classic renderer's settings
    const pixels = innerWidth * innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, profile.maxPixelRatio, Math.sqrt(profile.maxPixels / Math.max(pixels, 1)));
    renderer.setPixelRatio(Math.max(0.25, ratio * scale));
    renderer._samples = profile.msaa; // WebGPURenderer has no setter; the scene pass reads renderer.samples each frame
    pipeline.configure({ bloomScale: profile.bloomScale });
    if (profile.shadowMapSize !== lastShadow) {
      lastShadow = profile.shadowMapSize;
      sky.sun.shadow.mapSize.set(lastShadow, lastShadow);
      if (sky.sun.shadow.map) { sky.sun.shadow.map.dispose(); sky.sun.shadow.map = null; }
      renderer.shadowMap.needsUpdate = true;
    }
    if (app.views) app.views.resize();
    invalidate();
  }

  // ?q=low|high|ultra overrides the stored choice for this visit (the landmark checker passes q=low)
  const asked = new URLSearchParams(location.search).get('q');
  const choice = classic ? 'high' : ['low', 'high', 'ultra', 'auto'].includes(asked) ? asked : settings.quality || 'auto';
  const quality = app.quality = createQuality({ backend, detected, choice, apply,
    caps: { reversedDepth: !!renderer.reversedDepthBuffer } });
  quality.gpu = gpu;
  quality.classic = classic;

  // the benchmark, once per GPU and backend, after the first frame and only where the decision table is not sure
  quality.bench = async () => {
    const w = Math.round(innerWidth * Math.min(devicePixelRatio, 2)), h = Math.round(innerHeight * Math.min(devicePixelRatio, 2));
    const ms = await fillRateBench(renderer, w, h);
    try { localStorage.setItem(BENCH_KEY, JSON.stringify({ gpu, backend, ms })); } catch { /* no storage */ }
    quality.detected = detectLevel({ ...env, fillRateMs: ms });
    quality.detected.fillRateMs = ms;
    if (quality.choice === 'auto' && quality.detected.level !== quality.level) quality.set('auto');
    return ms;
  };
  if (!classic && !pipeline.legacy && fillRateMs === null && detected.level !== 'low' && !/[?&]nobench=1/.test(location.search)) {
    setTimeout(() => { quality.bench().catch((e) => console.warn('fill-rate benchmark failed', e)); }, 1500);
  }
  return quality;
}

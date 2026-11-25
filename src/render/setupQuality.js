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

/**
 * A light's shadow map at a new size (a level change). Only the size is set and a redraw asked for: on WebGPURenderer
 * the light's ShadowNode owns the render target (`shadow.map` is the node's own) and resizes it from shadow.mapSize
 * when it next draws (ShadowNode.renderShadow). Disposing it here left the node and the materials' bind groups on a
 * destroyed depth texture, every later submit failed validation and the canvas stayed blank for the rest of the visit
 * (plan 03's "blank frame": High to Low under the fill-rate benchmark or the governor). Returns whether it changed.
 */
export function resizeShadowMap(renderer, light, size) {
  if (light.shadow.mapSize.x === size && light.shadow.mapSize.y === size) return false;
  light.shadow.mapSize.set(size, size);
  renderer.shadowMap.needsUpdate = true;
  return true;
}

/**
 * The sun's shadow map sized once, by the first level applied (start-up, before any shadow map exists), and kept
 * through later level changes for the visit: a resize in the frame the pipeline rebuilds for a new MSAA count still
 * left a destroyed depth texture bound inside three 0.187 (WebGPU, Low to High: "Destroyed texture
 * [ShadowDepthTexture] used in a submit"; WebGL2, High to Low: "bindTexture: attempt to use a deleted object"), and the
 * canvas blank. Costs at most a 4096 map kept after a drop to Low (64 MB), or 2048 shadows after a rise, until reload.
 */
export function createShadowSizer(renderer, light) {
  let sized = false;
  return (size) => { if (sized) return false; sized = true; return resizeShadowMap(renderer, light, size); };
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
  const sizeShadow = createShadowSizer(renderer, sky.sun);

  function apply(profile, scale) {
    if (classic || pipeline.legacy) return; // the classic display keeps the classic renderer's settings
    const pixels = innerWidth * innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, profile.maxPixelRatio, Math.sqrt(profile.maxPixels / Math.max(pixels, 1)));
    renderer.setPixelRatio(Math.max(0.25, ratio * scale));
    renderer._samples = profile.msaa; // WebGPURenderer has no setter; the pipeline rebuilds its graph when the count changes
    pipeline.configure({ bloomScale: profile.bloomScale });
    sizeShadow(profile.shadowMapSize);
    if (app.views) app.views.resize();
    invalidate();
  }

  // ?q=low|high|ultra overrides the stored choice for this visit (the landmark checker passes q=low)
  const asked = new URLSearchParams(location.search).get('q');
  const choice = classic ? 'high' : ['low', 'high', 'ultra', 'auto'].includes(asked) ? asked : settings.quality || 'auto';
  const quality = app.quality = createQuality({ backend, detected, choice, apply,
    caps: { reversedDepth: !!renderer.reversedDepthBuffer } });
  quality.gpu = gpu;
  /** ?q= for this visit: it wins over the stored choice until the user picks one in #settings */
  quality.urlChoice = ['low', 'high', 'ultra', 'auto'].includes(asked) ? asked : null;
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

// The renderer (plan 01, sections 7.1 and 11.8; task T2.1): one WebGPURenderer, on its WebGPU backend where the
// browser offers a hardware adapter and on its own WebGL2 backend everywhere else. `?renderer=legacy` keeps the
// classic WebGLRenderer, loaded as a separate chunk only then, until phase 3 deletes it.
//
// Backend choice, in this order: ?backend=webgl|webgpu; no navigator.gpu -> WebGL2, decided synchronously; an
// adapter that is null or a fallback (software) one -> WebGL2; otherwise WebGPU. The landmark checker passes
// ?backend=webgl, so its headless browser never waits on an adapter (section 3.3, T2.9).
import { WebGPURenderer, ACESFilmicToneMapping, PCFShadowMap } from 'three/webgpu';
import { installShadowCompat } from './shadowCompat.js';

/** The renderer and backend asked for in the address. */
export function readParams(search) {
  const q = new URLSearchParams(search);
  const backend = q.get('backend');
  return {
    // drive seam: until Drive mode's materials are ported to node materials (plan 02), ?mode=drive opens on the
    // classic renderer
    renderer: q.get('renderer') === 'legacy' || q.get('mode') === 'drive' ? 'legacy' : 'webgpu',
    backend: backend === 'webgl' || backend === 'webgpu' ? backend : 'auto',
  };
}

const isFallback = (a) => !!(a && (a.isFallbackAdapter || (a.info && a.info.isFallbackAdapter)));

/**
 * Which backend to use: { backend: 'webgl2' | 'webgpu', reason }. Synchronous when the answer needs no adapter
 * (?backend=webgl, or no navigator.gpu), else a promise. `?backend=webgpu` accepts a software adapter (the
 * webgpu-software test project) but still falls back when there is no adapter at all.
 */
export function chooseBackend({ backend }, nav = globalThis.navigator || {}) {
  if (backend === 'webgl') return { backend: 'webgl2', reason: '?backend=webgl' };
  if (!nav.gpu) return { backend: 'webgl2', reason: 'no navigator.gpu' };
  return (async () => {
    let adapter = null;
    try { adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { adapter = null; }
    if (!adapter) return { backend: 'webgl2', reason: 'no WebGPU adapter' };
    if (backend === 'webgpu') return { backend: 'webgpu', reason: '?backend=webgpu' };
    if (isFallback(adapter)) return { backend: 'webgl2', reason: 'software WebGPU adapter' };
    return { backend: 'webgpu', reason: 'hardware adapter' };
  })();
}

/** Settings both renderers share: pixel ratio, ACES (until T2.4's pipeline), PCF shadows drawn on demand. */
function common(renderer) {
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
}

/**
 * Create and initialize the renderer on `canvas`. Resolves to { renderer, kind: 'webgpu' | 'legacy', backend:
 * 'webgpu' | 'webgl2' | 'webgl', reason }. The scene is needed for the shadow compatibility shim
 * (renderer.shadowMap.needsUpdate, which the app, the tests and the landmark checker write).
 */
export async function createRenderer({ canvas, scene, search = globalThis.location ? location.search : '' }) {
  const params = readParams(search);
  if (params.renderer === 'legacy') {
    const { createLegacyRenderer } = await import('./legacy/renderer.js');
    const renderer = await createLegacyRenderer({ canvas, scene });
    common(renderer);
    renderer.shadowMap.autoUpdate = false;
    return { renderer, kind: 'legacy', backend: 'webgl', reason: '?renderer=legacy' };
  }
  const choice = await chooseBackend(params);
  const renderer = new WebGPURenderer({
    canvas, antialias: true, reversedDepthBuffer: true, forceWebGL: choice.backend === 'webgl2',
    // timestamp queries for the performance hook and ?bench=1, where the adapter offers them
    trackTimestamp: choice.backend === 'webgpu',
  });
  await renderer.init();
  // WebGPURenderer falls back to WebGL2 on its own when its adapter request fails
  const backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  // on WebGL2 without EXT_clip_control three refuses reversed depth; a logarithmic buffer covers 5 m to 150 km then
  if (!renderer.reversedDepthBuffer) renderer.logarithmicDepthBuffer = true;
  renderer.highPrecision = true;
  common(renderer);
  installShadowCompat(renderer, scene);
  // the classic renderer counted frames in info.render.frame, which the hooks contract exposes; WebGPURenderer keeps
  // the count in info.frame
  if (!('frame' in renderer.info.render)) Object.defineProperty(renderer.info.render, 'frame', { get: () => renderer.info.frame });
  return { renderer, kind: 'webgpu', backend, reason: backend === choice.backend ? choice.reason : 'WebGPU initialization failed' };
}

/** The renderer's maximum anisotropy, on either renderer. */
export const maxAnisotropy = (renderer) => (renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : renderer.capabilities.getMaxAnisotropy());

/**
 * After a lost WebGPU device: reload once on the WebGL2 backend with a notice (?lost=1). The scene, its materials
 * and the user's edits are not carried over; a second loss on WebGL2 is left to the browser.
 */
export function onDeviceLost(renderer, { reload = (url) => location.replace(url) } = {}) {
  renderer.onDeviceLost = (info) => {
    console.warn('The GPU device was lost; reloading on the WebGL2 backend.', info);
    const q = new URLSearchParams(location.search);
    if (q.get('backend') === 'webgl') return;
    q.set('backend', 'webgl');
    q.set('lost', '1');
    reload(`${location.pathname}?${q}`);
  };
}

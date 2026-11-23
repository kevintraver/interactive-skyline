import { shadowCasters } from './shadowCompat.js';

// window.__skyline.perf: measuring the renderer without vsync, for the performance suite (plan 01, 8.7, T0.8).
// Additive to the hooks contract; nothing in the app calls it.
//
// Three renderers are timed the same way where they can be (T2.0):
//   classic WebGLRenderer          GPU time per frame from EXT_disjoint_timer_query_webgl2 around render()
//   WebGPURenderer, WebGL2 backend the same extension on the backend's own GL context (renderer.backend.gl)
//   WebGPURenderer, WebGPU backend timestamp queries (the renderer's trackTimestamp): the sum of every pass's
//                                  begin-to-end time in the frame, read back with resolveTimestampsAsync()
// The GL timer brackets everything the frame submitted, the WebGPU timestamps every pass of it; both leave out
// the compositor, so the numbers compare like for like within a few tenths of a millisecond.

/** The backend actually rendering: 'webgl' for the classic renderer, else 'webgl2' or 'webgpu'. */
export function backendOf(renderer) {
  if (!renderer.isWebGPURenderer) return 'webgl';
  return renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
}

/** The GL context of a renderer drawing through WebGL (classic or the WebGL2 backend), or null. */
export function glOf(renderer) {
  if (!renderer.isWebGPURenderer) return renderer.getContext();
  return renderer.backend && renderer.backend.gl ? renderer.backend.gl : null;
}

export function createPerf({ renderer, scene, camera, loop, pipeline: pipe }) {
  const pipeline = pipe && !pipe.legacy ? pipe : null;
  const backend = backendOf(renderer);
  const gl = glOf(renderer);
  const draw = () => (pipeline ? pipeline.render() : renderer.render(scene, camera));
  /** One frame's renderer.info counts, after drawing the current view once. */
  function info() {
    draw();
    const { render, memory, programs } = renderer.info;
    if (renderer.isWebGPURenderer) {
      return { calls: render.drawCalls, triangles: render.triangles, points: render.points, lines: render.lines,
        geometries: memory.geometries, textures: memory.textures, programs: pipelineCount() };
    }
    return { calls: render.calls, triangles: render.triangles, points: render.points, lines: render.lines,
      geometries: memory.geometries, textures: memory.textures, programs: programs ? programs.length : 0 };
  }
  // the WebGPU renderer's compiled render pipelines (its counterpart of the classic renderer's programs)
  function pipelineCount() {
    const p = renderer._pipelines;
    if (!p || !p.caches) return 0;
    return p.caches.size;
  }
  const nextTask = () => new Promise((done) => setTimeout(done, 0));
  // count shadow-map redraws (T1.3: at most one per 0.1 degree of solar motion)
  let shadowRenders = 0;
  if (renderer.isWebGPURenderer) {
    // WebGPURenderer redraws a light's shadow map at most once per node frame and then clears shadow.needsUpdate:
    // count the clearing (a render made while the flag is pending does not always redraw)
    for (const light of shadowCasters(scene)) {
      let flag = light.shadow.needsUpdate;
      Object.defineProperty(light.shadow, 'needsUpdate', {
        configurable: true,
        get: () => flag,
        set(v) { if (flag && !v) shadowRenders++; flag = v; },
      });
    }
  } else {
    const shadowMap = renderer.shadowMap, drawShadows = shadowMap.render;
    shadowMap.render = function render(...args) {
      if (shadowMap.enabled && (shadowMap.autoUpdate || shadowMap.needsUpdate)) shadowRenders++;
      return drawShadows.apply(this, args);
    };
  }

  async function timeWebGPU(n, warm) {
    for (let i = 0; i < warm; i++) draw();
    if (renderer.backend.trackTimestamp) await renderer.resolveTimestampsAsync('render');
    const ms = [], wall = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      draw();
      if (renderer.backend.trackTimestamp) {
        const d = await renderer.resolveTimestampsAsync('render');
        if (Number.isFinite(d) && d > 0) ms.push(d);
      } else {
        await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      wall.push(performance.now() - t0);
    }
    if (renderer.backend.trackTimestamp && ms.length) return { ms, method: 'gpu-timestamp', wallMs: wall };
    return { ms: wall, method: 'submitted-work-done' };
  }

  // wait until the GPU has finished everything submitted so far
  const px = new Uint8Array(4);
  async function sync() {
    if (backend === 'webgpu') return renderer.backend.device.queue.onSubmittedWorkDone();
    // a one-pixel read from the canvas blocks until the GPU is done (gl.finish() does not on ANGLE Metal); the
    // read framebuffer binding is restored so three's state cache stays right
    const bound = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bound);
    return undefined;
  }

  return {
    backend,
    /** Resolves when the GPU has finished everything submitted so far. */
    sync,
    /**
     * Throughput: draw `n` frames back to back (after `warm`), wait for the GPU, and resolve to the mean time per
     * frame: { msPerFrame, method: 'throughput' }. Measured on all three renderers the same way. Added in T2.0
     * because GPU timer queries on ANGLE Metal (Apple M4) are dominated by the GPU's clock: a frame timed alone,
     * with the GPU idle around it, read anywhere from 6 to 99 ms for the same scene, while back-to-back
     * submission keeps the GPU at speed and agrees within a few per cent between batches. Includes the CPU
     * cost of submitting when that is the slower side, which is part of a renderer's cost.
     */
    async throughput(n = 60, warm = 10) {
      for (let i = 0; i < warm; i++) draw();
      await sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) draw();
      await sync();
      return { msPerFrame: (performance.now() - t0) / n, method: 'throughput' };
    },
    /**
     * Draw the current view `n` times in a synchronous loop (after `warm` uncounted frames) and resolve to each
     * frame's time in milliseconds: { ms, method }. Not capped by vsync.
     *  - 'gpu-timer': GPU time per frame from EXT_disjoint_timer_query_webgl2, where the browser has it.
     *  - 'gpu-timestamp': WebGPU timestamp queries, summed over the frame's passes.
     *  - 'finish': wall time per frame with gl.finish() after each, elsewhere. On ANGLE Metal (Apple M4,
     *    measured 21 Nov 2026) gl.finish() does not wait for the GPU: it reported 0.3-5 ms where the timer
     *    query and a one-pixel readPixels both showed 12-21 ms. Treat 'finish' numbers as submit time.
     * Results are null for a frame whose query the GPU marked disjoint (clock change); those are dropped.
     */
    async renderFrames(n = 120, warm = 30) {
      if (backend === 'webgpu') return timeWebGPU(n, warm);
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      for (let i = 0; i < warm; i++) draw();
      gl.finish();
      const queries = [], wall = [];
      for (let i = 0; i < n; i++) {
        const q = ext ? gl.createQuery() : null;
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        const t0 = performance.now();
        draw();
        if (q) gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.finish();
        wall.push(performance.now() - t0);
        queries.push(q);
      }
      if (!ext) return { ms: wall, method: 'finish' };
      const ms = [];
      for (const q of queries) {
        while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) await nextTask();
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (!disjoint) ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
      return { ms, method: 'gpu-timer', wallMs: wall };
    },
    info,
    /** Frames the app's own loop has rendered since the page loaded. */
    frames: () => loop.frames,
    /** Shadow-map redraws since the hook was installed. */
    shadowRenders: () => shadowRenders,
    /** The GPU as WebGL or WebGPU reports it, and whether it is a software rasterizer. */
    gpu() {
      let name;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      } else {
        const a = (renderer.backend.device && renderer.backend.device.adapterInfo) || {};
        name = [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' ') || 'webgpu';
      }
      return { renderer: name, backend, software: /swiftshader|llvmpipe|software|microsoft basic/i.test(name) };
    },
  };
}

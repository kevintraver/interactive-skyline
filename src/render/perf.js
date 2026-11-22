// window.__skyline.perf: measuring the renderer without vsync, for the performance suite (plan 01, 8.7, T0.8).
// Additive to the hooks contract; nothing in the app calls it.
export function createPerf({ renderer, scene, camera, loop }) {
  const gl = renderer.getContext();
  /** One frame's renderer.info counts, after drawing the current view once. */
  function info() {
    renderer.render(scene, camera);
    const { render, memory, programs } = renderer.info;
    return { calls: render.calls, triangles: render.triangles, points: render.points, lines: render.lines,
      geometries: memory.geometries, textures: memory.textures, programs: programs ? programs.length : 0 };
  }
  const nextTask = () => new Promise((done) => setTimeout(done, 0));
  // count shadow-map redraws (T1.3: at most one per 0.1 degree of solar motion)
  const shadowMap = renderer.shadowMap, drawShadows = shadowMap.render;
  let shadowRenders = 0;
  shadowMap.render = function render(...args) {
    if (shadowMap.enabled && (shadowMap.autoUpdate || shadowMap.needsUpdate)) shadowRenders++;
    return drawShadows.apply(this, args);
  };
  return {
    /**
     * Draw the current view `n` times in a synchronous loop (after `warm` uncounted frames) and resolve to each
     * frame's time in milliseconds: { ms, method }. Not capped by vsync.
     *  - 'gpu-timer': GPU time per frame from EXT_disjoint_timer_query_webgl2, where the browser has it.
     *  - 'finish': wall time per frame with gl.finish() after each, elsewhere. On ANGLE Metal (Apple M4,
     *    measured 21 Nov 2026) gl.finish() does not wait for the GPU: it reported 0.3-5 ms where the timer
     *    query and a one-pixel readPixels both showed 12-21 ms. Treat 'finish' numbers as submit time.
     * Results are null for a frame whose query the GPU marked disjoint (clock change); those are dropped.
     */
    async renderFrames(n = 120, warm = 30) {
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      for (let i = 0; i < warm; i++) renderer.render(scene, camera);
      gl.finish();
      const queries = [], wall = [];
      for (let i = 0; i < n; i++) {
        const q = ext ? gl.createQuery() : null;
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        const t0 = performance.now();
        renderer.render(scene, camera);
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
    /** The GPU as WebGL reports it, and whether it is a software rasterizer. */
    gpu() {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      return { renderer: name, software: /swiftshader|llvmpipe|software|microsoft basic/i.test(name) };
    },
  };
}

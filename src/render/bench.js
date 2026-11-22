// ?bench=1 (plan 01, section 8.7; task T2.8): a fixed camera and clock script, timed per pass, with peak texture
// memory. The script orbits the city's first view once while the clock runs from 06:00 to 22:00 over the length of
// the run (20 s by default; ?benchSeconds= for a short headless check). Results go to the console and to
// window.__skyline.bench.result; tests/e2e/bench.spec.js records them under tests/reference/bench/.
//
// Per pass: three's timestamp queries sum every pass of a frame on WebGPU but do not split them, and the WebGL2
// backend has none, so each pass's cost is measured by difference with throughput (perf.throughput()): the whole
// pipeline; the scene pass alone (renderer.render without post); the pipeline without bloom; and the exposure meter.
// Measured at five points of the script, after it has played.
export function createBench(app) {
  const { renderer, scene, camera, controls, pipeline, clock, env, views, city } = app;
  const seconds = Number(new URLSearchParams(location.search).get('benchSeconds')) || 20;
  const bench = { running: false, result: null };

  async function measurePasses(perf) {
    const n = 20, out = {};
    const time = async (fn) => {
      for (let i = 0; i < 3; i++) fn();
      await perf.sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      await perf.sync();
      return (performance.now() - t0) / n;
    };
    out.frameMs = await time(() => pipeline.render());
    out.scenePassMs = await time(() => renderer.render(scene, camera));
    if (!pipeline.legacy) {
      const s = pipeline.settings;
      pipeline.configure({ bloom: 0 });
      const noBloom = await time(() => pipeline.render());
      pipeline.configure({ bloom: s.bloom });
      out.bloomMs = Math.max(0, out.frameMs - noBloom);
      out.postMs = Math.max(0, noBloom - out.scenePassMs);
      if (app.look) out.meterMs = Math.max(0, (await time(() => { pipeline.render(); app.look.afterRender(); })) - out.frameMs);
    }
    return out;
  }

  bench.run = async () => {
    bench.running = true;
    const perf = window.__skyline.perf;
    env.enterClock();
    clock.pause();
    const start = new Date(clock.timeMs);
    clock.setLocal({ year: start.getUTCFullYear(), month: 6, day: 21, hour: 6, minute: 0 });
    const t6 = clock.timeMs, t22 = t6 + 16 * 3600e3;
    views.set(city.views[0].id);
    const target = controls.target.clone(), offset = camera.position.clone().sub(target);
    const frames = [], samples = [];
    let peakTextures = 0;
    const t0 = performance.now();
    await new Promise((done) => {
      const step = () => {
        const f = Math.min(1, (performance.now() - t0) / (seconds * 1000));
        const a = f * Math.PI * 2;
        camera.position.set(target.x + offset.x * Math.cos(a) - offset.z * Math.sin(a), target.y + offset.y,
          target.z + offset.x * Math.sin(a) + offset.z * Math.cos(a));
        camera.lookAt(target);
        clock.set(t6 + f * (t22 - t6));
        env.update();
        app.sky.update(env.state);
        if (app.look) app.look.update({ nowMs: performance.now() });
        const tf = performance.now();
        pipeline.render();
        if (app.look) app.look.afterRender();
        frames.push(performance.now() - tf);
        peakTextures = Math.max(peakTextures, renderer.info.memory.texturesSize || 0);
        if (frames.length % Math.max(1, Math.round(frames.length / 5 + 1)) === 0 && samples.length < 5) samples.push(f);
        if (f < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
    const passes = [];
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      clock.set(t6 + f * (t22 - t6)); env.update(); app.sky.update(env.state);
      if (app.look) app.look.update({ nowMs: performance.now() });
      passes.push({ at: +f.toFixed(2), localHour: +(6 + 16 * f).toFixed(1), ...(await measurePasses(perf)) });
    }
    const sorted = [...frames].sort((a, b) => a - b);
    const median = (k) => { const v = passes.map((p) => p[k]).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? +v[v.length >> 1].toFixed(3) : null; };
    bench.result = {
      backend: app.backend, gpu: perf.gpu().renderer, quality: app.quality ? app.quality.level : null, seconds,
      size: [renderer.domElement.width, renderer.domElement.height], frames: frames.length,
      cpuSubmitMs: { median: +sorted[sorted.length >> 1].toFixed(3), p95: +sorted[Math.floor(0.95 * (sorted.length - 1))].toFixed(3) },
      passesMs: { frame: median('frameMs'), scenePass: median('scenePassMs'), post: median('postMs'), bloom: median('bloomMs'), meter: median('meterMs') },
      byTime: passes.map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))),
      peakTextureMB: +(peakTextures / 1e6).toFixed(1),
      method: 'throughput by difference (perf.throughput); per-pass timestamps are not exposed by three r187',
    };
    console.log('[bench]', JSON.stringify(bench.result));
    bench.running = false;
    app.invalidate();
    return bench.result;
  };
  return bench;
}

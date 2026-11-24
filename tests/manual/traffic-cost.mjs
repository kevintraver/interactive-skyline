// The cost of the `traffic` and `valley` parts per frame on the classic renderer and on plan 01's (both backends), in
// the same run (plan 02, third stretch): their JavaScript per frame while playing at 1x (the parts' own timings:
// placement, bodies, lamps; the valley's uniforms), the draw calls they add (renderer.info: on plan 01's renderer it
// does not count a pipeline frame's passes consistently, so read it on the classic renderer only), and the time of a
// drawn frame with and without them, waited to the GPU's end (median of --frames). At night on I-15 near the city (traffic, lamps and
// ribbons all on), the shipped look on the new renderer.
//
// Serve the repository first, then:
//   node tests/manual/traffic-cost.mjs [--port 5325] [--renderers classic,webgl,webgpu] [--frames 40]
// Timings depend on the machine's load: the script prints the load average with them.
import { chromium } from '@playwright/test';
import { loadavg } from 'node:os';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5325));
const renderers = opt('renderers', 'classic,webgl,webgpu').split(',');
const frames = Number(opt('frames', 40));
const NIGHT = Date.parse('2026-11-22T05:00:00Z');
const Q = { classic: 'renderer=legacy', webgl: 'renderer=webgpu&backend=webgl', webgpu: 'renderer=webgpu&backend=webgpu' };

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
const rows = [];
for (const r of renderers) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.goto(`http://localhost:${port}/?city=lv&${Q[r]}&parts=traffic,valley`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 300000 });
  const load0 = loadavg()[0];
  const res = await page.evaluate(async ({ NIGHT, frames }) => {
    const s = window.__skyline, d = s.drive, ren = s.renderer;
    const raf = () => new Promise((res) => requestAnimationFrame(res));
    const settle = () => Promise.race([d.whenSettled(), new Promise((res) => setTimeout(res, 60000))]);
    await d.start('i15n', { s: 52000, t: NIGHT, view: 'clean' });
    d.pause(); d.setView('clean'); d.look({ yaw: 0, pitch: 0, lens: 50 });
    let tr = null, va = null;
    for (let i = 0; i < 900 && !(tr?.stats().ready && va); i++) {
      await raf();
      tr = s.scene.getObjectByName('traffic')?.userData.part || null;
      va = s.scene.getObjectByName('valley-ribbons')?.userData.part || null;
    }
    await settle();
    const legacy = !ren.isWebGPURenderer;
    const finish = async () => {
      const g = legacy ? ren.getContext() : ren.backend?.gl;
      const dev = !legacy ? ren.backend?.device : null;
      if (dev) { await dev.queue.onSubmittedWorkDone(); return; }
      if (g) { const px = new Uint8Array(4); g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); }
    };
    const timeFrames = async () => {
      for (let i = 0; i < 5; i++) { d.renderFrame(); await finish(); }
      const ts = [];
      for (let i = 0; i < frames; i++) { const t0 = performance.now(); d.renderFrame(); await finish(); ts.push(performance.now() - t0); }
      ts.sort((a, b) => a - b);
      return +ts[Math.floor(ts.length / 2)].toFixed(2);
    };
    const calls = () => { d.renderFrame(); return ren.info.render.calls ?? ren.info.render.drawCalls; };
    const out = { renderer: `${s.rendererInfo.kind}/${s.rendererInfo.backend}` };
    out.callsWith = calls();
    out.frameWithMs = await timeFrames();
    tr.setEnabled(false); va.setEnabled(false);
    out.callsWithout = calls();
    out.frameWithoutMs = await timeFrames();
    tr.setEnabled(true); va.setEnabled(true);
    // JavaScript per frame while playing at 1x: a fresh run of the parts' timings
    d.seek({ s: 52000, t: NIGHT }); await settle();
    const before = tr.stats().js;
    d.play();
    await new Promise((res) => setTimeout(res, 8000));
    d.pause();
    const st = tr.stats(), vs = va.stats();
    out.js = { place: st.js.place, draw: st.js.draw, lamps: st.js.lamps, valley: vs.js, countsBefore: [before.place.count, before.draw.count] };
    out.traffic = { drawn: st.drawn, detailed: st.detailed, coarse: st.coarse, sprites: st.lamps.sprites, ribbons: st.lamps.ribbons?.visible, pools: st.lamps.pools };
    return out;
  }, { NIGHT, frames });
  res.load = [load0, loadavg()[0]].map((x) => +x.toFixed(0));
  rows.push(res);
  await page.close();
}
await browser.close();
const f = (t) => (t ? `${t.mean.toFixed(2)} / ${t.p95.toFixed(2)}` : '-');
console.log('renderer        frame with  without  (ms, median)  calls with/without  JS mean / p95 (ms): place   bodies   lights   valley   load');
for (const r of rows) {
  console.log(`${r.renderer.padEnd(15)} ${String(r.frameWithMs).padStart(9)}  ${String(r.frameWithoutMs).padStart(7)}                ${String(r.callsWith).padStart(5)} / ${String(r.callsWithout).padEnd(5)}         ${f(r.js.place)}  ${f(r.js.draw)}  ${f(r.js.lamps)}  ${f(r.js.valley)}  ${r.load.join(' -> ')}`);
}
console.log(JSON.stringify(rows, null, 1));

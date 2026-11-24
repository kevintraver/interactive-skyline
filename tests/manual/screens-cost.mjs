// The cost of the `screens` and `billboards` parts per frame on the classic renderer and on plan 01's (both backends)
// (plan 02, third stretch): their JavaScript per frame while playing, the draw calls and triangles they add, the time
// of a drawn frame with and without them (the billboards hidden; the Sphere's light off), waited to the GPU's end, and
// the GPU memory they hold (the advertisements' atlas with its mipmaps, the instance buffers, the table).
//
// Serve the repository first, then:
//   node tests/manual/screens-cost.mjs [--port 5322] [--renderers classic,webgl,webgpu] [--frames 60]
// Timings depend on the machine's load: the script prints the load average with them.
import { chromium } from '@playwright/test';
import { loadavg } from 'node:os';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5322));
const renderers = opt('renderers', 'classic,webgl,webgpu').split(',');
const frames = Number(opt('frames', 60));
const NIGHT = Date.parse('2026-11-22T05:00:00Z');
const Q = { classic: 'renderer=legacy', webgl: 'renderer=webgpu&backend=webgl', webgpu: 'renderer=webgpu&backend=webgpu' };

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
for (const r of renderers) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.goto(`http://localhost:${port}/?city=lv&${Q[r]}&parts=screens,billboards`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 300000 });
  const before = loadavg()[0];
  const res = await page.evaluate(async ({ NIGHT, frames }) => {
    const s = window.__skyline, d = s.drive, ren = s.renderer;
    const raf = () => new Promise((res) => requestAnimationFrame(res));
    const settle = () => Promise.race([d.whenSettled(), new Promise((res) => setTimeout(res, 60000))]);
    await s.attractions?.ready;
    await d.start('i15n', { s: 46000, t: NIGHT, view: 'clean' });
    d.pause(); d.setView('clean');
    let bb = null, scr = null;
    for (let i = 0; i < 900 && !(bb && scr); i++) {
      await raf();
      bb = s.scene.getObjectByName('billboards')?.userData.billboardsPart || null;
      scr = s.scene.getObjectByName('drive')?.userData.screensPart || null;
    }
    await bb?.whenSettled();
    const legacy = !ren.isWebGPURenderer;
    const gl = legacy ? ren.getContext() : null;
    const finish = async () => {
      if (legacy) { const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return; }
      const dev = ren.backend?.device;
      if (dev) await dev.queue.onSubmittedWorkDone();
      else { const g = ren.backend?.gl; if (g) { const px = new Uint8Array(4); g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); } }
    };
    const timeFrames = async () => {
      for (let i = 0; i < 5; i++) { d.renderFrame(); await finish(); }
      const ts = [];
      for (let i = 0; i < frames; i++) { const t0 = performance.now(); d.renderFrame(); await finish(); ts.push(performance.now() - t0); }
      ts.sort((a, b) => a - b);
      return +ts[Math.floor(ts.length / 2)].toFixed(2);
    };
    const info = () => ({ calls: ren.info.render.calls ?? ren.info.render.drawCalls, triangles: ren.info.render.triangles });
    const out = { renderer: s.rendererInfo };
    // billboards: near the digital face at 46.2 km, looking at it
    d.seek({ s: 46100, t: NIGHT }); d.look({ yaw: -25, pitch: 4, lens: 35 }); await settle(); for (let i = 0; i < 3; i++) await raf();
    d.renderFrame(); out.withBoards = info();
    out.frameWithBoardsMs = await timeFrames();
    bb.setEnabled(false); d.renderFrame(); out.withoutBoards = info();
    out.frameWithoutBoardsMs = await timeFrames();
    bb.setEnabled(true);
    // the Sphere from the road with its light on the buildings around it, light on and off
    d.seek({ s: 59500, t: NIGHT }); d.lookAtBuilding('w976405284'); d.look({ lens: 50 }); await settle(); for (let i = 0; i < 3; i++) await raf();
    out.frameSphereLightOnMs = await timeFrames();
    scr.setLight(false);
    out.frameSphereLightOffMs = await timeFrames();
    scr.setLight(true);
    // JavaScript per frame while playing at 1x and 16x (the parts' own timings)
    for (const rate of [1, 16]) {
      d.seek({ s: 58500, t: NIGHT }); d.look({ yaw: 0, pitch: 0, lens: 50 }); await settle();
      // the bar's own buttons, as a visitor would (1x to 16x is four steps faster)
      const btn = (c) => document.querySelector(`#dock .${c}`);
      for (let i = 0; i < 8; i++) btn('slower')?.click();
      for (let r1 = 0.25; r1 < rate; r1 *= 2) btn('faster')?.click();
      d.play();
      await new Promise((res) => setTimeout(res, 6000));
      d.pause();
      const st = d.stats();
      out[`js${rate}x`] = { rate: d.pose().rate ?? null, screens: st?.screens?.js, billboards: st?.billboards?.js };
    }
    const st = d.stats();
    out.billboards = { boards: st?.billboards?.boards, faces: st?.billboards?.faces, lamps: st?.billboards?.lamps, glowMax: st?.billboards?.glowMax, detail: st?.billboards?.detail, images: st?.billboards?.images };
    out.screens = { count: st?.screens?.screens?.count, materials: st?.screens?.materials };
    // GPU memory the billboards hold: the atlas (with mipmaps), the table, the instance attributes and matrices
    const g = s.scene.getObjectByName('billboards');
    let inst = 0, geo = 0;
    g?.traverse((o) => {
      if (o.isInstancedMesh) inst += o.instanceMatrix.array.byteLength;
      for (const a of Object.values(o.geometry?.attributes || {})) geo += a.array.byteLength;
    });
    out.gpuBytes = { atlas: st?.billboards?.images?.gpuBytes, table: bb.uniforms.uAdTable.value.image.data?.byteLength, instances: inst, geometry: geo };
    out.memory = { ...ren.info.memory };
    return out;
  }, { NIGHT, frames });
  console.log(`\n== ${r} (load average ${before.toFixed(0)} -> ${loadavg()[0].toFixed(0)})\n${JSON.stringify(res, null, 1)}`);
  await page.close();
}
await browser.close();

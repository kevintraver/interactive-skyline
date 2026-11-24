// GPU screenshots of the drive's street lamps (plan 02, D5.4, D5.5), from drive-shots.mjs with more options.
// Serve the repo first:  pnpm exec vite --port 5283 --strictPort
// then: node tests/manual/lamps-shots.mjs <out-dir> <port> '<shots>' [--perf]
// <shots> is JSON: [[name, s in metres, when, { yaw, pitch, lens, lamps }?], ...]
//   when: "day", "night", or { "sun": elevation in degrees } (the evening's time at that elevation)
//   lamps: false switches the lamps part off for that shot
// --perf: for each shot also measure frames (rAF intervals over 120 frames, the clock paused and the frame redrawn
// every tick) with the lamps part on and off, and print the part's per-frame JavaScript.
//
// Plan 01's renderer (plan 02, third stretch): --renderer webgpu or webgl (the backend) opens ?renderer=webgpu in the
// shipped look (add --display classic for ?display=classic), with --parts (default lamps,headlights,obstruction) and
// --quality (default high, pinned before Drive is entered: a level change while driving breaks plan 01's frame).
// The clean view; screenshots are the canvas alone. Each shot's look may say headlights: false, high: true,
// obstruction: false as well as lamps: false. --perf there measures each of the three parts' cost per frame: the
// pipeline's frame drawn and the GPU waited for (WebGPU: queue.onSubmittedWorkDone; WebGL2: finish), the part on and
// off interleaved frame by frame (120 pairs), medians and the difference; and each part's own JavaScript while the car
// drives for 6 s.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createEphemeris } from '../../src/drive/env.js';

const out = process.argv[2]; const port = process.argv[3] || 5283;
const shots = JSON.parse(process.argv[4]);
const perf = process.argv.includes('--perf');
const noThin = process.argv.includes('--no-thinning'); // draw up to the 80 k budget: far cells not thinned by screen area
mkdirSync(out, { recursive: true });
const cities = JSON.parse(readFileSync(new URL('../../data/cities.json', import.meta.url)));
const city = Array.isArray(cities) ? cities.find((c) => c.id === 'lv') : cities.lv;
const eph = createEphemeris(city);
const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T02:30:00Z');
const timeOf = (when) => (when === 'day' ? DAY : when === 'night' ? NIGHT : eph.timeOfSunElevation(when.sun, DAY, true));

const argOf = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const backend = argOf('renderer', null);
if (backend) { await newRenderer(); process.exit(0); }

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
// other work in the checkout makes Vite reload the page: keep its socket silent
await page.routeWebSocket(/./, () => {});
if (process.env.LAMPS_EXP) await page.addInitScript(`window.__lampsExp = ${process.env.LAMPS_EXP};`);
if (noThin) await page.addInitScript('window.__noThin = true;');
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
const gl = await page.evaluate(() => { const g = window.__skyline.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('renderer:', gl);
await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); try { s.drive.setView('clean'); } catch {} });
// the lamps part loads after the drive starts
await page.waitForFunction(() => window.__skyline.scene.getObjectByName('lamp-sprites'), null, { timeout: 60000 }).catch(() => console.log('no lamp-sprites in the scene'));

for (const [name, s, when, look] of shots) {
  const { lamps = true, ...lk } = look || {};
  const info = await page.evaluate(async ({ s, t, look, lamps }) => {
    const d = window.__skyline.drive;
    const part = window.__skyline.scene.getObjectByName('lamp-sprites')?.userData.lampsPart;
    part?.setEnabled(lamps);
    if (window.__noThin) part?.setScreenDensity(Infinity);
    d.pause(); d.seek({ s, t }); d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
    await d.whenSettled();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = d.pose(); const st = d.stats();
    return { s: Math.round(p.s), sun: +p.sunElevation.toFixed(2), calls: st?.render?.calls, tris: st?.render?.triangles, lamps: st?.lamps };
  }, { s, t: timeOf(when), look: lk, lamps });
  await page.screenshot({ path: `${out}/${name}.png` });
  const l = info.lamps || {};
  console.log('shot', name, JSON.stringify({ s: info.s, sun: info.sun, calls: info.calls, tris: info.tris, sprites: l.sprites, cells: l.cells, inView: l.lampsInView, poles: l.poles, lights: l.lights && +l.lights.toFixed(3), lux: l.ambientLux && +l.ambientLux.toFixed(2), pools: l.pools, js: l.js }));
  if (perf) {
    for (const on of [true, false, true]) {
      const r = await page.evaluate(async (on) => {
        const s = window.__skyline;
        const part = s.scene.getObjectByName('lamp-sprites')?.userData.lampsPart;
        part?.setEnabled(on);
        const d = s.drive;
        await d.whenSettled();
        // redraw every frame: a tiny look change each tick keeps the renderer busy without moving the car
        const times = [];
        let last = performance.now(), k = 0;
        await new Promise((resolve) => {
          const tick = () => {
            const now = performance.now(); times.push(now - last); last = now;
            d.look({ yaw: (k++ % 2) * 0.001 });
            if (times.length < 140) requestAnimationFrame(tick); else resolve();
          };
          requestAnimationFrame(tick);
        });
        // GPU time of one frame: finish() after a render
        const r = s.renderer, g = r.getContext();
        const gpu = [];
        for (let i = 0; i < 30; i++) {
          g.finish();
          const t0 = performance.now();
          d.look({ yaw: (i % 2) * 0.001 });
          s.drive.whenSettled && 0;
          await new Promise((res) => requestAnimationFrame(res));
          g.finish();
          gpu.push(performance.now() - t0);
        }
        // the sprite draw alone, by a GPU timer query around it
        let spriteGpu = null;
        const ext = g.getExtension('EXT_disjoint_timer_query_webgl2');
        const mesh = s.scene.getObjectByName('lamp-sprites');
        if (mesh && window.__lampsExp) window.__lampsExp(mesh);
        if (ext && mesh && on) {
          const res = [];
          let q = null;
          mesh.onBeforeRender = () => { q = g.createQuery(); g.beginQuery(ext.TIME_ELAPSED_EXT, q); };
          mesh.onAfterRender = () => { g.endQuery(ext.TIME_ELAPSED_EXT); res.push(q); };
          for (let i = 0; i < 40; i++) { d.look({ yaw: (i % 2) * 0.001 }); await new Promise((r) => requestAnimationFrame(r)); }
          // the floor of the measurement: the same query around a draw of one sprite
          const full = mesh.geometry.instanceCount, res1 = [];
          mesh.onAfterRender = () => { g.endQuery(ext.TIME_ELAPSED_EXT); (mesh.geometry.instanceCount === 1 ? res1 : res).push(q); };
          mesh.geometry.instanceCount = 1;
          for (let i = 0; i < 40; i++) { d.look({ yaw: (i % 2) * 0.001 }); await new Promise((r) => requestAnimationFrame(r)); }
          mesh.geometry.instanceCount = full;
          mesh.onBeforeRender = mesh.onAfterRender = () => {};
          await new Promise((r) => setTimeout(r, 300));
          const read = (list) => list.map((qq) => (g.getQueryParameter(qq, g.QUERY_RESULT_AVAILABLE) ? g.getQueryParameter(qq, g.QUERY_RESULT) / 1e6 : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
          const ms = read(res), ms1 = read(res1);
          spriteGpu = ms.length ? { n: ms.length, drawn: full, p50: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], oneSpriteP50: ms1[ms1.length >> 1] } : 'no results';
        } else if (on) spriteGpu = ext ? 'no mesh' : 'no timer query extension';
        const xs = times.slice(20).sort((a, b) => a - b), gs = gpu.sort((a, b) => a - b);
        const st = d.stats();
        return { on, spriteGpu, frameP50: xs[xs.length >> 1], frameP95: xs[Math.floor(xs.length * 0.95)], finishP50: gs[gs.length >> 1], calls: st.render.calls, js: st.lamps?.js, total: st.js?.total };
      }, on);
      console.log('  perf', JSON.stringify(r));
    }
    // the part's own JavaScript while the car drives (clock at 1x for 6 s, then back where it was)
    const drive = await page.evaluate(async () => {
      const s = window.__skyline, d = s.drive, part = s.scene.getObjectByName('lamp-sprites')?.userData.lampsPart;
      part?.setEnabled(true);
      const p0 = d.pose();
      d.play();
      await new Promise((r) => setTimeout(r, 6000));
      d.pause();
      const st = d.stats();
      d.seek({ s: p0.s, t: p0.t });
      return { lampsJs: st.lamps?.js, total: st.js?.total, sprites: st.lamps?.sprites, culls: st.lamps?.culls };
    });
    console.log('  driving', JSON.stringify(drive));
  }
}
await browser.close();

/** The shots and the cost on plan 01's renderer (see the header). */
async function newRenderer() {
  const parts = argOf('parts', 'lamps,headlights,obstruction'), level = argOf('quality', 'high'), display = argOf('display', null);
  const browser = await chromium.launch({ channel: 'chromium', headless: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
      '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
  await page.routeWebSocket(/./, () => {});
  const q = `city=lv&renderer=webgpu&backend=${backend === 'webgl' ? 'webgl' : 'webgpu'}&parts=${parts}${display ? `&display=${display}` : ''}`;
  await page.goto(`http://localhost:${port}/?${q}`, { timeout: 300000 });
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 300000 });
  console.log('renderer:', JSON.stringify(await page.evaluate(async (level) => {
    const s = window.__skyline; s.quality?.set(level); s.attractions.freeze(20); await s.attractions.ready;
    await s.drive.start('i15n', { view: 'clean' }); s.drive.pause(); s.drive.setView('clean');
    return { ...s.rendererInfo, quality: s.quality?.level };
  }, level)));
  await page.evaluate(() => { const c = window.__skyline.renderer.domElement; for (const el of document.body.querySelectorAll('*')) if (el !== c && !el.contains(c) && !(el instanceof SVGElement)) el.style.visibility = 'hidden'; });
  // the three parts as switches: { name: [get part, setOn] }
  const SWITCHES = `({
    lamps: (on) => window.__skyline.scene.getObjectByName('lamp-sprites')?.userData.lampsPart?.setEnabled(on),
    headlights: (on) => window.__skyline.scene.getObjectByName('drive')?.userData.headlightsPart?.setEnabled(on),
    obstruction: (on) => { const m = window.__skyline.scene.getObjectByName('obstruction-lights'); if (m) m.visible = on; },
  })`;
  for (const [name, sM, when, look] of shots) {
    const { lamps = true, headlights = true, obstruction = true, high = false, route = null, ...lk } = look || {};
    const info = await page.evaluate(async ({ s, t, look, on, high, route, SWITCHES }) => {
      const sk = window.__skyline, d = sk.drive, sw = eval(SWITCHES);
      if (route && d.route()?.id !== route) { await d.start(route, { s, t, view: 'clean' }); d.pause(); }
      for (const [k, v] of Object.entries(on)) sw[k](v);
      sk.scene.getObjectByName('drive')?.userData.headlightsPart?.setHigh(high);
      d.pause(); d.seek({ s, t }); d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
      await d.whenSettled();
      for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
      await d.whenSettled();
      if (on.obstruction) sw.obstruction(true); // setLook may have run
      const p = d.pose(), st = d.stats();
      return { s: Math.round(p.s), sun: +p.sunElevation.toFixed(2), ev100: +sk.env.state.exposure.ev100.toFixed(2), exposure: sk.env.nodes.exposure.value,
        lamps: st.lamps && { sprites: st.lamps.sprites, pools: st.lamps.pools?.complete, budget: st.lamps.budget, poolPx: st.lamps.poolPx },
        headlights: st.headlights && { on: st.headlights.on, high: st.headlights.high }, obstruction: st.obstruction && { lamps: st.obstruction.lamps } };
    }, { s: sM, t: timeOf(when), look: lk, on: { lamps, headlights, obstruction }, high, route, SWITCHES });
    await page.screenshot({ path: `${out}/${name}.png` });
    console.log('shot', name, JSON.stringify(info));
    if (!perf) continue;
    const cost = await page.evaluate(async ({ parts, SWITCHES }) => {
      const sk = window.__skyline, d = sk.drive, sw = eval(SWITCHES), r = sk.renderer;
      const sync = async () => { if (r.backend.device) await r.backend.device.queue.onSubmittedWorkDone(); else r.backend.gl.finish(); };
      const frame = async () => { await sync(); const t0 = performance.now(); sk.pipeline.render(); await sync(); return performance.now() - t0; };
      const med = (x) => { const y = [...x].sort((a, b) => a - b); return y[y.length >> 1]; };
      const out = {};
      for (const name of parts.split(',')) {
        if (!sw[name]) continue;
        const t = { on: [], off: [] };
        for (let i = 0; i < 10; i++) await frame();
        for (let i = 0; i < 240; i++) { const on = i % 2 === 0; sw[name](on); t[on ? 'on' : 'off'].push(await frame()); if (i % 24 === 23) await new Promise((res) => setTimeout(res, 0)); }
        sw[name](true);
        out[name] = { onP50: +med(t.on).toFixed(2), offP50: +med(t.off).toFixed(2), deltaP50: +(med(t.on) - med(t.off)).toFixed(2) };
      }
      // each part's own JavaScript while the car drives
      const p0 = d.pose(); d.play(); await new Promise((res) => setTimeout(res, 6000)); d.pause();
      const st = d.stats(); d.seek({ s: p0.s, t: p0.t });
      for (const name of parts.split(',')) if (out[name] && st[name]?.js) out[name].js = { mean: +st[name].js.mean.toFixed(3), p95: +st[name].js.p95.toFixed(2) };
      out.sessionJs = st.js?.total && { mean: +st.js.total.mean.toFixed(2), p95: +st.js.total.p95.toFixed(2) };
      out.sprites = st.lamps?.sprites;
      return out;
    }, { parts, SWITCHES });
    console.log('  cost', JSON.stringify(cost));
  }
  await browser.close();
}

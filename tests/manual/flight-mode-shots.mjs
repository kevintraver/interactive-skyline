// Pictures and measurements of Fly mode in the running app on this machine's GPU (plan 03, F4.7, F4.8, F6.2, F2.8,
// section 9.1). For every baked flight in public/data/lv/flights/index.json (or those named with --flights): cruise
// (the first sample, with the cabin frame and without it), through 18,000 ft, through 10,000 ft, the turn to final
// (the largest bank between 10,000 ft and 1,000 ft above the runway), 60 s out, the threshold, touchdown and the
// rollout (20 s after). At each: a picture with the interface hidden, and the renderer's draw calls and triangles and
// the frame time (perf.throughput: frames drawn back to back, not capped by vsync), with the region terrain's and the
// airport's own counts. Extras (--extras): the picker open, the flight's bar, the seat map, and the cabin by day and at
// night with the shade half closed.
// Writes <out>/<backend>/<flight>_<moment>.jpg (and _noglass.jpg with --glass both) and <out>/<backend>/measure.json.
// --glass on|off|both (default on): the window's glass in the picture (plan 03, Phase 5); with `both` each moment is
// taken with the glass and without it. At each moment it also records the light (cd/m^2, before exposure) on the
// wall beside the window and through the middle of the window (__skyline.flight.luminance), the pane's condition and
// the Sun on it, and the cabin's own light. --before: a build without these hooks (the luminance is then left out).
//
// Serve a build first:  pnpm build --outDir dist-shots && pnpm exec vite preview --outDir dist-shots --port 5381 --strictPort
// then:                 node tests/manual/flight-mode-shots.mjs <out> [--port 5381] [--backend webgpu|webgl2]
//                         [--flights lv-19-dusk,lv-26-day] [--moments cruise,touchdown] [--extras] [--glass both]
//                         [--frames 40]
// From a normal shell on macOS (a sandboxed one gives the browser software rendering).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const out = args.find((a, i) => !a.startsWith('--') && !['--port', '--backend', '--flights', '--moments', '--glass', '--frames'].includes(args[i - 1]));
const glassMode = opt('--glass') || 'on';
const glassRuns = glassMode === 'both' ? [true, false] : [glassMode !== 'off'];
const FRAMES = Number(opt('--frames') || 40);
if (!out) { console.error('usage: node tests/manual/flight-mode-shots.mjs <out> [--port 5381] [--backend webgpu|webgl2] [--flights a,b] [--moments a,b] [--extras]'); process.exit(2); }
const port = opt('--port') || 5381;
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu', 'webgl2'];
const DIR = 'public/data/lv/flights';
const index = JSON.parse(readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const ids = opt('--flights') ? opt('--flights').split(',') : index.flights.map((f) => f.id);
const onlyMoments = opt('--moments') ? opt('--moments').split(',') : null;
const extras = args.includes('--extras');

/** The moments of one flight, seconds from its start, read from its header and channels. */
function momentsOf(id) {
  const header = JSON.parse(readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  const bin = new Float32Array(readFileSync(path.join(DIR, `${id}.bin`)).buffer.slice(0));
  const ch = (name) => { const k = header.channels.indexOf(name); return bin.subarray(k * header.samples, (k + 1) * header.samples); };
  const ev = (k) => header.events.find((e) => e.id === k)?.t;
  const td = ev('touchdown'), roll = ch('roll');
  const from = ev('10000') ?? 0, to = ev('ft1000') ?? td - 60;
  let turn = from, best = 0;
  for (let i = Math.ceil(from); i < to; i++) if (Math.abs(roll[i]) > best) { best = Math.abs(roll[i]); turn = i; }
  const m = { cruise: 0, 'cruise-clean': 0, tod: ev('tod'), fl180: ev('fl180'), ft10000: ev('10000'), turn, 'sixty-out': td - 60, threshold: ev('threshold'), touchdown: td, rollout: Math.min(header.samples - 1, td + 20) };
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => Number.isFinite(v) && (!onlyMoments || onlyMoments.includes(k))));
}

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const hideUi = () => {
  const canvas = document.querySelector('canvas');
  for (const el of document.body.children) if (!el.contains(canvas)) el.dataset.shotHidden = el.style.visibility = 'hidden';
};
const showUi = () => { for (const el of document.body.querySelectorAll('[data-shot-hidden]')) { el.style.visibility = ''; delete el.dataset.shotHidden; } };

for (const backend of backends) {
  const dir = path.join(out, backend);
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/flights\/[\w-]+\.jpg/.test(m.location()?.url || '')) problems.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`); });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* */ } });
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`); // the address says webgl
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && window.__skyline.attractions && document.getElementById('loading').classList.contains('done'), null, { timeout: 240_000 });
  await page.evaluate(async () => { const s = window.__skyline; await s.attractions.ready; s.attractions.freeze(47); await s.flight.ready; });
  const gpu = await page.evaluate(() => window.__skyline.perf.gpu());
  console.log(backend, JSON.stringify(gpu));
  if (gpu.backend !== backend) throw new Error(`asked for ${backend}, drawing on ${gpu.backend}`);
  const measure = { backend, gpu, date: new Date().toISOString(), flights: {} };

  for (const id of ids) {
    const moments = momentsOf(id);
    measure.flights[id] = {};
    await page.evaluate(async (fid) => { const f = window.__skyline.flight; await f.start(fid, { pace: false, play: false }); f.options({ hud: false }); }, id);
    for (const [name, at] of Object.entries(moments)) {
     for (const glass of glassRuns) {
      const r = await page.evaluate(async ({ at, clean, glass, frames }) => {
        const s = window.__skyline, f = s.flight;
        f.options({ frame: !clean });
        if (f.window) f.window({ glass });
        await f.seek({ at });
        await f.whenSettled();
        await f.whenSettled();
        // three resets its counters per animation frame, not per render: reset them, or the app's own frame is counted too
        s.renderer.info.reset();
        const info = s.perf.info();
        const tp = await s.perf.throughput(frames, 8);
        const st = f.state(), stats = f.stats();
        const region = stats.world.region;
        // the light on the wall beside the window and through its middle, before exposure (cd/m^2)
        let light = null;
        if (typeof f.luminance === 'function' && !clean) {
          try {
            const wall = await f.luminance({ x: -0.85, y: 0 }), win = await f.luminance({ x: 0, y: 0.1 });
            light = { wall: +wall.composed.toPrecision(3), wallAlpha: +wall.cabinAlpha.toFixed(2), window: +win.composed.toPrecision(3), outsideBehindWindow: +win.outside.toPrecision(3), exposure: wall.exposure };
          } catch (e) { light = String(e); }
        }
        const pane = stats.pane ? { ...stats.pane.pane, sunE: stats.pane.sunE, reflection: +(+stats.pane.reflection).toFixed(3), enabled: stats.pane.enabled } : null;
        return {
          t: st.t, altMsl: Math.round(st.altMsl), heightAboveGround: +st.heightAboveGround.toFixed(2), headingDeg: +st.headingDeg.toFixed(1),
          pitchDeg: +st.pitchDeg.toFixed(2), rollDeg: +st.rollDeg.toFixed(2), far: Math.round(s.camera.far), near: s.camera.near,
          drawCalls: info.calls, triangles: info.triangles, msPerFrame: +tp.msPerFrame.toFixed(2),
          region: { needed: region.needed, triangles: region.triangles, drawCalls: region.drawCalls, cpuMs: region.cpuMs },
          airport: stats.world.airport && { drawCalls: stats.world.airport.drawCalls, lights: stats.world.airport.lights, night: stats.world.airport.night, updateMs: stats.world.airport.updateMs },
          aircraftTriangles: stats.aircraftTriangles, cabinModel: stats.cabinModel, layerMsP50: +stats.layerMs.p50.toFixed(3),
          sunAltDeg: s.env.state?.sun?.altDeg ?? null, exposure: s.look?.exposure?.state?.ev ?? s.look?.exposure?.state?.value ?? null,
          light, pane, cabinLight: stats.cabinLight ?? null, cabinStage: stats.cabinStage ?? null,
        };
      }, { at, clean: name === 'cruise-clean', glass, frames: FRAMES });
      const file = `${id}_${name}${glass ? '' : '_noglass'}.jpg`;
      await page.evaluate(hideUi);
      await page.evaluate(() => window.__skyline.flight.whenSettled());
      const buf = await page.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: 85 });
      // a blank frame (the page's grey through the canvas; see tests/e2e/flight/blank.gpu.spec.js) is about 3 KB
      if (buf.length < 4000) console.log(backend, id, name, 'BLANK FRAME');
      await page.evaluate(showUi);
      measure.flights[id][glass ? name : `${name}_noglass`] = r;
      console.log(backend, id, name, glass ? 'glass' : 'no glass', JSON.stringify(r));
     }
    }
    if (glassRuns.length) await page.evaluate(() => window.__skyline.flight.window?.({ glass: true }));
    await page.evaluate(() => window.__skyline.flight.options({ frame: true, hud: true }));
  }

  if (extras) {
    const shot = (name) => page.screenshot({ path: path.join(dir, `extra_${name}.jpg`), type: 'jpeg', quality: 85 });
    const first = index.flights[0].id;
    await page.evaluate(async (fid) => { const f = window.__skyline.flight; await f.start(fid, { pace: false, play: false }); await f.seek({ at: f.state().touchdownT - 240 }); await f.whenSettled(); }, first);
    await page.locator('.flight-chip').click();
    await page.waitForTimeout(800); // the preview pictures load
    await shot('picker');
    await page.keyboard.press('Escape');
    await shot('bar');
    await page.locator('#flightbar .seat').click();
    await page.waitForTimeout(300);
    await shot('seatmap');
    await page.keyboard.press('Escape');
    for (const [night, fid] of [['day', 'lv-19-day'], ['night', 'lv-19-night']]) {
      await page.evaluate(async (f2) => {
        const f = window.__skyline.flight;
        await f.start(f2, { pace: false, play: false });
        await f.seek({ at: f.state().touchdownT - 300 });
        f.look({ yaw: -25, pitch: -4, lens: 18 });
        f.options({ hud: false });
        await f.whenSettled();
      }, fid);
      await page.evaluate(hideUi);
      await shot(`cabin-${night}`);
      await page.evaluate(async () => {
        const f = window.__skyline.flight;
        f.shade(0.5); f.play(); await new Promise((r) => setTimeout(r, 1200)); f.pause(); await f.whenSettled();
      });
      await shot(`cabin-${night}-shade-half`);
      await page.evaluate(showUi);
      await page.evaluate(() => { const f = window.__skyline.flight; f.shade(0); f.look({ yaw: 0, pitch: -8, lens: 26 }); });
    }
  }
  measure.problems = problems;
  writeFileSync(path.join(dir, 'measure.json'), JSON.stringify(measure, null, 1));
  if (problems.length) console.log(backend, 'console problems', problems.slice(0, 20));
  await page.close();
}
await browser.close();

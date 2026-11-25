// Pictures and measurements of the cabin in the running app on this machine's GPU (plan 03, F3.5, F5.5, F5.6, the
// cabin pass of 25 Nov 2026): by day, at dusk and at night, from the flight's own window seat (23F), the other side
// (23A), an aisle seat (23D) and a blank-wall seat (11F), at the default look and lens, the wide lens (13 mm), the
// shade half down, looking up at the passenger service unit and forward at the seat back.
//
//   pictures   <out>/<backend>/<flight>_<moment>_<view>.jpg and a contact sheet <out>/<backend>/sheet.html
//   regions    what the screen shows (sRGB 0..255, mean of a 31 x 31 box) at named places of each view (wall, frame,
//              seat back, the service unit, ...); the cabin's adaptation (cabin.adaptation: its lift in EV) and the
//              exposure
//   cost       per moment from 23F at the default look: the frame time drawn back to back (perf.throughput) and the
//              cabin stage's CPU time (cabinStage.stats().cpuMs); the same frame with the stage idle
// Writes <out>/<backend>/measure.json and table.md.
//
// Serve the app first:  pnpm exec vite --port 5481 --strictPort
// then:                 node tests/manual/flight-cabin-app-shots.mjs <out> [--port 5481] [--backend webgpu|webgl2]
//                         [--only day,dusk,night] [--views default,wide,...] [--cost on|off] [--guard on|off]
// From a normal shell on macOS (a sandboxed one gives the browser software rendering).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const VALUED = ['--port', '--backend', '--only', '--views', '--cost', '--size', '--guard'];
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const out = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
if (!out) { console.error('usage: node tests/manual/flight-cabin-app-shots.mjs <out> [--port 5481] [--backend webgpu|webgl2] [--only day,dusk,night]'); process.exit(2); }
const port = opt('--port') || 5481;
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu'];
const only = opt('--only') ? opt('--only').split(',') : null;
const onlyViews = opt('--views') ? opt('--views').split(',') : null;
const cost = opt('--cost') !== 'off';
// --guard off: leave the cabin without the prior's terms (as the app is until the session hands them in)
const guardSource = opt('--guard') !== 'off';
const [W, H] = (opt('--size') || '1280x800').split('x').map(Number);

/** The moments: flight, a chapter or a time, and a label. */
const MOMENTS = [
  { key: 'day', flight: 'lv-19-day', chapter: '10000', label: 'day-10000' },
  { key: 'day', flight: 'lv-19-day', chapter: 'touchdown', label: 'day-touchdown' },
  { key: 'dusk', flight: 'lv-19-dusk', chapter: '10000', label: 'dusk-10000' },
  { key: 'dusk', flight: 'lv-19-dusk', chapter: 'touchdown', label: 'dusk-touchdown' },
  { key: 'night', flight: 'lv-19-night', at: 0, label: 'night-cruise' },
  { key: 'night', flight: 'lv-19-night', chapter: '10000', label: 'night-10000' },
  { key: 'night', flight: 'lv-19-night', sixty: true, label: 'night-final' },
  { key: 'night', flight: 'lv-19-night', rollout: true, label: 'night-rollout' },
];

/** The views: seat, look, shade, and the places measured on the screen (NDC). */
const VIEWS = [
  { name: 'default', seat: '23F', regions: { wall: [-0.81, 0.1], frame: [-0.57, 0.0], below: [0, -0.8] } },
  { name: 'wide', seat: '23F', look: { lens: 13 }, regions: { wall: [-0.6, 0.05], bezel: [-0.3, 0.0], bin: [0, 0.85] } },
  { name: 'shade-half', seat: '23F', shade: 0.5, regions: { shade: [0, 0.35], wall: [-0.81, 0.1] } },
  { name: 'up-psu', seat: '23F', look: { pitch: 40, yaw: 75, lens: 14 }, regions: { psu: [0, 0.3], bin: [0, 0.75] } },
  { name: 'fwd-seatback', seat: '23F', look: { yaw: 70, pitch: -20, lens: 18 }, regions: { seatBack: [-0.1, -0.1], tray: [-0.1, -0.35] } },
  { name: 'left-23A', seat: '23A', regions: { wall: [-0.81, 0.1], wallR: [0.81, 0.1], frame: [0.57, 0.0] } },
  { name: 'aisle-23D', seat: '23D', regions: { seatBack: [0, -0.5], wall: [0.6, 0.3] } },
  { name: 'blank-11F', seat: '11F', regions: { panel: [0, 0], wall: [-0.6, 0.1] } },
];

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const hideUi = () => { const canvas = document.querySelector('canvas'); for (const el of document.body.children) if (!el.contains(canvas)) el.dataset.shotHidden = el.style.visibility = 'hidden'; };
const showUi = () => { for (const el of document.body.querySelectorAll('[data-shot-hidden]')) { el.style.visibility = ''; delete el.dataset.shotHidden; } };

function boxesInPage({ b64, boxes, half }) {
  return (async () => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const res = {};
    for (const [k, [px, py]] of Object.entries(boxes)) {
      const x0 = Math.max(0, Math.round(px) - half), y0 = Math.max(0, Math.round(py) - half);
      const w = Math.min(img.width - x0, 2 * half + 1), h = Math.min(img.height - y0, 2 * half + 1);
      const d = x.getImageData(x0, y0, w, h).data;
      let l = 0;
      for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      res[k] = Math.round(l / (d.length / 4));
    }
    return res;
  })();
}

for (const backend of backends) {
  const dir = path.join(out, backend);
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/flights\/[\w-]+\.jpg/.test(m.location()?.url || '')) problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* */ } performance.setResourceTimingBufferSize(100000); });
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && document.getElementById('loading').classList.contains('done'), null, { timeout: 240_000 });
  await page.evaluate(async () => { const s = window.__skyline; if (s.attractions) { await s.attractions.ready; s.attractions.freeze(47); } await s.flight.ready; });
  // the prior's terms for the cabin's adaptation (the dusk guard), until the session hands them to the cabin's update:
  // the seam of cabin.js (setExposureSource), on the app's own module instance (the dev server)
  const terms = () => page.evaluate(async () => {
    // the URL the app loaded it from (after an edit the dev server adds a timestamp, and another URL is another module)
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/src\/flight\/cabin\/cabin\.js/.test(n)).pop() || '/src/flight/cabin/cabin.js';
    const m = await import(url);
    m.setExposureSource(() => ({ on: !!window.__skyline.look?.current?.priorTerms, terms: window.__skyline.look?.current?.priorTerms ?? null }));
  });
  const gpu = await page.evaluate(() => window.__skyline.perf.gpu());
  if (gpu.backend !== backend) throw new Error(`asked for ${backend}, drawing on ${gpu.backend}`);
  const measure = { backend, gpu, size: [W, H], date: new Date().toISOString(), rows: [] };
  const cells = [];
  let current = null;
  // the dev server reloads the page when a file changes (other work in the checkout): wait for the app again, enter
  // the flight again and take the view again
  const reloaded = async () => {
    await page.waitForFunction(() => window.__skyline && window.__skyline.flight && document.getElementById('loading')?.classList.contains('done'), null, { timeout: 240_000 });
    await page.evaluate(async () => { const s = window.__skyline; if (s.attractions) { await s.attractions.ready; s.attractions.freeze(47); } await s.flight.ready; });
    current = null;
  };
  const retry = async (fn) => {
    for (let k = 0; ; k++) {
      try { return await fn(); } catch (e) {
        if (k >= 3 || !/context was destroyed|navigation|Fly is not active|Target closed/i.test(String(e?.message))) throw e;
        console.log('reloaded:', String(e.message).slice(0, 80));
        await reloaded();
      }
    }
  };
  for (const m of MOMENTS) {
    if (only && !only.includes(m.key)) continue;
    await retry(async () => { if (current !== m.flight) {
      await page.evaluate(async (fid) => { const f = window.__skyline.flight; await f.start(fid, { pace: false, play: false }); f.options({ hud: false }); }, m.flight);
      if (guardSource) await terms();
      current = m.flight;
    } });
    const at = await retry(() => page.evaluate(({ m }) => {
      const s = window.__skyline.flight, st = s.state();
      if (Number.isFinite(m.at)) return m.at;
      if (m.sixty) return st.touchdownT - 60;
      if (m.rollout) return Math.min(st.durationS - 1, st.touchdownT + 20);
      return null;
    }, { m }));
    for (const v of VIEWS) {
      if (onlyViews && !onlyViews.includes(v.name)) continue;
      const shot = await retry(async () => {
      if (current !== m.flight) {
        await page.evaluate(async (fid) => { const f = window.__skyline.flight; await f.start(fid, { pace: false, play: false }); f.options({ hud: false }); }, m.flight);
        if (guardSource) await terms();
        current = m.flight;
      }
      const r = await page.evaluate(async ({ v, m, at, measureCost }) => {
        const s = window.__skyline, f = s.flight;
        if (f.state().seat !== v.seat) f.setSeat(v.seat);
        // the seat's own default look (the window centred, the lean toward it), then the view's changes over it
        const { defaultLook } = await import('/src/flight/cabin/headRig.js');
        const { seat: seatOf } = await import('/src/flight/cabin/lopa.js');
        const home = defaultLook(seatOf(v.seat));
        const add = v.look || {};
        f.look({ ...home, lens: 26, ...add, yaw: home.yaw + (add.yaw ?? 0), pitch: home.pitch + (add.pitch ?? 0) });
        if (Number.isFinite(at)) await f.seek({ at }); else await f.seek({ chapter: m.chapter });
        f.shade(v.shade ?? 0); f.shade(v.shade ?? 0); // twice: at once
        await f.whenSettled();
        await f.whenSettled();
        let tp = null, tpOff = null;
        if (measureCost) {
          tp = await s.perf.throughput(40, 8);
          f.options({ stage: false }); tpOff = await s.perf.throughput(40, 8); f.options({ stage: true }); await s.perf.throughput(4, 2);
          await f.whenSettled();
        }
        const st = f.stats();
        return {
          t: f.state().t, altFt: Math.round(f.state().altMsl * 3.28084), sunAltDeg: s.env.state?.sun?.altDeg ?? null,
          exposure: s.env?.nodes?.exposure?.value ?? null, adaptation: st.cabinStage?.adaptation ?? null, priorTerms: s.look?.current?.priorTerms ?? null, cabinLight: st.cabinLight ?? null,
          stage: st.cabinStage, cabinTriangles: st.cabinStage?.triangles ?? null, stageDraws: st.cabinStage?.draws ?? null, cabinDrawCalls: st.cabinDrawCalls ?? null,
          msPerFrame: tp ? +tp.msPerFrame.toFixed(2) : null, msStageOff: tpOff ? +tpOff.msPerFrame.toFixed(2) : null,
        };
      }, { v, m, at, measureCost: cost && v.name === 'default' });
      await page.evaluate(hideUi);
      await page.evaluate(() => window.__skyline.flight.whenSettled());
      const name = `${m.label}_${v.name}`;
      const file = path.join(dir, `${name}.jpg`);
      const buf = await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
      await page.evaluate(showUi);
      const boxes = Object.fromEntries(Object.entries(v.regions).map(([k, [x, y]]) => [k, [((x + 1) / 2) * W, ((1 - y) / 2) * H]]));
      r.regions = await page.evaluate(boxesInPage, { b64: buf.toString('base64'), boxes, half: 15 });
      return { r, name };
      });
      const { r, name } = shot;
      r.moment = m.label; r.view = v.name;
      measure.rows.push(r);
      cells.push({ m: m.label, v: v.name, file: `${name}.jpg`, r });
      console.log(backend, name, JSON.stringify({ k: r.exposure, lift: r.adaptation?.liftEv, regions: r.regions, ms: r.msPerFrame, off: r.msStageOff, cpu: r.stage?.cpuMs }));
    }
  }
  const moments = [...new Set(cells.map((c) => c.m))], views = [...new Set(cells.map((c) => c.v))];
  const html = `<!doctype html><meta charset="utf-8"><title>cabin ${backend}</title><style>body{background:#111;color:#ddd;font:11px system-ui;margin:12px}td,th{vertical-align:top;padding:3px}img{width:300px;display:block}</style>
<table><tr><th></th>${views.map((v) => `<th>${v}</th>`).join('')}</tr>${moments.map((mm) => `<tr><th>${mm}</th>${views.map((v) => { const c = cells.find((x) => x.m === mm && x.v === v); return c ? `<td><img src="${c.file}"><div>${Object.entries(c.r.regions).map(([k, x]) => `${k} ${x}`).join(' · ')}${c.r.adaptation ? ` · lift ${c.r.adaptation.liftEv}` : ''}</div></td>` : '<td></td>'; }).join('')}</tr>`).join('\n')}</table>`;
  writeFileSync(path.join(dir, 'sheet.html'), html);
  const lines = ['| moment | view | k | lift EV | regions (sRGB mean) | ms/frame (stage off) | stage cpu ms |', '|---|---|---|---|---|---|---|'];
  for (const r of measure.rows) lines.push(`| ${r.moment} | ${r.view} | ${r.exposure?.toExponential(2)} | ${r.adaptation?.liftEv ?? '—'} | ${Object.entries(r.regions).map(([k, x]) => `${k} ${x}`).join(', ')} | ${r.msPerFrame ?? ''}${r.msStageOff != null ? ` (${r.msStageOff})` : ''} | ${r.stage?.cpuMs ?? ''} |`);
  writeFileSync(path.join(dir, 'table.md'), lines.join('\n') + '\n');
  measure.problems = problems;
  writeFileSync(path.join(dir, 'measure.json'), JSON.stringify(measure, null, 1));
  if (problems.length) console.log(backend, 'console problems', problems.slice(0, 12));
  await page.close();
}
await browser.close();

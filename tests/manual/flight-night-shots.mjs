// Pictures and measurements of the night ground from the air (plan 03, F6.3, F6.4, sections 7.11, 7.14, 9.1) in the
// running app on this machine's GPU. For the dusk and night flights (or those named with --flights): cruise, through
// 18,000 ft, through 10,000 ft, the turn to final (the largest bank between 10,000 ft and 1,000 ft above the runway),
// 60 s out, the threshold and the rollout (20 s after touchdown). At each, a picture of the clean view (no cabin, no
// window frame), one through the window, and one clean from the same row's seat on the other side, which looks toward
// the city on these arrivals (--views clean,window,other), the renderer's draw calls and triangles, the frame
// time (perf.throughput: frames drawn back to back, not capped by vsync) with and without the night ground (its group
// hidden for the second measurement: the difference is what it costs the GPU), and the night ground's own counts
// (world.stats().ground: lamps drawn, draws, its CPU time).
// Writes <out>/<backend>/<flight>_<moment>_<view>.jpg, <out>/<backend>/measure.json and a contact sheet per flight and
// view, <out>/<backend>/sheet_<flight>_<view>.html (open it in a browser; it lays the pictures out in a grid).
//
// Serve the app first (a dev server or a build):
//   pnpm exec vite --port 5421 --strictPort
//   or: pnpm build --outDir dist-n1 && pnpm exec vite preview --outDir dist-n1 --port 5421 --strictPort
// then:
//   node tests/manual/flight-night-shots.mjs <out> [--port 5421] [--backend webgpu|webgl2]
//     [--flights lv-19-dusk,lv-19-night,lv-26-night] [--moments cruise,threshold] [--views clean,window] [--size 1280x800]
// From a normal shell on macOS (a sandboxed one gives the browser software rendering).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const VALUED = ['--port', '--backend', '--flights', '--moments', '--views', '--size'];
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const out = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
if (!out) {
  console.error('usage: node tests/manual/flight-night-shots.mjs <out> [--port 5421] [--backend webgpu|webgl2] [--flights a,b] [--moments a,b] [--views clean,window] [--size 1280x800]');
  process.exit(2);
}
const port = opt('--port') || 5421;
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu', 'webgl2'];
const DIR = 'public/data/lv/flights';
const ids = opt('--flights') ? opt('--flights').split(',') : ['lv-19-dusk', 'lv-19-night', 'lv-26-night'];
const onlyMoments = opt('--moments') ? opt('--moments').split(',') : null;
const views = opt('--views') ? opt('--views').split(',') : ['clean', 'window', 'other'];
const [W, H] = (opt('--size') || '1280x800').split('x').map(Number);
const ORDER = ['cruise', 'fl180', 'ft10000', 'turn', 'sixty-out', 'threshold', 'rollout'];

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
  const m = { cruise: 0, fl180: ev('fl180'), ft10000: ev('10000'), turn, 'sixty-out': td - 60, threshold: ev('threshold'), rollout: Math.min(header.samples - 1, td + 20) };
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => Number.isFinite(v) && (!onlyMoments || onlyMoments.includes(k))));
}

function sheet(dir, id, view, names, measures) {
  const cells = names.map((n) => {
    const r = measures[n] || {};
    const g = r.ground;
    const line = [`${n}`, r.altMsl != null ? `${Math.round(r.altMsl * 3.28084)} ft` : '', r.sunAltDeg != null ? `sun ${r.sunAltDeg.toFixed(1)}°` : '',
      r.msPerFrame != null ? `${r.msPerFrame} ms (${r.msWithoutNightGround ?? '?'} without)` : '', r.drawCalls != null ? `${r.drawCalls} draws` : '',
      g ? `${g.drawn ?? '?'} lamps drawn, ${g.draws ?? '?'} ground draws` : ''].filter(Boolean).join(' · ');
    return `<figure><img src="${id}_${n}_${view}.jpg"><figcaption>${line}</figcaption></figure>`;
  }).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>${id} ${view}</title>
<style>body{background:#111;color:#ddd;font:12px system-ui;margin:12px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:8px}
figure{margin:0}img{width:100%;display:block}figcaption{padding:2px 0}</style><h1>${id} — ${view}</h1><main>${cells}</main>`;
  writeFileSync(path.join(dir, `sheet_${id}_${view}.html`), html);
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
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/flights\/[\w-]+\.jpg/.test(m.location()?.url || '')) problems.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`); });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* */ } });
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && window.__skyline.attractions && document.getElementById('loading').classList.contains('done'), null, { timeout: 240_000 });
  await page.evaluate(async () => { const s = window.__skyline; await s.attractions.ready; s.attractions.freeze(47); await s.flight.ready; });
  const gpu = await page.evaluate(() => window.__skyline.perf.gpu());
  console.log(backend, JSON.stringify(gpu));
  if (gpu.backend !== backend) throw new Error(`asked for ${backend}, drawing on ${gpu.backend}`);
  const measure = { backend, gpu, size: [W, H], date: new Date().toISOString(), flights: {} };

  for (const id of ids) {
    const moments = momentsOf(id);
    measure.flights[id] = {};
    const seat = await page.evaluate(async (fid) => { const f = window.__skyline.flight; await f.start(fid, { pace: false, play: false }); f.options({ hud: false }); return f.state().seat; }, id);
    const otherSide = seat.replace(/[A-Z]$/, (c) => (c <= 'C' ? 'F' : 'A'));
    for (const [name, at] of Object.entries(moments)) {
      for (const view of views) {
        const r = await page.evaluate(async ({ at, clean, seatId }) => {
          const s = window.__skyline, f = s.flight;
          if (f.state().seat !== seatId) f.setSeat(seatId);
          f.options({ frame: !clean });
          await f.seek({ at });
          await f.whenSettled();
          await f.whenSettled();
          const info = s.perf.info();
          const tp = await s.perf.throughput(40, 8);
          // what the night ground costs the GPU: the same frame without it (its group hidden for the measurement)
          const g = s.scene.getObjectByName('flight-night-ground');
          let without = null;
          if (g && g.visible) { g.visible = false; without = await s.perf.throughput(40, 8); g.visible = true; await s.perf.throughput(4, 2); }
          const st = f.state(), stats = f.stats();
          const w = stats.world || {};
          return {
            t: st.t, altMsl: Math.round(st.altMsl), heightAboveGround: +st.heightAboveGround.toFixed(1), headingDeg: +st.headingDeg.toFixed(1),
            drawCalls: info.calls, triangles: info.triangles, msPerFrame: +tp.msPerFrame.toFixed(2),
            msWithoutNightGround: without ? +without.msPerFrame.toFixed(2) : null,
            region: w.region && { triangles: w.region.triangles, drawCalls: w.region.drawCalls },
            airport: w.airport && { drawCalls: w.airport.drawCalls, lights: w.airport.lights, night: w.airport.night },
            ground: w.ground ?? null,
            sunAltDeg: s.env.state?.sun?.altDeg ?? null,
          };
        }, { at, clean: view !== 'window', seatId: view === 'other' ? otherSide : seat });
        await page.evaluate(hideUi);
        await page.evaluate(() => window.__skyline.flight.whenSettled());
        const buf = await page.screenshot({ path: path.join(dir, `${id}_${name}_${view}.jpg`), type: 'jpeg', quality: 88 });
        if (buf.length < 4000) console.log(backend, id, name, view, 'BLANK FRAME');
        await page.evaluate(showUi);
        (measure.flights[id][view] ??= {})[name] = r;
        console.log(backend, id, name, view, JSON.stringify(r));
      }
    }
    for (const view of views) sheet(dir, id, view, ORDER.filter((n) => n in moments), measure.flights[id][view] || {});
    await page.evaluate(() => window.__skyline.flight.options({ frame: true, hud: true }));
  }
  measure.problems = problems;
  writeFileSync(path.join(dir, 'measure.json'), JSON.stringify(measure, null, 1));
  if (problems.length) console.log(backend, 'console problems', problems.slice(0, 20));
  await page.close();
}
await browser.close();

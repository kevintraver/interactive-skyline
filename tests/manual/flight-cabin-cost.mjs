// The cabin stage's cost on this machine's GPU (the cabin pass of 25 Nov 2026): at a few moments, from 23F at the
// default look, frames drawn back to back (perf.throughput) with the cabin stage on and off, alternated `--rounds`
// times; the medians and their difference (the stage's cost), and the stage's own CPU time per draw.
//   node tests/manual/flight-cabin-cost.mjs [--port 5481] [--backend webgpu|webgl2] [--rounds 5]
// From a normal shell on macOS. Other work on the machine inflates both numbers alike; the difference is what counts.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const port = opt('--port') || 5481, backend = opt('--backend') || 'webgpu', rounds = Number(opt('--rounds') || 5);
const MOMENTS = [['lv-19-day', { chapter: '10000' }, 'day-10000'], ['lv-19-night', { sixty: true }, 'night-final']];
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* */ } });
await page.goto(`http://localhost:${port}/?city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`);
await page.waitForFunction(() => window.__skyline?.flight && document.getElementById('loading').classList.contains('done'), null, { timeout: 240_000 });
await page.evaluate(async () => { const s = window.__skyline; if (s.attractions) { await s.attractions.ready; s.attractions.freeze(47); } await s.flight.ready; });
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
for (const [id, where, label] of MOMENTS) {
  const r = await page.evaluate(async ({ id, where, rounds }) => {
    const s = window.__skyline, f = s.flight;
    await f.start(id, { pace: false, play: false });
    f.options({ hud: false });
    const at = where.sixty ? f.state().touchdownT - 60 : null;
    await f.seek(at != null ? { at } : where);
    await f.whenSettled();
    await s.perf.throughput(30, 5);
    const on = [], off = [], cpu = [];
    for (let k = 0; k < rounds; k++) {
      f.options({ stage: true }); await s.perf.throughput(6, 2);
      on.push((await s.perf.throughput(60, 8)).msPerFrame); cpu.push(f.stats().cabinStage.lastMs);
      f.options({ stage: false }); await s.perf.throughput(6, 2);
      off.push((await s.perf.throughput(60, 8)).msPerFrame);
    }
    f.options({ stage: true });
    const st = f.stats().cabinStage;
    return { on, off, cpu, triangles: st.triangles, draws: st.draws };
  }, { id, where, rounds });
  console.log(JSON.stringify({ backend, label, onMs: +med(r.on).toFixed(2), offMs: +med(r.off).toFixed(2), stageMs: +(med(r.on) - med(r.off)).toFixed(2),
    stageCpuMs: +med(r.cpu).toFixed(2), triangles: r.triangles, draws: r.draws, on: r.on.map((x) => +x.toFixed(2)), off: r.off.map((x) => +x.toFixed(2)) }));
}
await browser.close();

// Cost of the weather part on the classic renderer and on plan 01's renderer (both backends), in one run (plan 02,
// phase 8; third stretch): GPU-bound frame time by throughput (window.__skyline.perf.throughput: frames drawn back to
// back, the same method on every renderer), clean camera at 1280 x 720 on I-15 at km 60 by night, the drive paused:
//   off    ?parts=none                     the drive without the part
//   dry    ?parts=weather, clear           nothing should be measurable against off
//   light, heavy                           1 and 12 mm/h
// and the first rain's hitch: the drive playing, dry since the page loaded, then heavy rain; the longest frame interval
// in the two seconds after, against the median before. With --nowarm also with ?weathertest=nowarm (nothing built
// ahead), to show what building ahead saves. Prints the machine's load average with every row: on a shared machine
// the numbers are only as good as the load is low.
// No weather service is reached (the hosts do not resolve; /api/weather answers 503); the rain is the drive's shorthand.
// Serve the repository (pnpm exec vite --port 5324 --strictPort), then:
//   node tests/manual/rain-node-budget.mjs [--port 5324] [--renderers classic,webgl,webgpu] [--nowarm] [--hitch (the hitch only)] [--frames 60]
import { chromium } from '@playwright/test';
import { loadavg } from 'node:os';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', 5324)), frames = Number(opt('frames', 60));
const renderers = opt('renderers', 'classic,webgl,webgpu').split(',');
const nowarm = args.includes('--nowarm'), hitchOnly = args.includes('--hitch');
const Q = { classic: 'renderer=legacy', webgl: 'renderer=webgpu&backend=webgl', webgpu: 'renderer=webgpu&backend=webgpu' };
const AT = { route: 'i15n', s: 60000, t: Date.parse('2026-11-22T02:30:00Z') };
const load = () => loadavg().map((v) => v.toFixed(0)).join(' ');

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
  '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'] });

async function open(q) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.route(/\/api\/weather/, (r) => r.fulfill({ status: 503, body: '' }));
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.goto(`http://localhost:${port}/?city=lv&${q}`, { timeout: 600000 });
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 600000 });
  await page.evaluate(async (AT) => {
    const sk = window.__skyline, d = sk.drive;
    sk.attractions?.freeze?.(20); await sk.attractions?.ready;
    await d.start(AT.route, { s: AT.s, t: AT.t, view: 'clean' });
    d.pause(); d.setView('clean'); d.seek({ s: AT.s, t: AT.t }); d.look({ yaw: 0, pitch: -2, lens: 35 });
    await d.whenSettled();
  }, AT);
  return page;
}

const part = () => { let w = null; window.__skyline.scene.traverse((o) => { if (o.userData?.weatherPart) w = o.userData.weatherPart; }); return w; };

/** Throughput (ms a frame) with the given rain, three batches, the median. */
async function time(page, rain, n) {
  return page.evaluate(async ({ rain, n, AT, partSrc }) => {
    const sk = window.__skyline, d = sk.drive;
    const find = new Function(`return (${partSrc})()`);
    let w = null;
    for (let i = 0; i < 300 && rain !== null && !w; i++) { w = find(); if (!w) await new Promise((r) => setTimeout(r, 100)); }
    if (w) { if (typeof rain === 'string') w.setPreset(rain); else w.setRain(rain); await w.whenApplied(); }
    d.seek({ s: AT.s, t: AT.t }); await d.whenSettled();
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    const b = [];
    for (let k = 0; k < 3; k++) b.push((await sk.perf.throughput(n, 10)).msPerFrame);
    b.sort((x, y) => x - y);
    return { ms: +b[1].toFixed(3), batches: b.map((x) => +x.toFixed(3)), drops: w?.stats().drops ?? 0 };
  }, { rain, n, AT, partSrc: part.toString() });
}

/**
 * The first rain while playing: the programs (classic) or render pipelines (plan 01's renderer) three creates for it,
 * 0 when everything was built ahead (a count, so it does not depend on the machine's load), the long tasks (over 50
 * ms) in the two seconds after it against the same time before, and the worst frame interval either side.
 */
async function hitch(page) {
  return page.evaluate(async ({ partSrc }) => {
    const sk = window.__skyline, d = sk.drive, r = sk.renderer;
    const w = new Function(`return (${partSrc})()`)();
    const programs = () => (r.isWebGPURenderer ? r._pipelines?.caches?.size ?? NaN : r.info.programs?.length ?? NaN);
    const long = [];
    const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push([e.startTime, e.duration]); });
    try { obs.observe({ type: 'longtask', buffered: false }); } catch { /* none */ }
    d.play();
    const iv = [];
    let last = performance.now(), mark = -1, markT = 0, before = 0;
    await new Promise((done) => {
      const t0 = performance.now();
      const tick = (t) => {
        iv.push(t - last); last = t;
        if (mark < 0 && t - t0 > 3000) { mark = iv.length; markT = performance.now(); before = programs(); w.setPreset('heavy'); }
        if (t - t0 > 5500) done(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    d.pause();
    obs.disconnect();
    const pre = iv.slice(5, mark).sort((a, b) => a - b), post = iv.slice(mark);
    const sum = (from, to) => +long.filter(([t]) => t >= from && t < to).reduce((a, [, dur]) => a + dur, 0).toFixed(0);
    return { newPrograms: programs() - before, longTaskMsAfter: sum(markT, markT + 2000), longTaskMsBefore: sum(markT - 2000, markT),
      worstAfter: +Math.max(...post).toFixed(1), worstBefore: +pre[pre.length - 1].toFixed(1), medianBefore: +pre[pre.length >> 1].toFixed(1),
      wetAfter: w.state().wetness > 0.9 };
  }, { partSrc: part.toString() });
}

const rows = [];
for (const r of renderers) {
  if (!hitchOnly) {
  const off = await open(`${Q[r]}&parts=none`);
  const tOff = await time(off, null, frames);
  await off.close();
  const on = await open(`${Q[r]}&parts=weather`);
  const dry = await time(on, 0, frames), light = await time(on, 'light', frames), heavy = await time(on, 'heavy', frames);
  await on.close();
  const row = { renderer: r, off: tOff.ms, dry: dry.ms, light: light.ms, heavy: heavy.ms, drops: heavy.drops, load: load() };
  console.log(JSON.stringify(row)); rows.push(row);
  }
  for (const warm of nowarm ? [true, false] : [true]) {
    const p = await open(`${Q[r]}&parts=weather${warm ? '' : '&weathertest=nowarm'}`);
    await p.evaluate(() => new Promise((r) => setTimeout(r, 4000))); // idle time for building ahead
    const h = await hitch(p);
    await p.close();
    const hr = { renderer: r, firstRain: warm ? 'built ahead' : 'nothing built ahead (nowarm)', ...h, load: load() };
    console.log(JSON.stringify(hr)); rows.push(hr);
  }
}
await browser.close();

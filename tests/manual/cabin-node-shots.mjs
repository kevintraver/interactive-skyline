// Screenshots of the cabin on plan 01's renderer (plan 02, third stretch: the port of the cabin, mirrors, windshield and
// rain on the glass), for looking at: rain-shots.mjs's options on ?renderer=webgpu, in the shipped look by default.
// Serve the repository first, then:
//   node tests/manual/cabin-node-shots.mjs <out-dir outside the repo> <port> [backend webgpu|webgl] [display shipped|classic]
//        ['<shots JSON>'] [width] [height]
// <shots> is JSON: [[name, route, s in metres, "day" | "night" | ISO time, { view, yaw, pitch, lens, reduceMotion, glance,
//   veil, mirrors, rain (mm/h), dt (seconds on from the time), toggle (true: C to the clean view and back first) }?], ...]
// Without <shots> the default set runs: each route by day, at dusk into a low sun, at night, in light rain and in heavy
// rain with the wipers mid-sweep, the C toggle and back, a glance left and right, Reduce motion on.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const [out, port = 5323, backend = 'webgpu', display = 'shipped', shotsArg, w = '1280', h = '720'] = process.argv.slice(2);
if (!out) { console.error('usage: cabin-node-shots.mjs <out-dir> <port> [backend] [display] [shots] [width] [height]'); process.exit(2); }
const width = +w, height = +h;
mkdirSync(out, { recursive: true });
const DAY = '2026-11-21T20:30:00Z', DUSK = '2026-11-22T00:22:00Z', NIGHT = '2026-11-22T05:00:00Z';
const ROUTES = [['i15n', 45000], ['us93', 25500], ['i15s', 36500]];
const DEFAULT = ROUTES.flatMap(([r, s]) => [
  [`${r}-day`, r, s, DAY], [`${r}-dusk`, r, s, DUSK], [`${r}-night`, r, s, NIGHT],
  [`${r}-light-rain`, r, s, DAY, { rain: 1 }], [`${r}-heavy-rain`, r, s, DUSK, { rain: 12, dt: 0.35 }],
]).concat([
  ['i15n-night-heavy-rain', 'i15n', 45000, NIGHT, { rain: 12, dt: 0.5 }],
  ['us93-dusk-into-sun', 'us93', 25500, DUSK, { yaw: 35 }],
  ['i15n-toggle', 'i15n', 45000, DAY, { toggle: true }],
  ['i15n-glance-left', 'i15n', 45000, DAY, { glance: 'left' }], ['i15n-glance-right', 'i15n', 45000, DAY, { glance: 'right' }],
  ['i15n-reduce-motion', 'i15n', 45000, DUSK, { reduceMotion: true }],
]);
const shots = shotsArg ? JSON.parse(shotsArg) : DEFAULT;

const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));
await page.routeWebSocket(/.*/, () => {}); // other work in the checkout must not reload the page
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
const q = `city=lv&renderer=webgpu&backend=${backend}${display === 'classic' ? '&display=classic' : ''}&parts=cabin`;
await page.goto(`http://localhost:${port}/?${q}`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 180000 });
const info = await page.evaluate(async () => { const s = window.__skyline; s.attractions?.freeze(20); await s.attractions?.ready; return s.rendererInfo; });
console.log('renderer:', JSON.stringify(info));

const log = [];
for (const [name, route, s, when, opt = {}] of shots) {
  const r = await page.evaluate(async ({ route, s, t, opt }) => {
    const d = window.__skyline.drive;
    try {
      if (!d.active() || d.route()?.id !== route) await d.start(route, { s, t, view: 'cabin' });
      await new Promise((res) => { const f = () => (d.cabin() ? res() : setTimeout(f, 100)); f(); });
      d.pause();
      const c = d.cabin();
      c.weather?.setRain?.(opt.rain || 0);
      d.setView(opt.view || 'cabin');
      d.setReduceMotion(!!opt.reduceMotion);
      c.glass?.windshield?.setEnabled(opt.veil !== false);
      c.glass?.mirrors?.setEnabled(opt.mirrors !== false);
      d.seek({ s, t });
      if (opt.dt) d.seek({ t: t + opt.dt * 1000 });
      d.look({ yaw: opt.yaw ?? 0, pitch: opt.pitch ?? 0, ...(opt.lens ? { lens: opt.lens } : {}) });
      if (opt.toggle) { d.setView('clean'); d.renderFrame(); d.setView('cabin'); }
      const settled = await Promise.race([d.whenSettled().then(() => true), new Promise((res) => setTimeout(() => res(false), 60000))]);
      // the weather service answers asynchronously: give the rain a few frames to arrive
      for (let i = 0; i < 20 && opt.rain && !c.glass?.rain?.raining; i++) await new Promise((res) => setTimeout(res, 100));
      if (opt.glance) { d.glance(opt.glance); await new Promise((res) => setTimeout(res, 600)); }
      for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
      const p = d.pose(), st = c.stats();
      return { settled, s: Math.round(p.s), sun: +p.sunElevation.toFixed(1), view: p.view, model: st.model, level: st.level, depth: st.depth,
        display: st.displayScale, mask: st.meteringMask, rain: st.rain && { raining: st.rain.raining, mode: st.rain.mode, drawn: st.rain.drawn },
        wiper: c.glass?.rain?.state ? (({ mode, angle, dropCount }) => ({ mode, angle: +angle.toFixed(1), dropCount }))(c.glass.rain.state()) : null,
        veil: st.windshield && { S: +(+st.windshield.scenePerLux).toPrecision(3), sunLux: Math.round(st.windshield.sunLux), bloomVeil: st.windshield.bloomVeil } };
    } catch (e) { return { error: String(e && e.stack ? e.stack : e) }; }
  }, { route, s, t: Date.parse(when), opt });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, JSON.stringify(r));
  log.push({ name, ...r });
}
writeFileSync(`${out}/shots.json`, JSON.stringify(log, null, 1));
if (problems.length) console.log(`page said:\n  ${[...new Set(problems)].slice(0, 20).join('\n  ')}`);
await browser.close();

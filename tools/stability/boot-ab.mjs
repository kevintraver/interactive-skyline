// Time to ready, first frame and edit latency: the classic renderer against the new one, alternating, same browser.
//   node tools/stability/boot-ab.mjs <baseUrl> [rounds]
//   node tools/stability/boot-ab.mjs <baseUrl> [rounds] --cpu    CPU per submitted frame instead, on the ten scenes
//
// Edits are timed from the call to the first frame the app's loop draws after it (hide, undo, move as a drag does it,
// a cutoff rebuild, and the synchronous part of the rebuild alone). --cpu stages each scene of the baselines (every
// view, day and night, the shows held at 47 s, the exposure settled), then draws one frame per animation frame, 150
// times, and takes the median wall time of the draw call itself (pipeline.render() on the new renderer, which is
// renderer.render(scene, camera) on the classic one): what the main thread spends submitting a frame when nothing in
// the scene changes, with the GPU never waited on (one frame per animation frame, so no back-pressure). The exposure
// meter's work after a frame (look.afterRender()) is reported apart, as `meter`.
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');

const args = process.argv.slice(2);
const CPU = args.includes('--cpu');
const [base, roundsArg] = args.filter((a) => !a.startsWith('--'));
const ROUNDS = Number(roundsArg || 4);
const VARIANTS = { classic: 'renderer=legacy&nobench=1', webgl2: 'backend=webgl&nobench=1&q=high', webgpu: 'backend=webgpu&nobench=1&q=high' };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const EDIT = async () => {
  const s = window.__skyline;
  const nextFrames = (n) => new Promise((done) => { const step = () => (n-- <= 0 ? done() : requestAnimationFrame(step)); requestAnimationFrame(step); });
  const timed = async (action) => {
    await nextFrames(3);
    const target = s.perf.frames() + 1, t0 = performance.now();
    action();
    await new Promise((done) => { const check = () => (s.perf.frames() >= target ? done() : requestAnimationFrame(check)); requestAnimationFrame(check); });
    return performance.now() - t0;
  };
  const out = { hide: [], undo: [], move: [], rebuild: [], rebuildSync: [] };
  const cutoff = s.settings.cutoff;
  const undo = () => dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true }));
  for (let i = 0; i < 4; i++) {
    const e = s.tall[2 + i];
    s.select(e.data.id);
    out.hide.push(await timed(() => document.querySelector('#card [data-act="hide"]').click()));
    out.undo.push(await timed(undo));
    // as a drag does: place, redraw the shadows, ask for a frame
    out.move.push(await timed(() => { s.place(e, 40, -30); s.renderer.shadowMap.needsUpdate = true; s.invalidate(); }));
    s.place(e, 0, 0);
    await nextFrames(3);
    // the synchronous part of a cutoff change alone, then the whole change to the next frame
    const t0 = performance.now();
    s.setSetting('cutoff', cutoff + 5 + i);
    out.rebuildSync.push(performance.now() - t0);
    s.setSetting('cutoff', cutoff);
    await nextFrames(3);
    out.rebuild.push(await timed(() => s.setSetting('cutoff', cutoff + 5 + i)));
    s.setSetting('cutoff', cutoff);
  }
  return out;
};

// --cpu: in the page, the scene staged; CPU per submitted frame
const FRAME_CPU = async () => {
  const s = window.__skyline, raf = () => new Promise((d) => requestAnimationFrame(d));
  const draw = [], meter = [];
  for (let i = 0; i < 150; i++) {
    await raf();
    const t0 = performance.now();
    s.pipeline.render();
    const t1 = performance.now();
    if (s.look) s.look.afterRender();
    if (i >= 30) { draw.push(t1 - t0); meter.push(performance.now() - t1); }
  }
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  return { draw: med(draw), meter: med(meter) };
};
const STAGE = async ({ view, night }) => {
  const s = window.__skyline, raf = () => new Promise((d) => requestAnimationFrame(d));
  s.attractions.freeze(47); s.setSetting('night', night); s.setView(view);
  s.renderer.shadowMap.needsUpdate = true; s.invalidate();
  for (let i = 0; i < 4; i++) await raf();
  const t0 = performance.now();
  while (s.look && !s.look.exposure.state.settled && performance.now() - t0 < 60000) await raf();
  for (let i = 0; i < 4; i++) await raf();
};

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const res = {};
if (CPU) {
  // the baseline scenes (tests/helpers/app.js: every view of data/cities.json, day and night)
  const VIEWS = { lv: ['east', 'strat', 'aerial'], slc: ['ensign', 'aerial'] };
  const cpu = {};
  for (const city of ['lv', 'slc']) {
    const pages = {};
    for (const v of Object.keys(VARIANTS)) {
      const page = pages[v] = await ctx.newPage();
      await page.goto(`${base}/?city=${city}&${VARIANTS[v]}`);
      await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
      await page.evaluate(() => window.__skyline.attractions.ready);
    }
    for (const view of VIEWS[city]) for (const look of ['day', 'night']) {
      const scene = `${city}-${view}-${look}`;
      for (const v of Object.keys(VARIANTS)) await pages[v].evaluate(STAGE, { view, night: look === 'night' });
      for (let r = 0; r < ROUNDS; r++) {
        const order = r % 2 ? Object.keys(VARIANTS).reverse() : Object.keys(VARIANTS);
        for (const v of order) {
          const m = await pages[v].evaluate(FRAME_CPU);
          ((cpu[scene] ||= {})[v] ||= { draw: [], meter: [] }).draw.push(m.draw);
          cpu[scene][v].meter.push(m.meter);
        }
      }
    }
    for (const p of Object.values(pages)) await p.close();
  }
  await browser.close();
  console.log(`CPU per submitted frame, ms (median of ${ROUNDS} rounds of the median of 120 frames): draw call [meter after it]`);
  console.log(`${'scene'.padEnd(18)} ${Object.keys(VARIANTS).map((v) => v.padStart(16)).join('')}`);
  for (const [scene, o] of Object.entries(cpu)) {
    console.log(`${scene.padEnd(18)} ${Object.keys(VARIANTS).map((v) => `${median(o[v].draw).toFixed(2)} [${median(o[v].meter).toFixed(2)}]`.padStart(16)).join('')}`);
  }
  console.log(JSON.stringify(cpu));
  process.exit(0);
}
for (const city of ['lv', 'slc']) {
  for (let r = 0; r <= ROUNDS; r++) {
    const order = r % 2 ? Object.keys(VARIANTS).reverse() : Object.keys(VARIANTS);
    for (const v of order) {
      const page = await ctx.newPage();
      await page.goto(`${base}/?city=${city}&${VARIANTS[v]}`);
      await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
      await page.evaluate(() => window.__skyline.attractions.ready);
      await page.waitForFunction(() => performance.getEntriesByName('skyline-frame').length > 0, null, { timeout: 180000 });
      const t = await page.evaluate(() => ({
        ready: performance.getEntriesByName('skyline-ready')[0].startTime,
        frame: performance.getEntriesByName('skyline-frame')[0].startTime,
        backend: window.__skyline.backend || 'webgl (classic)',
      }));
      await page.evaluate(() => window.__skyline.attractions.freeze(47));
      const e = await page.evaluate(EDIT);
      await page.close();
      if (r === 0) continue; // the first round warms the HTTP cache
      const k = `${city} ${v}`;
      (res[k] ||= { backend: t.backend, ready: [], frame: [], hide: [], undo: [], move: [], rebuild: [], rebuildSync: [] });
      res[k].ready.push(t.ready); res[k].frame.push(t.frame);
      for (const m of ['hide', 'undo', 'move', 'rebuild', 'rebuildSync']) res[k][m].push(median(e[m]));
    }
  }
}
await browser.close();
const row = (k, o) => `${k.padEnd(12)} ${String(o.backend).padEnd(16)} ready ${median(o.ready).toFixed(0).padStart(5)} ms  first frame ${median(o.frame).toFixed(0).padStart(5)} ms  hide ${median(o.hide).toFixed(1).padStart(6)} ms  undo ${median(o.undo).toFixed(1).padStart(6)} ms  move ${median(o.move).toFixed(1).padStart(6)} ms  rebuild ${median(o.rebuild).toFixed(0).padStart(5)} ms (sync ${median(o.rebuildSync).toFixed(0)} ms)`;
for (const [k, o] of Object.entries(res)) console.log(row(k, o));
console.log(JSON.stringify(res));

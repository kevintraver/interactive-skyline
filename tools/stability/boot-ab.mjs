// Time to ready, first frame and edit latency: the classic renderer against the new one, alternating, same browser.
//   node tools/stability/boot-ab.mjs <baseUrl> [rounds]
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');

const [base, roundsArg] = process.argv.slice(2);
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
  const out = { hide: [], rebuild: [], rebuildSync: [] };
  const cutoff = s.settings.cutoff;
  for (let i = 0; i < 4; i++) {
    const e = s.tall[2 + i];
    s.select(e.data.id);
    out.hide.push(await timed(() => document.querySelector('#card [data-act="hide"]').click()));
    dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true }));
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

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const res = {};
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
      (res[k] ||= { backend: t.backend, ready: [], frame: [], hide: [], rebuild: [], rebuildSync: [] });
      res[k].ready.push(t.ready); res[k].frame.push(t.frame);
      res[k].hide.push(median(e.hide)); res[k].rebuild.push(median(e.rebuild)); res[k].rebuildSync.push(median(e.rebuildSync));
    }
  }
}
await browser.close();
const row = (k, o) => `${k.padEnd(12)} ${String(o.backend).padEnd(16)} ready ${median(o.ready).toFixed(0).padStart(5)} ms  first frame ${median(o.frame).toFixed(0).padStart(5)} ms  hide ${median(o.hide).toFixed(1).padStart(6)} ms  rebuild ${median(o.rebuild).toFixed(0).padStart(5)} ms (sync ${median(o.rebuildSync).toFixed(0)} ms)`;
for (const [k, o] of Object.entries(res)) console.log(row(k, o));
console.log(JSON.stringify(res));

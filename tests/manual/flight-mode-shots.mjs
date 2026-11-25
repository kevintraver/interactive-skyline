// Screenshots of Fly mode in the running app on this machine's GPU (plan 03, F1.4): the map before, the picker, then
// the flight at the start of playback, mid-descent, in the turn to final, one minute out, at touchdown and on the
// rollout, by day and at night (the departure moved to 21:00), plus the flight's bar; and the mode's own per-frame
// JavaScript time while playing. Writes <prefix><backend>_<name>.png and timing.json into <out-dir>.
//
// Serve the repo first:   pnpm exec vite --port 5341 --strictPort
// then:                   node tests/manual/flight-mode-shots.mjs <out-dir> [port] [--backend webgpu|webgl2] [--synthetic] [--only day|night]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { syntheticIndex } from '../helpers/flight.js';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--backend', '--only'].includes(args[i - 1]));
const out = positional[0];
const port = positional[1] || 5341;
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu', 'webgl2'];
const synthetic = args.includes('--synthetic');
const looks = opt('--only') ? [opt('--only')] : ['day', 'night'];
if (!out) { console.error('usage: node tests/manual/flight-mode-shots.mjs <out-dir> [port] [--backend webgpu|webgl2] [--synthetic]'); process.exit(2); }
mkdirSync(out, { recursive: true });
const prefix = synthetic ? 'synthetic_' : '';

// the track, read here to find the moments: the turn to final is where the bank is largest before the last minute
const dir = synthetic ? 'tests/fixtures/flight' : 'public/data/lv/flights';
const id = synthetic ? 'synthetic-19' : 'lv-19-day';
const header = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
const bin = new Float32Array(readFileSync(path.join(dir, `${id}.bin`)).buffer.slice(0));
const ch = (name) => { const k = header.channels.indexOf(name); return bin.subarray(k * header.samples, (k + 1) * header.samples); };
const ev = (k) => header.events.find((e) => e.id === k)?.t;
const td = ev('touchdown');
const start = ev('terrain') ?? 0;
const roll = ch('roll');
let turn = start, best = 0;
for (let i = Math.ceil(start); i < td - 60; i++) if (Math.abs(roll[i]) > best) { best = Math.abs(roll[i]); turn = i; }
const MOMENTS = { start, middescent: start + (turn - start) / 2, turn, oneminute: td - 60, touchdown: td, rollout: Math.min(header.samples - 1, td + 20) };
console.log(id, JSON.stringify(MOMENTS), `max bank ${best.toFixed(1)} deg`);

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const timing = {};
for (const backend of backends) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  if (synthetic) {
    await page.route('**/data/lv/flights/**', (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      if (name === 'index.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticIndex()) });
      return route.fulfill({ body: readFileSync(path.join(dir, name)) });
    });
  }
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* */ } });
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && window.__skyline.attractions && document.getElementById('loading').classList.contains('done'), null, { timeout: 240_000 });
  await page.evaluate(async () => { const s = window.__skyline; await s.attractions.ready; s.attractions.freeze(47); await s.flight.ready; s.setView('aerial'); });
  await page.waitForTimeout(1500);
  const shot = (name, o) => page.screenshot({ path: path.join(out, `${prefix}${backend}_${name}.png`), ...o });
  await shot('map-before');
  await page.locator('#modes button[data-mode="flight"]').click();
  await page.waitForFunction(() => window.__skyline.flight.active(), null, { timeout: 240_000 });
  // the fade back from black ends once the first frame is settled
  await page.waitForFunction(() => document.getElementById('fly-fade').hidden && document.querySelector('#flightbar .note').hidden, null, { timeout: 240_000 });
  await page.waitForTimeout(500);
  await shot('picker');
  await page.keyboard.press('Escape');

  for (const look of looks) {
    if (look === 'night') {
      await page.evaluate(() => { const h = window.__skyline.timeline.active; h.setTimeOfDay(21, 0); });
    }
    for (const [name, t] of Object.entries(MOMENTS)) {
      await page.evaluate(async (at) => { const f = window.__skyline.flight; f.pause(); await f.seek({ at }); }, t);
      await page.evaluate(() => window.__skyline.flight.whenSettled());
      await page.waitForTimeout(300);
      await shot(`${look}_${name}`);
      if (name === 'oneminute') {
        // Look at the Sphere (the card's action while flying), then back to the default look
        const l = await page.evaluate(async () => { const f = window.__skyline.flight; const r = f.lookAtBuilding('w976405284'); await f.whenSettled(); return r; });
        console.log(look, 'Look at the Sphere one minute out', JSON.stringify(l));
        await page.waitForTimeout(300);
        await shot(`${look}_oneminute-lookat-sphere`);
        await page.evaluate(() => window.__skyline.flight.look({ yaw: 0, pitch: -8, lens: 26 }));
      }
      if (name === 'middescent' && look === 'day') await shot('bar', { clip: await page.locator('#dock').boundingBox() });
    }
  }
  // timing: play from the start of playback for 8 s at the condensed pace
  await page.evaluate(async (at) => { const f = window.__skyline.flight; await f.seek({ at }); f.play(); }, MOMENTS.start);
  const t0 = await page.evaluate(() => window.__skyline.loop.frames);
  await page.waitForTimeout(8000);
  const t1 = await page.evaluate(() => window.__skyline.loop.frames);
  const stats = await page.evaluate(() => window.__skyline.flight.stats());
  timing[backend] = { fps: (t1 - t0) / 8, ...stats };
  console.log(backend, JSON.stringify(timing[backend]));
  await page.evaluate(() => window.__skyline.flight.exit());
  await page.waitForTimeout(1200);
  await shot('map-after');
  if (problems.length) console.log(backend, 'console:', problems.slice(0, 20).join('\n'));
  timing[backend].problems = problems;
  await page.close();
}
writeFileSync(path.join(out, `${prefix}timing.json`), JSON.stringify(timing, null, 1));
await browser.close();

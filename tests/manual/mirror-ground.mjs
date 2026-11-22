// The cost of the mirrors' near-ground rebuild (src/drive/vehicle/mirrors.js swapGround: every FINE_STEP_M of travel
// each ground grid gets a new mirror index with its full-resolution cells around the car). Opens a route cold in the
// cabin, plays it for `seconds` and reports each rebuild's own JavaScript (the user-timing measure
// 'drive:mirror-ground') and the interval of the animation frame it fell in, against the frames around it.
// Serve the repo (or the production build: pnpm build && pnpm exec vite preview --port 5340 --strictPort) first, then:
//   node tests/manual/mirror-ground.mjs <port> '<case>'     <case>: { route, s, t?, seconds? } (ISO time, UTC)
import { chromium } from '@playwright/test';

const port = process.argv[2] || 5340;
const c = JSON.parse(process.argv[3] || '{"route":"i15n","s":30000}');
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* defaults */ } });
const q = new URLSearchParams({ city: 'lv', mode: 'drive', route: c.route, s: String(c.s), t: c.t || '2026-11-21T20:30:00Z', view: 'cabin' });
await page.goto(`http://localhost:${port}/?${q}`);
await page.waitForFunction(() => window.__skyline?.drive?.active?.() && window.__skyline.drive.pose(), null, { timeout: 120000 });
await page.evaluate(() => window.__skyline.drive.whenSettled());
await page.waitForTimeout(2000);
const r = await page.evaluate(async (seconds) => {
  const d = window.__skyline.drive;
  performance.clearMeasures('drive:mirror-ground');
  const frames = []; // [start, end] of each frame interval
  d.play();
  await new Promise((res) => {
    let last = performance.now();
    const t0 = last;
    const step = (now) => { frames.push([last, now]); last = now; if (now - t0 > seconds * 1000) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
  d.pause();
  const marks = performance.getEntriesByName('drive:mirror-ground');
  const dts = frames.map(([a, b]) => b - a).slice(30).sort((a, b) => a - b);
  const at = (p) => +dts[Math.min(dts.length - 1, Math.floor(p * dts.length))].toFixed(1);
  const rebuilds = marks.map((m) => {
    const k = frames.findIndex(([a, b]) => m.startTime >= a && m.startTime < b);
    // the rebuild runs in frame k's callbacks: the interval that ends with the next frame shows it
    const around = frames.slice(Math.max(0, k - 5), k + 7).map(([a, b]) => +(b - a).toFixed(1));
    return { ms: +m.duration.toFixed(2), frame: k, intervals: around };
  });
  const g = d.stats()?.cabin?.mirrors?.ground;
  return { frames: frames.length, median: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), km: d.pose().km.toFixed(2), rebuilds, ground: g };
}, c.seconds || 40);
console.log(JSON.stringify(r, null, 1));
await browser.close();

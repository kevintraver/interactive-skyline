// GPU cost of the traffic bodies (D6.4, plan 02 section 9.1: traffic geometry and its sprites 1.0 ms on
// High). Serve the repo (pnpm exec vite --port 5285 --strictPort), then: node tests/manual/traffic-budget.mjs <port> [bodies]
// At km 60 on a Friday at 17:30 it takes the model's vehicles ahead of the car (far more than the drive ever
// shows at once), pulls them toward the car until about `bodies` (default 600) are within a kilometre and in
// view, draws them with the part's renderer, and times the whole frame with EXT_disjoint_timer_query_webgl2
// with the traffic shown and hidden. A stress probe: the vehicles leave their lanes when pulled in.
import { chromium } from '@playwright/test';
const port = process.argv[2] || 5285, want = +(process.argv[3] || 600);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); s.drive.setView('clean'); });
await page.waitForFunction(() => window.__skyline.scene.getObjectByName('traffic')?.userData.part?.model(), null, { timeout: 60000 });
const r = await page.evaluate(async (want) => {
  const sk = window.__skyline, d = sk.drive;
  d.seek({ s: 60000, t: Date.parse('2026-07-11T00:30:00Z') });
  await d.whenSettled();
  const part = sk.scene.getObjectByName('traffic').userData.part;
  const p = d.pose();
  const placed = part.model().fleet.place(p.t, p.s, p.s + 9000, null);
  // keep those ahead, pulled toward the car so that they fall within a kilometre
  const fw = p.forward, cp = p.position;
  let far = 0;
  for (let i = 0; i < placed.count; i++) {
    const dx = placed.pos[3 * i] - cp.x, dz = placed.pos[3 * i + 2] - cp.z;
    far = Math.max(far, dx * fw.x + dz * fw.z);
  }
  const k = Math.min(1, 900 / far);
  for (let i = 0; i < placed.count; i++) {
    placed.pos[3 * i] = cp.x + (placed.pos[3 * i] - cp.x) * k;
    placed.pos[3 * i + 2] = cp.z + (placed.pos[3 * i + 2] - cp.z) * k;
    placed.s[i] = p.s + (placed.s[i] - p.s) * k;
  }
  placed.count = Math.min(placed.count, Math.round(want * 1.25));
  part.renderer.draw(placed, sk.camera, innerHeight, { s: p.s, range: 1e9 });
  const st = part.renderer.stats();
  const group = part.renderer.group;
  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const on = await sk.perf.renderFrames(90, 20);
  const info = sk.perf.info();
  group.visible = false;
  const off = await sk.perf.renderFrames(90, 20);
  const infoOff = sk.perf.info();
  group.visible = true;
  return { placed: placed.count, ...st, method: on.method, msOn: median(on.ms.filter((x) => x != null)), msOff: median(off.ms.filter((x) => x != null)), calls: info.calls - infoOff.calls, triangles: info.triangles - infoOff.triangles };
}, want);
console.log(JSON.stringify(r));
await page.screenshot({ path: process.argv[4] || '/dev/null' }).catch(() => {});
await browser.close();

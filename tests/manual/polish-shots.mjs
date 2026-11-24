// GPU screenshots of the drive, as drive-shots.mjs, with more options. Serve the repo first:
//   pnpm exec vite --port 5295 --strictPort
// then: node tests/manual/polish-shots.mjs <out-dir> <port> '<shots>'   (keep the out dir outside the repo)
// <shots> is JSON: [[name, s in metres, "day" | "night" | "dusk" | ISO time, opts?], ...] where opts is
//   { yaw, pitch, lens }  the look (degrees, mm)
//   route                 a route id (i15n, i15s, us93); the drive restarts on it when it changes
//   top                   metres: draw this frame from that height above the eye, looking straight down
//   eval                  JavaScript run in the page before the shot (window.__skyline is the app's hooks)
//   at: [x, y]            look toward this map point (metres east, north of the city origin); yaw is added to it
// The drive runs in the clean view (no cabin).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.argv[2]; const port = process.argv[3] || 5295;
const shots = JSON.parse(process.argv[4]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async () => {
  const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready;
  // a top view: move the camera up just for the render call, then put it back
  const r = s.renderer, render = r.render.bind(r);
  r.render = (scene, cam) => {
    const top = window.__polishTop;
    if (!top || !cam.isPerspectiveCamera) return render(scene, cam);
    const p = cam.position.clone(), q = cam.quaternion.clone(), near = cam.near;
    const f = window.__polishFwd, up = cam.up.clone();
    cam.position.y += top; cam.up.set(f.x, 0, f.z).normalize(); cam.lookAt(cam.position.x, cam.position.y - 1, cam.position.z); cam.up.copy(up);
    cam.near = Math.max(0.5, top * 0.2); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    render(scene, cam);
    cam.position.copy(p); cam.quaternion.copy(q); cam.near = near; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  };
});
const WHEN = { day: '2026-11-21T20:30:00Z', night: '2026-11-22T02:30:00Z', dusk: '2026-11-22T00:45:00Z' };
let route = null;
for (const [name, s, when, opts = {}] of shots) {
  const want = opts.route || 'i15n';
  if (want !== route) {
    await page.evaluate(async (id) => { const d = window.__skyline.drive; if (d.active()) d.exit(); await d.start(id, { view: 'clean' }); d.setView('clean'); d.pause(); }, want);
    route = want;
  }
  const info = await page.evaluate(async ({ s, t, opts }) => {
    const d = window.__skyline.drive;
    if (opts.eval) await (0, eval)(`(async () => { ${opts.eval} })()`);
    d.pause(); d.seek({ s, t }); d.look({ yaw: opts.yaw ?? 0, pitch: opts.pitch ?? 0, lens: opts.lens ?? 50 });
    if (opts.at) {
      await d.whenSettled();
      const p0 = d.pose(), f = p0.forward, e = p0.eye || p0.position;
      const tx = opts.at[0] - e.x, tz = -opts.at[1] - e.z;
      const yaw = (Math.atan2(f.z * tx - f.x * tz, f.x * tx + f.z * tz) * 180) / Math.PI; // left of ahead is positive
      window.__polishYawInfo = { yaw, e, f, tx, tz };
      d.look({ yaw: yaw + (opts.yaw ?? 0), pitch: opts.pitch ?? 0, lens: opts.lens ?? 50 });
    }
    await d.whenSettled();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = d.pose();
    window.__polishTop = opts.top || 0;
    if (opts.top) {
      // heading of the road: yaw the top view so the road runs up the frame
      window.__polishFwd = p.forward; // the road runs up the frame
      d.look({ yaw: (opts.yaw ?? 0) + 0.01 }); // force a frame
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return { s: Math.round(p.s), night: p.night, yaw: window.__polishYawInfo?.yaw };
  }, { s, t: Date.parse(WHEN[when] || when), opts });
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.evaluate(() => { window.__polishTop = 0; });
  console.log('shot', name, JSON.stringify(info));
}
await browser.close();

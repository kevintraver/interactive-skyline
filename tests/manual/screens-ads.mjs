// Screenshots of the billboard advertisements on the GPU (plan 02, D7.4): the car is placed at a distance before a
// chosen board and the head turned to it. Serve the repo first:  pnpm exec vite --port 5342 --strictPort
// then: node tests/manual/screens-ads.mjs <out-dir> <port> '<shots>' [route]      (keep the out dir outside the repo)
// <shots> is JSON: [[name, km, when, distance m, opts?], ...]
//   km: the board taken is the nearest one facing the road to the route at that km (route default i15n)
//   when: "day" | "night" | an ISO time;  distance: metres from the eye to the face's centre (the car stops short
//   of the board by about that much along the route; 0 or less: past it by that much, for a look back)
//   opts: { lens (mm, default 50), dt (seconds added to the time), yaw (degrees, overrides the aim), digital: true
//           (take the nearest digital board instead), face: 0 | 1 (of a V; default the one facing the car) }
// Also prints how the advertisements loaded (bytes, decode and set-up times, texture memory) and the billboards
// part's per-frame JavaScript. Clean view, paused clock.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2]; const port = process.argv[3] || 5342;
const shots = JSON.parse(process.argv[4]);
const route = process.argv[5] || 'i15n';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.routeWebSocket(/.*/, (ws) => {
  const server = ws.connectToServer();
  server.onMessage((m) => { if (!/full-reload|"type":"update"|"type":"prune"/.test(String(m))) ws.send(m); });
  ws.onMessage((m) => server.send(m));
});
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async (route) => { const d = window.__skyline.drive; await d.start(route, { view: 'clean' }); d.pause(); d.setView('clean'); await d.whenSettled(); }, route);
const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T02:30:00Z');
const whenMs = (w) => (w === 'day' ? DAY : w === 'night' ? NIGHT : Date.parse(w));

for (const [name, km, when, dist, opts = {}] of shots) {
  const t = whenMs(when) + (opts.dt || 0) * 1000;
  const info = await page.evaluate(async ({ km, t, dist, opts }) => {
    const sk = window.__skyline, d = sk.drive;
    let part = null;
    sk.scene.traverse((o) => { if (o.userData?.billboardsPart) part = o.userData.billboardsPart; });
    const settle = async () => { await Promise.race([d.whenSettled(), new Promise((r) => setTimeout(r, 30000))]); };
    d.seek({ s: km * 1000, t });
    await settle();
    let p = d.pose();
    // the board: nearest to the road here, facing it
    const cands = part.faces.filter((f) => (!opts.digital || f.digital) && ((p.position.x - f.cx) * f.nx + (p.position.z - f.cz) * f.nz) > 0);
    cands.sort((a, b) => Math.hypot(a.cx - p.position.x, a.cz - p.position.z) - Math.hypot(b.cx - p.position.x, b.cz - p.position.z));
    let face = cands[0];
    if (opts.face !== undefined) face = part.faces.filter((f) => f.board === face.board)[opts.face];
    // the car short of it by `dist` (or past it), a few steps of the route
    const sign = dist > 0 ? 1 : -1;
    let s = km * 1000;
    for (let i = 0; i < 6; i++) {
      const e = p.eye, along = (face.cx - e.x) * p.forward.x + (face.cz - e.z) * p.forward.z;
      const lateral = Math.hypot(face.cx - e.x, face.cz - e.z) ** 2 - along ** 2;
      const want = sign * Math.sqrt(Math.max(0, dist * dist - lateral));
      const ds = along - want;
      if (Math.abs(ds) < 2) break;
      s += ds;
      d.seek({ s, t });
      await settle();
      p = d.pose();
    }
    const e = p.eye, dx = face.cx - e.x, dz = face.cz - e.z, dy = face.cy - e.y;
    const fwd = Math.atan2(-p.forward.z, p.forward.x), to = Math.atan2(-dz, dx);
    let yaw = ((to - fwd) * 180) / Math.PI;
    yaw = ((yaw + 540) % 360) - 180;
    if (Number.isFinite(opts.yaw)) yaw = opts.yaw;
    const pitch = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    d.look({ yaw: Math.max(-150, Math.min(150, yaw)), pitch, lens: opts.lens ?? 50 });
    await settle();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const st = d.stats()?.billboards;
    return {
      s: Math.round(p.s), dist: Math.round(Math.hypot(dx, dy, dz)), yaw: Math.round(yaw), face: face.index, digital: face.digital, w: face.w, h: face.h,
      images: st?.images, js: st?.js,
    };
  }, { km, t, dist, opts });
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name, JSON.stringify(info));
}
// a minute of play at 16x for the per-frame cost
const js = await page.evaluate(async () => {
  const d = window.__skyline.drive;
  d.setRate?.(16); d.play?.();
  await new Promise((r) => setTimeout(r, 8000));
  d.pause();
  return d.stats()?.billboards?.js;
});
console.log('billboards js (ms per frame) while playing:', JSON.stringify(js));
await browser.close();

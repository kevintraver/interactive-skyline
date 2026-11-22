// Screenshots of the drive's traffic on the GPU (D6.4), from tests/manual/drive-shots.mjs with a chosen time,
// a view from above and frame sequences. Serve the repo first:
//   pnpm exec vite --port 5285 --strictPort
// then: node tests/manual/traffic-shots.mjs <out-dir> <port> '<shots>'   (keep the out dir outside the repo)
// <shots> is JSON: [[name, s in metres, ISO time, { yaw, pitch, lens }?, { above?: metres, seq?: frames, dtMs?: 500 }?], ...]
//   above: the camera is put that high over the car, looking down at the road ahead (the traffic part redraws
//   for that camera; other parts keep the car camera's frame); seq: that many frames dtMs apart (name-0, name-1, ...).
//   play: ms of real time to run the clock at 1x before the shot (the per-frame timings then cover playing frames).
// Prints the traffic part's stats per frame (and with play the p95 of its per-frame JavaScript).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.argv[2]; const port = process.argv[3] || 5285;
const shots = JSON.parse(process.argv[4]);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
const gl = await page.evaluate(() => { const g = window.__skyline.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('renderer:', gl);
await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); s.drive.setView('clean'); });
await page.waitForFunction(() => window.__skyline.scene.getObjectByName('traffic')?.userData.part, null, { timeout: 60000 });
for (const [name, s, iso, look, opt = {}] of shots) {
  const n = opt.seq || 1;
  for (let f = 0; f < n; f++) {
    const info = await page.evaluate(async ({ s, t, look, above, first, play }) => {
      const sk = window.__skyline, d = sk.drive;
      d.pause();
      if (first) d.seek({ s, t }); else d.seek({ t });
      d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
      await d.whenSettled();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const part = sk.scene.getObjectByName('traffic').userData.part;
      await part.whenSettled();
      await d.whenSettled();
      let perf = null;
      if (play) {
        const st0 = d.stats();
        d.play();
        await new Promise((r) => setTimeout(r, play));
        d.pause();
        await d.whenSettled();
        const st = d.stats();
        perf = { place: st.traffic.js.place, draw: st.traffic.js.draw, total: st.js.total, frames: st.js.total.count - (st0.js.total.count || 0) };
      }
      if (above) {
        const p = d.pose(), cam = sk.camera;
        const fw = p.forward;
        cam.position.set(p.position.x + fw.x * 20, p.position.y + above, p.position.z + fw.z * 20);
        cam.lookAt(p.position.x + fw.x * (above * 0.9), p.position.y, p.position.z + fw.z * (above * 0.9));
        cam.updateMatrixWorld();
        const u = p.up, right = { x: fw.y * u.z - fw.z * u.y, y: fw.z * u.x - fw.x * u.z, z: fw.x * u.y - fw.y * u.x };
        part.beforeRender({ camera: cam, viewport: { width: innerWidth, height: innerHeight }, simMs: p.t, pose: { ...p, right } });
        sk.renderer.render(sk.scene, cam);
      }
      const p = d.pose(), st = d.stats();
      return { s: Math.round(p.s), lane: p.lane, night: p.night, iso: p.iso, calls: st.render?.calls, triangles: st.render?.triangles, traffic: st.traffic, perf };
    }, { s, t: Date.parse(iso) + f * (opt.dtMs || 500), look: look || {}, above: opt.above || 0, first: f === 0, play: opt.play || 0 });
    const file = n > 1 ? `${name}-${f}` : name;
    await page.screenshot({ path: `${out}/${file}.png` });
    const tr = info.traffic || {};
    if (info.perf) console.log('perf', file, JSON.stringify(info.perf));
    console.log('shot', file, JSON.stringify({ s: info.s, triangles: info.triangles, lane: info.lane, night: info.night, iso: info.iso, calls: info.calls, enumerated: tr.enumerated, placed: tr.placed, drawn: tr.drawn, detailed: tr.detailed, coarse: tr.coarse, gapped: tr.gapped, range: tr.range, place: tr.js?.place?.last?.toFixed(3), draw: tr.js?.draw?.last?.toFixed(3) }));
  }
}
await browser.close();

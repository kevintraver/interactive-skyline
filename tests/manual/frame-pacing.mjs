// Frame pacing of the drive on the GPU: opens each case cold from its address, plays for a few seconds and reports the
// intervals between animation frames (median, p95, p99, max, how many were over 20 ms) and the drive's own JavaScript.
// Serve the production build first:   pnpm build && pnpm exec vite preview --port 5340 --strictPort
// then:   node tests/manual/frame-pacing.mjs <port> <device pixel ratio: 1 or 2> '<cases>'
// <cases> is JSON: [{ name, route, s (metres), t (ISO time, UTC), view?: "cabin" | "clean", rain?: "light" | "moderate" | "heavy", frames?,
//   scale?: "auto" }, ...]   scale "auto" switches the adaptive render scale on (it is off under automation; builds without
//   it ignore this); the result's `ratio` is the pixel ratio the last playing frame was drawn at, `scale` its state.
import { chromium } from '@playwright/test';
const port = process.argv[2]; const dpr = Number(process.argv[3] || 1);
const cases = JSON.parse(process.argv[4]);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
for (const c of cases) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('pageerror ' + e.message.slice(0, 160)));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
  const q = `city=lv&mode=drive&route=${c.route}&s=${c.s}&t=${encodeURIComponent(c.t)}&view=${c.view || 'cabin'}${c.rain ? '&rain=' + c.rain : ''}`;
  await page.goto(`http://localhost:${port}/?${q}&renderer=legacy`);
  await page.waitForFunction(() => window.__skyline?.drive?.active?.() && window.__skyline.drive.pose(), null, { timeout: 120000 });
  await page.evaluate(() => window.__skyline.drive.whenSettled());
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async ({ frames, auto }) => {
    const d = window.__skyline.drive;
    if (auto && d.renderScale) d.renderScale({ adaptive: true });
    d.play();
    const dts = []; let last = performance.now();
    await new Promise((res) => { const step = (now) => { dts.push(now - last); last = now; if (dts.length >= frames) res(); else requestAnimationFrame(step); }; requestAnimationFrame((n) => { last = n; requestAnimationFrame(step); }); });
    const ratio = window.__skyline.renderer.getPixelRatio();
    d.pause();
    const s = dts.slice(30).sort((a, b) => a - b); const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    // over a long run (the adaptive scale's), the last 330 intervals too: after it has settled
    const tl = dts.length > 500 ? dts.slice(-330).sort((a, b) => a - b) : null;
    const tail = tl ? { median: +tl[165].toFixed(1), max: +tl[tl.length - 1].toFixed(1), over20: tl.filter((x) => x > 20).length, n: tl.length } : undefined;
    const st = d.stats(); const js = st.js || {};
    const pick = (o) => o ? { mean: +(o.mean ?? 0).toFixed(2), p95: +(o.p95 ?? 0).toFixed(2), max: +(o.max ?? 0).toFixed(2) } : null;
    return { median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), p99: +at(0.99).toFixed(1), max: +s[s.length - 1].toFixed(1), over20: s.filter((x) => x > 20).length, n: s.length,
      calls: st.render?.calls, tris: st.render?.triangles, jsTotal: pick(js.total), parts: Object.keys(st).filter((k) => !['render', 'js', 'renderScale'].includes(k)).length, pose: d.pose().km.toFixed(1),
      tail, ratio, scale: st.renderScale ? { playRatio: st.renderScale.playRatio, changes: st.renderScale.changes, upWaitMs: st.renderScale.upWaitMs } : undefined };
  }, { frames: c.frames || 360, auto: c.scale === 'auto' });
  console.log(c.name.padEnd(28), JSON.stringify(r), errors.length ? ' ERR: ' + errors.slice(0, 2).join(' | ') : '');
  await page.close();
}
await browser.close();

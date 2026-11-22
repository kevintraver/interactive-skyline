// Screenshots of the drive on any route, on the GPU, in the app as the visitor sees it (interface included).
// A copy of drive-shots.mjs with a route option, the cabin by default, phone sizes and the route picker's states.
// Serve the repo first:   pnpm exec vite --port 5302 --strictPort
// then:   node tests/manual/routes-app-shots.mjs <out-dir> <port> '<shots>'   (keep the out dir outside the repo)
// <shots> is JSON: [{ name, route, s?, when?: "day" | "night", view?: "cabin" | "clean", look?: { yaw, pitch, lens },
//                     size?: [w, h], picker?: "open" | "collapsed" }, ...]
// Each shot opens the route cold from its address (?city=lv&mode=drive&route=...), so a shot never depends on the one
// before it; `s` defaults to the route's reveal start, `when` to day. Prints the pose and the drive's stats per shot.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2]; const port = process.argv[3] || 5302;
const shots = JSON.parse(process.argv[4]);
mkdirSync(out, { recursive: true });
const DAY = '2026-11-21T20:30:00Z', NIGHT = '2026-11-22T04:30:00Z';
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });

for (const shot of shots) {
  // the dev server reloads the page when a source file changes under it: try a shot again then
  for (let attempt = 1; ; attempt++) {
    try { await take(shot); break; } catch (err) {
      if (attempt >= 3) throw err;
      console.log(`  retrying ${shot.name}: ${String(err.message).split('\n')[0]}`);
    }
  }
}
await browser.close();

async function take(shot) {
  const [w, h] = shot.size || [1280, 720];
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
  const problems = [];
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/GL Driver/.test(m.text())) problems.push(`[${m.type()}] ${m.text().slice(0, 240)}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* defaults */ } });
  const q = new URLSearchParams({ city: 'lv', mode: 'drive', route: shot.route, view: shot.view || 'cabin', t: shot.when === 'night' ? NIGHT : DAY });
  if (Number.isFinite(shot.s)) q.set('s', String(shot.s));
  await page.goto(`http://localhost:${port}/?${q}`);
  await page.waitForFunction(() => window.__skyline?.attractions && window.__skyline?.drive?.active?.() && window.__skyline.drive.pose()
    && !document.getElementById('drivebar')?.classList.contains('busy'), null, { timeout: 180000 });
  const info = await page.evaluate(async (shot) => {
    const s = window.__skyline, d = s.drive;
    s.attractions.freeze(20);
    d.pause();
    if (shot.look) d.look(shot.look);
    await d.whenSettled();
    // the parts load after the road: wait for the ones the picture needs, then settle again
    for (let i = 0; i < 600 && !(d.stats()?.traffic && d.stats()?.lamps); i++) await new Promise((r) => setTimeout(r, 50));
    await d.whenSettled();
    if (shot.picker && d.picker) d.picker(shot.picker === 'open');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await d.whenSettled();
    const p = d.pose(), st = d.stats();
    return { route: p.route, s: Math.round(p.s), night: p.night, sun: +p.sunElevation.toFixed(1), calls: st.render.calls,
      parts: Object.keys(st).filter((k) => !['render', 'js', 'active', 'signs'].includes(k)).join(','), picker: d.pickerState?.() };
  }, shot);
  await page.screenshot({ path: `${out}/${shot.name}.png` });
  console.log('shot', shot.name, JSON.stringify(info), problems.length ? `\n  ${problems.join('\n  ')}` : '');
  await page.close();
}

// Screenshots of the drive's screens and billboards on the GPU (plan 02, D7.3 to D7.5), after drive-shots.mjs with
// more options. Serve the repo first:  pnpm exec vite --port 5294 --strictPort
// then: node tests/manual/screens-shots.mjs <out-dir> <port> '<shots>'      (keep the out dir outside the repo)
// <shots> is JSON: [[name, s in metres, when, opts?], ...]
//   when: "day" | "night" | an ISO time | UTC ms
//   opts: { yaw, pitch, lens, dt (seconds added to the time), focus (a building id: the head turns to it, as "Zoom to"
//           does), lookOf: name (the look of an earlier shot, exactly), sphere: "shown" | "hidden" | [dx, dz] (moves it east/south, metres), same: name (compare the canvas
//           with an earlier shot and print whether they are identical), away: true (seek far away and back first) }
// Prints the screens' and billboards' stats with each shot. Clean view, paused clock.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2]; const port = process.argv[3] || 5294;
const shots = JSON.parse(process.argv[4]);
const SPHERE = 'w976405284';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
// other work in the same checkout makes the dev server reload the page: keep its update socket quiet
await page.routeWebSocket(/.*/, (ws) => {
  const server = ws.connectToServer();
  server.onMessage((m) => { if (!/full-reload|"type":"update"|"type":"prune"/.test(String(m))) ws.send(m); });
  ws.onMessage((m) => server.send(m));
});
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async () => { const s = window.__skyline; await s.attractions.ready; await s.drive.start('i15n', { view: 'clean' }); s.drive.pause(); s.drive.setView('clean'); });
const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T02:30:00Z');
const whenMs = (w) => (w === 'day' ? DAY : w === 'night' ? NIGHT : typeof w === 'number' ? w : Date.parse(w));
let sphereState = 'shown';
const canvases = new Map(), looks = new Map();

async function setSphere(want) {
  const key = JSON.stringify(want);
  if (key === JSON.stringify(sphereState)) return;
  await page.evaluate(async ({ id, want }) => {
    const s = window.__skyline, d = s.drive, entry = s.tall.find((e) => e.data.id === id);
    const pose = d.pose();
    const hidden = !entry.mesh.visible;
    if ((want === 'hidden') !== hidden) {
      // the card's Hide / Show button, as a visitor would (the map's edit path, which announces the change)
      d.exit();
      s.select(id);
      document.querySelector('#card [data-act="hide"]').click();
      await d.start('i15n', { s: pose.s, t: pose.simMs ?? undefined, view: 'clean' });
      d.pause();
    }
    if (Array.isArray(want)) s.place(entry, want[0], want[1]);
    else if (want !== 'hidden') s.place(entry, 0, 0);
  }, { id: SPHERE, want });
  sphereState = want;
}

for (const [name, s, when, opts = {}] of shots) {
  await setSphere(opts.sphere || 'shown');
  const t = whenMs(when) + (opts.dt || 0) * 1000;
  const like = opts.same || opts.lookOf;
  if (like && looks.has(like)) Object.assign(opts, looks.get(like), { focus: undefined }); // the same look exactly
  const info = await page.evaluate(async ({ s, t, opts, id }) => {
    const sk = window.__skyline, d = sk.drive;
    d.pause();
    if (opts.away) { d.seek({ s: s - 3000, t: t - 600000 }); await d.whenSettled(); }
    d.seek({ s, t });
    d.look({ yaw: opts.yaw ?? 0, pitch: opts.pitch ?? 0, lens: opts.lens ?? 50 });
    // the head turns from where the eye is, so let the seek land first
    if (opts.focus) { await d.whenSettled(); sk.focusOn(sk.tall.find((e) => e.data.id === opts.focus)); }
    // settled, or 30 s (a part that never settles is named in the output, the shot is still taken)
    const settled = await Promise.race([d.whenSettled().then(() => true), new Promise((r) => setTimeout(() => r(false), 30000))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const st = d.stats();
    if (!settled) console.warn('not settled after 30 s: loading', d.stats()?.render, JSON.stringify(Object.keys(st)));
    const p = d.pose();
    return { s: Math.round(p.s), night: p.night, yaw: p.yaw, pitch: p.pitch, screens: st?.screens || null, billboards: st?.billboards || null, visible: d.visible(id) };
  }, { s, t, opts, id: SPHERE });
  const buf = await page.screenshot({ path: `${out}/${name}.png` });
  canvases.set(name, buf);
  looks.set(name, { yaw: info.yaw, pitch: info.pitch, lens: opts.lens ?? 50 });
  const same = opts.same ? ` same-as ${opts.same}: ${canvases.get(opts.same)?.equals(buf)}` : '';
  console.log('shot', name, JSON.stringify(info), same);
}
await browser.close();

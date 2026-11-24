// Smoke check of the traffic and valley parts on a renderer (plan 02, third stretch): opens the drive with
// ?parts=traffic,valley at a place and time, prints the parts' stats and any console errors, and writes the frame.
//   node tests/manual/traffic-smoke.mjs [--port 5325] [--renderer webgpu|legacy] [--backend webgpu|webgl]
//        [--display classic] [--route i15n] [--s 52000] [--t ISO] [--out file.png] [--look '{"yaw":0}']
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const port = opt('port', '5325'), rendererName = opt('renderer', 'webgpu'), backend = opt('backend', 'webgpu');
const display = opt('display', ''), route = opt('route', 'i15n'), s = Number(opt('s', 52000));
const t = Date.parse(opt('t', '2026-11-22T05:00:00Z')), out = opt('out', null), look = JSON.parse(opt('look', '{}'));
const parts = opt('parts', 'traffic,valley');
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
  '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => {});
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text().slice(0, 400)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 400)}`));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
const q = `city=lv&renderer=${rendererName}${rendererName === 'webgpu' ? `&backend=${backend}` : ''}${display ? `&display=${display}` : ''}&parts=${parts}`;
await page.goto(`http://localhost:${port}/?${q}`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 180000 });
const r = await page.evaluate(async ({ route, s, t, look }) => {
  const sk = window.__skyline, d = sk.drive;
  await d.start(route, { s, t, view: 'clean' });
  d.pause(); d.setView('clean'); d.seek({ s, t }); d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
  await Promise.race([d.whenSettled(), new Promise((res) => setTimeout(res, 90000))]);
  for (let i = 0; i < 5; i++) await new Promise((res) => requestAnimationFrame(res));
  d.renderFrame();
  const traffic = sk.scene.getObjectByName('traffic')?.userData.part || null, valley = sk.scene.getObjectByName('valley-ribbons')?.userData.part || null;
  const canvas = sk.renderer.domElement;
  d.renderFrame();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { info: sk.rendererInfo, traffic: traffic?.stats?.() ?? null, valley: valley?.stats?.() ?? null, png: btoa(bin) };
}, { route, s, t, look });
if (out) writeFileSync(out, Buffer.from(r.png, 'base64'));
delete r.png;
console.log(JSON.stringify(r, null, 1).slice(0, 4000));
console.log([...new Set(problems)].slice(0, 20).join('\n'));
await browser.close();

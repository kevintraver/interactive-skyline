// Scrubbing across sunset on the GPU, forward then backward, at the 16x rate's frame step: checks that the look has
// no visible step (frame-to-frame change of mean colour) and that it is a pure function of time (the same time gives
// the same frame from either direction). The car holds its place (hold position), so only the light changes.
// Serve the repo first:  pnpm exec vite --port 5282 --strictPort
// then:  node tests/manual/dusk-scrub.mjs <port> [km] [step sim seconds] [<day ISO>]
import { chromium } from '@playwright/test';

const port = process.argv[2] || 5282;
const km = Number(process.argv[3] || 44.2);
const stepS = Number(process.argv[4] || 16 / 60 * 8); // 8 frames at 60 Hz and 16x
const day = process.argv[5] ? Date.parse(process.argv[5]) : Date.now();

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
const ready = () => page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await ready();
// the dev server may reload the page once while it settles its dependencies; run again after a reload
const run = async (fn, arg) => { for (let k = 0; ; k++) { try { return await page.evaluate(fn, arg); } catch (e) { if (k > 8 || !/context was destroyed/.test(e.message)) throw e; await ready(); } } };
const result = await run(async ({ km, stepS, day }) => {
  const s = window.__skyline;
  s.attractions?.freeze(20);
  await s.drive.start('i15n', {});
  s.drive.pause();
  const { createEphemeris } = await import('/src/drive/env.js');
  const cities = await (await fetch('/data/cities.json')).json();
  const eph = createEphemeris(cities.lv);
  const t0 = eph.timeOfSunElevation(1, day, true), t1 = eph.timeOfSunElevation(-10, day, true);
  const d = s.drive;
  d.seek({ s: km * 1000, t: t0 });
  d.look({ yaw: 0, pitch: 0, lens: 50 });
  await d.whenSettled();
  const gl = s.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
  // traffic moves with time even with the car held; hide it so only the light changes between frames
  const hideTraffic = () => s.scene.traverse((o) => { if (o.name === 'traffic' || o.name === 'traffic-shadows') o.visible = false; });
  const grab = async (t) => {
    d.seek({ s: km * 1000, t });
    await d.whenSettled();
    hideTraffic();
    s.renderer.render(s.scene, s.camera); // the drive draws with the app's camera; draw once more to read back
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // mean of the sky (top third) and the ground (bottom third)
    const band = (y0, y1) => { const m = [0, 0, 0]; let n = 0; for (let y = y0; y < y1; y += 2) for (let x = 0; x < w; x += 2) { const i = (y * w + x) * 4; m[0] += px[i]; m[1] += px[i + 1]; m[2] += px[i + 2]; n++; } return m.map((v) => v / n); };
    return { t, sky: band(Math.floor(h * 0.67), h), ground: band(0, Math.floor(h * 0.33)), sun: d.pose().sunElevation, night: d.pose().night };
  };
  const times = [];
  for (let t = t0; t <= t1; t += stepS * 1000) times.push(t);
  const fwd = [], back = [];
  for (const t of times) fwd.push(await grab(t));
  for (const t of [...times].reverse()) back.unshift(await grab(t));
  const diff = (a, b) => Math.max(...[0, 1, 2].map((k) => Math.abs(a.sky[k] - b.sky[k])), ...[0, 1, 2].map((k) => Math.abs(a.ground[k] - b.ground[k])));
  let worstStep = 0, at = null, worstPurity = 0, flips = [];
  for (let i = 1; i < fwd.length; i++) { const v = diff(fwd[i], fwd[i - 1]); if (v > worstStep) { worstStep = v; at = fwd[i].sun; } if (fwd[i].night !== fwd[i - 1].night) flips.push(fwd[i].sun); }
  const steps = fwd.slice(1).map((f, i) => ({ sun: +f.sun.toFixed(2), step: +diff(f, fwd[i]).toFixed(2), sky: f.sky.map((v) => +v.toFixed(1)), was: fwd[i].sky.map((v) => +v.toFixed(1)), ground: f.ground.map((v) => +v.toFixed(1)), wasGround: fwd[i].ground.map((v) => +v.toFixed(1)) })).sort((a, b) => b.step - a.step).slice(0, 6);
  for (let i = 0; i < fwd.length; i++) worstPurity = Math.max(worstPurity, diff(fwd[i], back[i]));
  return { frames: fwd.length, stepS, worstStep: +worstStep.toFixed(2), worstStepAtSun: at && +at.toFixed(2), worstPurity: +worstPurity.toFixed(3), nightFlipsAtSun: flips.map((v) => +v.toFixed(2)), largestSteps: steps,
    first: fwd[0], last: fwd[fwd.length - 1] };
}, { km, stepS, day });
console.log(JSON.stringify(result, null, 1));
await browser.close();

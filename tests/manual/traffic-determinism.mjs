// Determinism of the traffic on plan 01's renderer (plan 02, D6.4; third stretch, decision 4): the traffic is a pure
// function of simulation time (app.clock through the session), so a play to an instant must draw the same vehicles as
// a seek to it. For each rate (1x and 8x): a page enters the drive at a place and time T, seeks to T - 30 s, plays at
// that rate until the clock passes T, pauses at T1 and records every drawn vehicle (id, lane, station, body class);
// a second page, fresh, enters at the same place and time, seeks an hour away and then to T1, and records the same.
// The two lists must hold the same vehicles in the same lanes and classes, at the same stations within 1 cm.
//   node tests/manual/traffic-determinism.mjs [--port 5325] [--backend webgpu|webgl] [--route i15n] [--s 52000]
//        [--t 2026-11-22T05:00:00Z]
// The exit code is the verdict.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (n, f) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : f; };
const port = opt('port', '5325'), backend = opt('backend', 'webgpu'), route = opt('route', 'i15n'), S = Number(opt('s', 52000));
const T = Date.parse(opt('t', '2026-11-22T05:00:00Z'));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
  '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'] });

async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.goto(`http://localhost:${port}/?city=lv&renderer=webgpu&backend=${backend}&parts=traffic`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 180000 });
  await page.evaluate(async ({ route, S, T }) => {
    const sk = window.__skyline, d = sk.drive;
    await d.start(route, { s: S, t: T, view: 'clean' });
    d.pause(); d.setView('clean'); d.look({ yaw: 0, pitch: 0, lens: 50 });
    for (let i = 0; i < 600 && !sk.scene.getObjectByName('traffic')?.userData.part?.stats().ready; i++) await new Promise((r) => requestAnimationFrame(r));
  }, { route, S, T });
  return page;
}
/** In the page: draw a frame and list the drawn vehicles. */
const RECORD = async () => {
  const sk = window.__skyline, d = sk.drive, part = sk.scene.getObjectByName('traffic').userData.part;
  await Promise.race([d.whenSettled(), new Promise((r) => setTimeout(r, 60000))]);
  d.renderFrame();
  const p = part.placed(), idx = part.renderer.drawnIndices();
  const list = Array.from(idx, (i) => ({ id: p.id[i], lane: p.dir[i] * 16 + p.lane[i], s: p.s[i], body: p.body[i] }));
  list.sort((a, b) => a.id - b.id);
  return { t: sk.clock.timeMs, list, carS: d.pose().s };
};

function compare(a, b) {
  const byId = new Map(b.list.map((v) => [v.id, v]));
  let maxDs = 0;
  const diffs = [];
  for (const v of a.list) {
    const w = byId.get(v.id);
    if (!w) { diffs.push(`id ${v.id} only in the play`); continue; }
    byId.delete(v.id);
    maxDs = Math.max(maxDs, Math.abs(v.s - w.s));
    if (v.lane !== w.lane || v.body !== w.body) diffs.push(`id ${v.id}: lane ${v.lane}/${w.lane} body ${v.body}/${w.body}`);
  }
  for (const id of byId.keys()) diffs.push(`id ${id} only in the seek`);
  return { maxDs, diffs };
}

let failed = 0;
const seeker = await open();
for (const rate of [1, 8]) {
  const player = await open();
  const played = await player.evaluate(async ({ T, rate, RECORD }) => {
    const sk = window.__skyline, d = sk.drive;
    d.seek({ t: T - 30000 });
    await Promise.race([d.whenSettled(), new Promise((r) => setTimeout(r, 60000))]);
    sk.clock.setRate(rate);
    const wall = performance.now();
    d.play();
    let frames = 0;
    while (sk.clock.timeMs < T) { await new Promise((r) => requestAnimationFrame(r)); frames++; }
    d.pause();
    const out = await (0, eval)(`(${RECORD})`)();
    return { ...out, frames, wallMs: performance.now() - wall };
  }, { T, rate, RECORD: RECORD.toString() });
  await player.close();
  const sought = await seeker.evaluate(async ({ t1, RECORD }) => {
    const d = window.__skyline.drive;
    d.seek({ t: t1 - 3600000 });
    await Promise.race([d.whenSettled(), new Promise((r) => setTimeout(r, 60000))]);
    d.renderFrame();
    d.seek({ t: t1 });
    return (0, eval)(`(${RECORD})`)();
  }, { t1: played.t, RECORD: RECORD.toString() });
  const c = compare(played, sought);
  const pass = played.list.length > 0 && !c.diffs.length && c.maxDs <= 0.01 && sought.t === played.t;
  if (!pass) failed++;
  console.log(`${rate}x: played 30 s to T + ${((played.t - T) / 1000).toFixed(3)} s in ${played.frames} frames (${(played.wallMs / 1000).toFixed(1)} s); ${played.list.length} drawn vehicles in the play, ${sought.list.length} in the seek; max station difference ${(c.maxDs * 100).toFixed(3)} cm; car at ${played.carS.toFixed(2)} / ${sought.carS.toFixed(2)} m  ${pass ? 'PASS' : 'FAIL'}`);
  for (const x of c.diffs.slice(0, 10)) console.log(`   ${x}`);
}
await browser.close();
process.exit(failed ? 1 : 0);

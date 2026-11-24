// Measurements of the drive's screens on the GPU (plan 02, D7.3 and D7.5): the Sphere's lit patch (on against off,
// shown, hidden, moved, at two moments), the clocks given back on leaving Drive, and the per-frame JavaScript of
// the `screens` and `billboards` parts. Serve the repo first:  pnpm exec vite --port 5294 --strictPort
// then: node tests/manual/screens-probe.mjs <port>
import { chromium } from '@playwright/test';

const port = process.argv[2] || 5294;
const SPHERE = 'w976405284';
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.routeWebSocket(/.*/, (ws) => {
  const server = ws.connectToServer();
  server.onMessage((m) => { if (!/full-reload|"type":"update"|"type":"prune"/.test(String(m))) ws.send(m); });
  ws.onMessage((m) => server.send(m));
});
await page.goto(`http://localhost:${port}/?city=lv&renderer=legacy`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
const NIGHT = Date.parse('2026-11-22T02:30:00Z');

const result = await page.evaluate(async ({ id, NIGHT }) => {
  const s = window.__skyline, d = s.drive;
  await s.attractions.ready;
  await d.start('i15n', { view: 'clean' });
  d.pause();
  d.setView('clean');
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const driveGroup = () => s.scene.getObjectByName('drive');
  let scr = null, bb = null;
  for (let i = 0; i < 600 && !(scr && bb); i++) {
    await raf();
    scr = driveGroup()?.userData.screensPart || null;
    bb = s.scene.getObjectByName('billboards')?.userData.billboardsPart || null;
  }
  const entry = s.tall.find((e) => e.data.id === id);
  const grab = async () => {
    await d.whenSettled();
    for (let i = 0; i < 3; i++) await raf();
    const c = document.getElementById('scene');
    const g = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height }).getContext('2d');
    g.drawImage(c, 0, 0);
    return { w: c.width, h: c.height, px: g.getImageData(0, 0, c.width, c.height).data };
  };
  // the patch, seen from a probe camera 350 m up and 500 m south-east of the Sphere's centre, looking at the ground
  // around it: a frame with the light minus a frame without (the drive's own camera never sees that ground: the
  // Sphere stands about 1.3 km from I-15 and its light reaches 900 m)
  const gl = s.renderer.getContext();
  const shoot = (on, simMs) => {
    const c = scr.uniforms.uScrSphere.value;
    const cam = s.camera.clone();
    cam.fov = 50; cam.near = 1; cam.far = 20000; cam.aspect = 1280 / 720; cam.updateProjectionMatrix();
    const C = { x: 966.2, y: 20, z: -726.3 }; // fixed: a moved Sphere moves its patch across the frame
    cam.position.set(C.x + 350, C.y + 350, C.z + 350);
    cam.up.set(0, 1, 0);
    cam.lookAt(C.x, C.y, C.z);
    cam.updateMatrixWorld(true);
    scr.setLight(on);
    const f = { simMs, dtSimMs: 0, camera: cam, rate: 1, playing: false };
    scr.beforeRender(f);
    s.renderer.render(s.scene, cam);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    scr.afterRender(f);
    scr.setLight(true);
    return { w, h, px, centre: [c.x, c.y, c.z] };
  };
  const patch = (simMs) => {
    const on = shoot(true, simMs), off = shoot(false, simMs);
    const sum = [0, 0, 0];
    let n = 0, cx = 0, cy = 0, wsum = 0;
    for (let i = 0; i < on.px.length; i += 4) {
      const dr = on.px[i] - off.px[i], dg = on.px[i + 1] - off.px[i + 1], db = on.px[i + 2] - off.px[i + 2], dl = dr + dg + db;
      if (dl > 1) { sum[0] += dr; sum[1] += dg; sum[2] += db; n++; const q = i / 4; cx += (q % on.w) * dl; cy += Math.floor(q / on.w) * dl; wsum += dl; }
    }
    const mean = scr.stats().sphereLight.mean;
    const tot = sum[0] + sum[1] + sum[2], mt = mean[0] + mean[1] + mean[2];
    return { litShare: +(n / (on.w * on.h)).toFixed(3), meanDelta: sum.map((v) => +(v / Math.max(1, n)).toFixed(2)),
      deltaChroma: tot ? sum.map((v) => +(v / tot).toFixed(3)) : null, screenChroma: mt ? mean.map((v) => +(v / mt).toFixed(3)) : null,
      centroidPx: wsum ? [Math.round(cx / wsum), Math.round(cy / wsum)] : null, termCentre: on.centre.map((v) => +v.toFixed(1)), visible: entry.mesh.visible };
  };
  const at = async (sKm, t, opts = {}) => {
    d.seek({ s: sKm, t });
    d.look({ yaw: opts.yaw ?? 0, pitch: 0, lens: opts.lens ?? 100 });
    await d.whenSettled();
  };
  const out = {};
  await at(59500, NIGHT);
  out.shown = patch(NIGHT);
  out.shown20min = patch(NIGHT + 20 * 60000);
  out.shown40min = patch(NIGHT + 40 * 60000);
  // hidden through the card, as a visitor would; back with undo
  d.exit(); s.select(id); document.querySelector('#card [data-act="hide"]').click();
  await d.start('i15n', { s: 59500, t: NIGHT, view: 'clean' }); d.pause();
  await at(59500, NIGHT, { yaw: 0 });
  out.hidden = patch(NIGHT);
  document.activeElement?.blur?.();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: true, bubbles: true }));
  for (let i = 0; i < 5; i++) await raf();
  out.restored = { visible: entry.mesh.visible };
  if (!entry.mesh.visible) { d.exit(); s.select(id); document.querySelector('#card [data-act="hide"]').click(); await d.start('i15n', { s: 59500, t: NIGHT, view: 'clean' }); d.pause(); }
  // moved 200 m west and 150 m north (place takes metres east and south); the probe camera stays
  s.place(entry, -200, -150);
  await at(59500, NIGHT, { yaw: 0 });
  out.moved = patch(NIGHT);
  s.place(entry, 0, 0);
  await at(59500, NIGHT, { yaw: 0 });
  out.movedBack = patch(NIGHT);

  // per-frame JavaScript of the two parts: update + beforeRender, playing, at 1x and 16x, near the Sphere and far
  const pose = d.pose();
  const frameAt = (simMs, dt, rate) => ({ simMs, dtSimMs: dt, pose: { position: s.camera.position.clone().setY(0), s: pose.s }, camera: s.camera,
    viewport: { width: 1280, height: 720 }, night: true, sun: { elevation: -14, azimuth: 250 }, rate, playing: true });
  const bench = (rate) => {
    let simMs = NIGHT + 3600e3 * 0.37;
    const N = 3000;
    for (let i = 0; i < 300; i++) { const f = frameAt(simMs += 16.7 * rate, 16.7 * rate, rate); scr.update(f); scr.beforeRender(f); scr.afterRender(f); bb.update(f); bb.beforeRender(f); }
    let ts = 0, tb = 0;
    for (let i = 0; i < N; i++) {
      const f = frameAt(simMs += 16.7 * rate, 16.7 * rate, rate);
      const t0 = performance.now(); scr.update(f); scr.beforeRender(f); scr.afterRender(f);
      const t1 = performance.now(); bb.update(f); bb.beforeRender(f);
      tb += performance.now() - t1; ts += t1 - t0;
    }
    return { screens: +(ts / N).toFixed(4), billboards: +(tb / N).toFixed(4) };
  };
  await at(59500, NIGHT);
  out.jsNearSphere = { x1: bench(1), x16: bench(16) };
  // measured in a loop of 3,000 frames; the timer is coarse (0.1 ms) but its errors average out over the loop
  // leaving Drive: the map's clock runs again
  const night = await import('/src/night.js');
  d.exit();
  await raf(); await raf();
  const c0 = night.clock.value;
  await new Promise((r) => setTimeout(r, 800));
  out.afterExit = { clockMoved: night.clock.value !== c0, delta: +(night.clock.value - c0).toFixed(3) };
  return out;
}, { id: SPHERE, NIGHT });
console.log(JSON.stringify(result, null, 1));
await browser.close();

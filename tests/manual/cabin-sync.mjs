// The cabin's frame pass by pass, timed synchronously: with the drive paused on a settled frame, each piece of the frame
// is drawn n times in a loop, each draw followed by a one-pixel readPixels that waits for the GPU (on ANGLE's Metal
// backend gl.finish() does not wait, and timer queries span whole command buffers, so neither separates the passes).
// `none` is the wait alone (a readPixels with nothing drawn), the method's fixed cost. Each line is the median wall time of one draw and its wait (GPU and main thread in series) and, as `cpu`, the median
// time renderer.render took to return (the main thread's submission). The pieces:
//   world        renderer.render(scene, camera) to the canvas
//   mirrors      the three mirror passes (glass.mirrors.render, all due), each drawn n times
//   mirror:<n>   one mirror pass (the others' targets untouched)
//   cabin        the cabin's afterRender with the mirrors off: the glass layers, the rain copy and the cabin pass
//   cabin-veil   the same with the windshield veil off; cabin-rain with the rain on the glass off
//   world+cabin  world + cabin's afterRender with the mirrors off
//   frame        world + cabin's afterRender with every mirror (a paused frame)
//   drive        the session's own frame (drive.renderFrame, where the build has it): the passes in its order, every
//                mirror (paused); -nomask without the cabin's silhouette in the depth, -nomirrors without the mirrors
// Serve a build first, then: node tests/manual/cabin-sync.mjs <port> <device pixel ratio> '<cases>' [--n 40]
import { chromium } from '@playwright/test';
const port = process.argv[2]; const dpr = Number(process.argv[3] || 1);
const cases = JSON.parse(process.argv[4]);
const argAt = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const n = Number(argAt('--n') || 40);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
for (const c of cases) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + e.message.slice(0, 160)));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
  const q = `city=lv&mode=drive&route=${c.route}&s=${c.s}&t=${encodeURIComponent(c.t)}&view=${c.view || 'cabin'}${c.rain ? '&rain=' + c.rain : ''}`;
  await page.goto(`http://localhost:${port}/?${q}&renderer=legacy`);
  await page.waitForFunction(() => window.__skyline?.drive?.active?.() && window.__skyline.drive.pose(), null, { timeout: 120000 });
  await page.evaluate(() => window.__skyline.drive.whenSettled());
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async (n) => {
    const sk = window.__skyline, d = sk.drive, renderer = sk.renderer, gl = renderer.getContext(), scene = sk.scene, camera = sk.camera;
    d.pause();
    const cabin = d.cabin(), glass = cabin?.glass;
    // the frame and the rig's pose as the next drawn frame passes them
    let args = null;
    const origRender = glass?.mirrors?.render;
    if (glass?.mirrors) glass.mirrors.render = function (f, L, o) { args = [f, L]; return origRender.call(this, f, L, o); };
    let frame = null;
    const origAfter = cabin.afterRender;
    cabin.afterRender = function (f) { frame = f; return origAfter.call(this, f); };
    sk.invalidate();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => requestAnimationFrame(r));
    if (glass?.mirrors) glass.mirrors.render = origRender;
    cabin.afterRender = origAfter;
    const px = new Uint8Array(4);
    const wait = () => { renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
    const time = (fn) => {
      for (let i = 0; i < 5; i++) { fn(); wait(); }
      const wall = [], cpu = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now(); fn(); const t1 = performance.now(); wait();
        wall.push(performance.now() - t0); cpu.push(t1 - t0);
      }
      return { wall: med(wall), cpu: med(cpu) };
    };
    const out = {};
    out.none = time(() => {});
    out.world = time(() => renderer.render(scene, camera));
    if (glass?.mirrors && args) {
      out.mirrors = time(() => glass.mirrors.render(args[0], args[1], { all: true }));
      // one mirror at a time: the playing rotation draws one mirror a frame; each call is charged to the one it drew
      const m = glass.mirrors, buckets = {}, f = { ...args[0], playing: true };
      for (let i = 0; i < 4 * n + 8; i++) {
        const t0 = performance.now(); m.render(f, args[1]); const t1 = performance.now(); wait();
        const st = m.stamps(); const name = Object.keys(st).find((k) => st[k]?.frame === m.frame);
        if (!name || i < 8) continue;
        (buckets[name] ||= { wall: [], cpu: [] }).wall.push(performance.now() - t0); buckets[name].cpu.push(t1 - t0);
      }
      for (const [k, b] of Object.entries(buckets)) out[`mirror:${k}`] = { wall: med(b.wall), cpu: med(b.cpu) };
      glass.mirrors.setEnabled(false);
    }
    const after = () => cabin.afterRender(frame);
    out.cabin = time(after);
    if (glass?.windshield) { glass.windshield.setEnabled(false); out['cabin-veil'] = time(after); glass.windshield.setEnabled(true); }
    if (glass?.rain) { const was = glass.rain.enabled; glass.rain.setEnabled(false); glass.rain.update?.(frame, {}); out['cabin-rain'] = time(after); glass.rain.setEnabled(was); glass.rain.update?.(frame, {}); }
    out['world+cabin'] = time(() => { renderer.render(scene, camera); cabin.afterRender(frame); });
    if (glass?.mirrors) glass.mirrors.setEnabled(true);
    out.frame = time(() => { renderer.render(scene, camera); cabin.afterRender(frame); });
    if (d.renderFrame) {
      // the session's own frame (the passes in its order), every mirror due while paused; then one mirror, as playing
      out.drive = time(() => d.renderFrame());
      if (cabin.setDepthMask) { cabin.setDepthMask(false); out['drive-nomask'] = time(() => d.renderFrame()); cabin.setDepthMask(true); }
      if (glass?.mirrors) {
        glass.mirrors.setEnabled(false); out['drive-nomirrors'] = time(() => d.renderFrame());
        if (cabin.setDepthMask) { cabin.setDepthMask(false); out['drive-nomirrors-nomask'] = time(() => d.renderFrame()); cabin.setDepthMask(true); }
        glass.mirrors.setEnabled(true);
      }
    }
    const st = d.stats();
    out.info = { calls: st.render?.calls, tris: st.render?.triangles, mirrorCalls: st.cabin?.mirrors?.calls, ratio: renderer.getPixelRatio(), raining: glass?.rain?.raining };
    sk.invalidate();
    return out;
  }, n);
  console.log(`\n== ${c.name} (dpr ${dpr})`, JSON.stringify(r.info));
  for (const [k, v] of Object.entries(r)) if (k !== 'info') console.log('  ', k.padEnd(14), JSON.stringify(v));
  if (errors.length) console.log('  ERR', errors.slice(0, 2).join(' | '));
  await page.close();
}
await browser.close();

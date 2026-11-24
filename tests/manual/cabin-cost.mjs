// What the cabin costs (plan 02, third stretch: the port of the cabin, mirrors, windshield and rain on the glass), on
// this machine's GPU, on the classic renderer and both backends of plan 01's renderer in one run. Throughput, as plan 01
// measures it (src/render/perf.js): frames submitted back to back with the clock paused, then a wait for the GPU, per
// frame; GPU timer queries misread the new renderer. The mirrors are drawn in rotation as while playing (one pass a
// frame; setRotation), so a frame costs what a playing frame does, without the app's loop drawing frames of its own in
// between. The machine's load average is printed before and after each page. Each case reports the frame (`min`,
// `median`: ms per frame until the GPU is done) and the main thread's share (`cpuMin`, `cpuMedian`: ms per frame spent
// submitting, before the wait), which is what the mirrors' budget is about.
//
// Serve the repository first, then:
//   node tests/manual/cabin-cost.mjs [--port 5323] [--renderers classic,webgl,webgpu] [--sizes 1280x720,2560x1440]
//        [--frames 60] [--repeats 3] [--cases dry,dry-nomirrors,rain,clean,last,paused] [--out <file.json outside the repo>]
// Each case is measured `repeats` times, the cases interleaved (dry, rain, ..., dry, rain, ...), and reported as the
// minimum and the median over the repeats (ms per frame): on a loaded machine the minimum is the steadier figure.
// Cases: dry (the cabin view, mirrors on), dry-nomirrors (mirrors off), rain (heavy rain, 12 mm/h, wipers), clean (the
// clean view: no cabin, the baseline), last (plan 01's renderer only: the cabin drawn after the world instead of first,
// mirrors off, to see what drawing it first saves), paused (all three mirrors, as on a paused frame).
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5323));
const renderers = opt('renderers', 'classic,webgl,webgpu').split(',');
const sizes = opt('sizes', '1280x720,2560x1440').split(',').map((s) => s.split('x').map(Number));
const frames = Number(opt('frames', 60));
const repeats = Number(opt('repeats', 3));
const cases = opt('cases', 'dry,dry-nomirrors,rain,clean,last,paused').split(',');
const outFile = opt('out', null);
const Q = {
  classic: 'renderer=legacy',
  webgl: 'renderer=webgpu&backend=webgl&display=classic',
  webgpu: 'renderer=webgpu&backend=webgpu&display=classic',
};
const load = () => loadavg().map((v) => v.toFixed(0)).join(' ');

const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const rows = [];
for (const [w, h] of sizes) {
  for (const r of renderers) {
    const before = load();
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.routeWebSocket(/.*/, () => {});
    await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
    await page.goto(`http://localhost:${port}/?city=lv&${Q[r]}&parts=cabin`);
    await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive && window.__skyline?.perf, null, { timeout: 180000 });
    const res = await page.evaluate(async ({ frames, repeats, cases, legacy }) => {
      const sk = window.__skyline, d = sk.drive, perf = sk.perf;
      sk.attractions?.freeze(20);
      const t = Date.parse('2026-11-22T00:00:00Z'); // 16:00 local, the sun low and up
      await d.start('i15n', { s: 45000, t, view: 'cabin' });
      await new Promise((res) => { const f = () => (d.cabin() ? res() : setTimeout(f, 100)); f(); });
      d.pause();
      d.seek({ s: 45000, t });
      d.look({ yaw: 0, pitch: 0 });
      const c = d.cabin();
      const g = c.glass;
      await d.whenSettled();
      const time = async () => {
        for (let i = 0; i < 10; i++) d.renderFrame();
        await perf.sync();
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) d.renderFrame();
        const cpu = (performance.now() - t0) / frames; // the main thread's share: submitting, before the wait for the GPU
        await perf.sync();
        return [+((performance.now() - t0) / frames).toFixed(2), +cpu.toFixed(2)];
      };
      const set = async ({ view = 'cabin', mirrors = true, rain = 0, order = null, rotate = true }) => {
        d.setView(view);
        g.mirrors?.setEnabled(mirrors);
        g.mirrors?.setRotation(rotate);
        if (order !== null) c.setDrawOrder?.(order);
        c.weather?.setRain?.(rain);
        for (let i = 0; i < 50 && rain && !g.rain?.raining; i++) { d.renderFrame(); await new Promise((r) => setTimeout(r, 100)); }
        for (let i = 0; i < 50 && !rain && g.rain?.raining; i++) { d.renderFrame(); await new Promise((r) => setTimeout(r, 100)); }
        await d.whenSettled();
      };
      const samples = {};
      let rainOn = null;
      for (let rep = 0; rep < repeats; rep++) {
        for (const k of cases) {
          if (k === 'last' && legacy) continue;
          if (k === 'dry') await set({});
          if (k === 'dry-nomirrors') await set({ mirrors: false });
          if (k === 'rain') await set({ rain: 12 });
          if (k === 'clean') await set({ view: 'clean' });
          if (k === 'last') await set({ mirrors: false, order: 1000 });
          if (k === 'paused') await set({ rotate: false });
          (samples[k] ||= []).push(await time());
          if (k === 'rain') rainOn = !!g.rain?.raining;
          if (k === 'last') c.setDrawOrder?.(-1000);
        }
      }
      const out = { rainOn };
      for (const [k, v] of Object.entries(samples)) {
        const sorted = [...v].sort((a, b) => a[0] - b[0]);
        const cpu = v.map((x) => x[1]).sort((a, b) => a - b);
        out[k] = { min: sorted[0][0], median: sorted[Math.floor(sorted.length / 2)][0], cpuMin: cpu[0], cpuMedian: cpu[Math.floor(cpu.length / 2)] };
      }
      await set({});
      const st = c.stats();
      out.mirrorJs = st.mirrors?.js?.mean != null ? +st.mirrors.js.mean.toFixed(2) : null;
      out.mirrorSubmit = st.mirrors?.submit?.mean != null ? +st.mirrors.submit.mean.toFixed(2) : null;
      out.mirrorCalls = st.mirrors?.calls ?? null;
      out.pixelRatio = sk.renderer.getPixelRatio();
      out.size = [sk.renderer.domElement.width, sk.renderer.domElement.height];
      return out;
    }, { frames, repeats, cases, legacy: r === 'classic' });
    const after = load();
    rows.push({ renderer: r, size: `${w}x${h}`, ...res, load: `${before} -> ${after}` });
    console.log(`${`${w}x${h}`.padEnd(10)} ${r.padEnd(8)} ${JSON.stringify(res)}  load ${before} -> ${after}`);
    await page.close();
  }
}
if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 1));
await browser.close();

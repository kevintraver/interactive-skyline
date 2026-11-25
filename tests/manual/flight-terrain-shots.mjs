// Screenshots of the regional terrain harness (tests/manual/flight-terrain.html) on this machine's GPU, on both backends
// of the new renderer: the six views of flight-terrain-views.js (cruise ahead and to the right, FL180, Lake Mead at
// 10,000 ft, 3,000 ft over the east valley, 300 ft on final to 19R), each with the photos, with each grid tinted, and with
// the legacy fog's haze. Writes <backend>_<view>_<variant>.png, contact sheets sheet_<backend>_<variant>.png and
// report.txt (the region's update stats, draw calls and triangles with and without it, and the frame's cost).
//
// Serve the repo first:   pnpm exec vite --port 5371 --strictPort
// then:                   node tests/manual/flight-terrain-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--only <substring>] [--quality low|high]
// (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--backend', '--only', '--quality'].includes(args[i - 1]));
const out = positional[0];
const port = positional[1] || 5371;
const backends = flag('--backend') ? [flag('--backend')] : ['webgpu', 'webgl'];
const only = flag('--only') || '';
const quality = flag('--quality') || 'high';
if (!out) { console.error('usage: node tests/manual/flight-terrain-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--only name] [--quality low|high]'); process.exit(2); }
mkdirSync(out, { recursive: true });

const VIEWS = ['cruise', 'cruise-right', 'fl180', 'lake-mead', 'east-valley', 'final'];
const VARIANTS = { photo: {}, tint: { tint: true }, haze: { haze: true } };

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const W = 1600, H = 900;
const problems = [], report = [];
try {
  for (const backend of backends) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${backend} ${m.type()}] ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => problems.push(`[${backend} pageerror] ${e.message.slice(0, 300)}`));
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}/tests/manual/flight-terrain.html?backend=${backend}&quality=${quality}`);
    await page.waitForFunction(() => window.__ft, null, { timeout: 180000 });
    await page.evaluate(() => window.__ft.ready);
    const info = await page.evaluate(() => window.__ft.info);
    console.log(`${backend}: ${JSON.stringify(info)} (ready in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    const sheets = new Map();
    for (const [variant, o] of Object.entries(VARIANTS)) {
      for (const name of VIEWS) {
        const id = `${name}_${variant}`;
        if (only && !id.includes(only)) continue;
        const st = await page.evaluate(([n, x]) => window.__ft.view(n, x), [name, o]);
        const f = `${out}/${backend}_${id}.png`;
        await page.screenshot({ path: f, timeout: 120000 });
        if (!sheets.has(variant)) sheets.set(variant, []);
        sheets.get(variant).push([id, f]);
        const u = st.update, fr = st.frame;
        report.push(`${backend} ${quality} ${id}: ${u.triangles} tris (budget ${u.budget}), ${u.drawCalls} draws, target ${u.targetPx} px, needs ${u.needed.join('+')}, `
          + `renderer: region ${fr.regionCalls} calls ${fr.regionTriangles} tris, scene ${fr.with.calls} calls ${fr.with.triangles} tris; `
          + `frame cpu ${fr.cpuMs} ms (update ${fr.updateMs}), gpu ${fr.gpuMs} ms (${fr.gpuMethod}); far ${Math.round(st.camera.far)} m; `
          + `grids ${JSON.stringify(u.grids)}`);
        console.log(report[report.length - 1].slice(0, 260));
      }
    }
    const loaded = await page.evaluate(() => window.__ft.stats().region.loaded);
    report.push(`${backend} loaded: ${JSON.stringify(loaded)}`);
    for (const [variant, files] of sheets) await sheet(`sheet_${backend}_${variant}`, files, 3);
    await page.close();
  }
} finally {
  writeFileSync(`${out}/report.txt`, `${report.join('\n')}\n${problems.length ? `\nbrowser console:\n${[...new Set(problems)].join('\n')}\n` : ''}`);
  if (problems.length) console.log(`\nbrowser console (${problems.length}):\n${[...new Set(problems)].slice(0, 25).join('\n')}`);
  await browser.close();
}

/** A contact sheet of the PNGs, labelled, cols across. */
async function sheet(name, files, cols) {
  const w = 640, h = 360;
  const p = await browser.newPage({ viewport: { width: cols * w, height: Math.ceil(files.length / cols) * h }, deviceScaleFactor: 1 });
  const tiles = files.map(([label, f]) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${label}</figcaption></figure>`).join('');
  await p.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${w}px)}figure{margin:0;position:relative}img{width:${w}px;height:${h}px;display:block}figcaption{position:absolute;left:4px;top:2px;color:#fff;font:13px monospace;text-shadow:0 0 3px #000}</style>${tiles}`);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await p.close();
}

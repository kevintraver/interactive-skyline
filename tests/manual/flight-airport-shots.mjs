// Screenshots of the airport harness (tests/manual/flight-airport.html) on this machine's GPU, on both backends of the
// new renderer: 5 km out on a 3 degree path to 19R and to 26L, 20 km out to 26L, over the 19R threshold, at touchdown
// height from a right-hand window, a right-hand window 1 km out, and from above, each by day and by night (night shots
// caught while a flasher in view fires), plus reduced motion. Writes <backend>_<name>.png, contact sheets
// sheet_<backend>_<day|night>.png and report.txt (draw calls and triangles with and without the airport, the airport's
// own counts, and the GPU cost of the airport by throughput difference in four views).
//
// Serve the repo first:   pnpm exec vite --port 5351 --strictPort
// then:                   node tests/manual/flight-airport-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--only <substring>] [--no-cost]
// (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--backend', '--only'].includes(args[i - 1]));
const out = positional[0];
const port = positional[1] || 5351;
const backends = args.includes('--backend') ? [args[args.indexOf('--backend') + 1]] : ['webgpu', 'webgl'];
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const cost = !args.includes('--no-cost');
if (!out) { console.error('usage: node tests/manual/flight-airport-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--only name] [--no-cost]'); process.exit(2); }
mkdirSync(out, { recursive: true });

const VIEWS = ['final-19R', 'final-19R-zoom', 'final-26L', 'final-26L-zoom', 'final-26L-20km', 'final-26L-20km-zoom', 'threshold-19R', 'touchdown-19R-right', 'window-19R-1km-right', 'hold-close', 'above-field', 'above-terminal'];
const SETS = [];
for (const v of VIEWS) {
  SETS.push(['day', `day_${v}`, { view: v, night: false }]);
  SETS.push(['night', `night_${v}`, { view: v, night: true, wallS: 10, flash: true }]);
}
SETS.push(['night', 'night_final-26L_reduced-motion', { view: 'final-26L', night: true, wallS: 10, reducedMotion: true }]);
SETS.push(['night', 'night_final-26L_between-flashes', { view: 'final-26L', night: true, wallS: 10.0 }]);
const COST_VIEWS = [['night', 'final-26L'], ['night', 'touchdown-19R-right'], ['night', 'above-field'], ['day', 'above-terminal']];

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const W = 1280, H = 720;
const problems = [], report = [];
try {
  for (const backend of backends) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${backend} ${m.type()}] ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => problems.push(`[${backend} pageerror] ${e.message.slice(0, 300)}`));
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}/tests/manual/flight-airport.html?backend=${backend}`);
    await page.waitForFunction(() => window.__ap, null, { timeout: 180000 });
    await page.evaluate(() => window.__ap.ready);
    const info = await page.evaluate(() => window.__ap.info);
    console.log(`${backend}: ${JSON.stringify(info)} (ready in ${((Date.now() - t0) / 1000).toFixed(1)} s; other agents share the machine: timings inflated)`);
    report.push(`${backend} info: ${JSON.stringify(info)}`);
    const sheets = new Map();
    for (const [set, name, o] of SETS) {
      if (only && !name.includes(only)) continue;
      const st = await page.evaluate((x) => window.__ap.view(x), o);
      const f = `${out}/${backend}_${name}.png`;
      await page.screenshot({ path: f, timeout: 120000 });
      if (!sheets.has(set)) sheets.set(set, []);
      sheets.get(set).push([name, f]);
      report.push(`${backend} ${name}: ${JSON.stringify(st)}`);
    }
    for (const [set, files] of sheets) await sheet(`sheet_${backend}_${set}`, files, 3);
    if (cost && !only) {
      for (const [when, v] of COST_VIEWS) {
        await page.evaluate((x) => window.__ap.view(x), { view: v, night: when === 'night', wallS: 10 });
        const c = await page.evaluate(() => window.__ap.cost({ n: 120 }));
        report.push(`${backend} cost ${when} ${v}: ${JSON.stringify(c)}`);
        console.log(`${backend} cost ${when} ${v}: ${JSON.stringify(c)}`);
      }
    }
    console.log(`${backend}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await page.close();
  }
} finally {
  writeFileSync(`${out}/report.txt`, `${report.join('\n')}\n${problems.length ? `\nbrowser console:\n${[...new Set(problems)].join('\n')}\n` : ''}`);
  if (problems.length) console.log(`\nbrowser console (${problems.length}):\n${[...new Set(problems)].slice(0, 25).join('\n')}`);
  await browser.close();
}

/** A contact sheet of the PNGs, labelled, cols across. */
async function sheet(name, files, cols) {
  const tw = 640, th = 360;
  const p = await browser.newPage({ viewport: { width: cols * tw, height: Math.ceil(files.length / cols) * th }, deviceScaleFactor: 1 });
  const tiles = files.map(([label, f]) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${label}</figcaption></figure>`).join('');
  await p.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${tw}px)}figure{margin:0;position:relative}img{width:${tw}px;height:${th}px;display:block}figcaption{position:absolute;left:4px;top:2px;color:#fff;font:12px monospace;text-shadow:0 0 3px #000}</style>${tiles}`);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await p.close();
}

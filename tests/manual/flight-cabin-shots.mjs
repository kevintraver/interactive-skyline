// Screenshots of the window-seat harness (tests/manual/flight-cabin.html) on this machine's GPU, on both backends of
// the new renderer: four seats (the default 22F, 9F ahead of the wing, 16F over it, 22A on the left) looking out,
// forward, aft and down, in level flight and banked both ways; then the edges of the head's range (13 and 85 mm, the
// eye at the pane, the clean view, a blank-wall seat) and the airframe from outside. Writes one PNG per view and a
// contact sheet per backend and state, named <backend>_<state>_<seat>_<look>.png and sheet_<backend>_<state>.png.
//
// Serve the repo first:   pnpm exec vite --port 5311 --strictPort
// then:                   node tests/manual/flight-cabin-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--quick]
//                          [--query depth=log --prefix logdepth-]   (the WebGL2 path without clip control)
// (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--backend', '--query', '--prefix'].includes(args[i - 1]));
const query = args.includes('--query') ? `&${args[args.indexOf('--query') + 1]}` : '';
const prefix = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : '';
const out = positional[0];
const port = positional[1] || 5311;
const only = args.includes('--backend') ? [args[args.indexOf('--backend') + 1]] : ['webgpu', 'webgl'];
const quick = args.includes('--quick');
if (!out) { console.error('usage: node tests/manual/flight-cabin-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--quick]'); process.exit(2); }
mkdirSync(out, { recursive: true });

const SEATS = ['22F', '9F', '16F', '22A'];
// aft and down lean into the window, as people do: sitting back, the seat's own back fills a look aft
const LOOKS = { out: {}, fwd: { yaw: 60, pitch: -5 }, aft: { yaw: -60, pitch: -8, lean: 0.25 }, down: { pitch: -50, lean: 0.25 } };
const STATES = quick ? ['level'] : ['level', 'bankLeft', 'bankRight20'];
const EDGES = {
  'fwd13-atpane': { seat: '22F', look: { yaw: 80, pitch: -10, lens: 13, lean: 0.25, slide: 0.18 } },
  'aft13-down': { seat: '22F', look: { yaw: -80, pitch: -60, lens: 13, slide: -0.18 } },
  'down13-atpane': { seat: '22F', look: { pitch: -60, lens: 13, lean: 0.25, rise: -0.1 } },
  'up13': { seat: '22F', look: { pitch: 35, lens: 13, lean: 0.25 } },
  'out85': { seat: '22F', look: { lens: 85 } },
  'clean': { seat: '22F', look: {}, clean: true },
  'blankwall-10A': { seat: '10A', look: {} },
  'blankwall-10A-13mm': { seat: '10A', look: { lens: 13 } },
  'over-16F-down13': { seat: '16F', look: { pitch: -45, lens: 13, lean: 0.25 } },
  'ahead-9F-aft': { seat: '9F', look: { yaw: -45, pitch: -20, lens: 18, lean: 0.2 } },
};
const OUTSIDE = { 'out-front34': { azimuth: 40, elevation: 12, distance: 70 }, 'out-side': { azimuth: 90, elevation: 4, distance: 55 },
  'out-rear34': { azimuth: 150, elevation: 25, distance: 70 }, 'out-top': { azimuth: 0, elevation: 85, distance: 80 } };

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const W = 1280, H = 720;
const problems = [];
const report = [];
try {
  for (const backend of only) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${backend} ${m.type()}] ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => problems.push(`[${backend} pageerror] ${e.message.slice(0, 300)}`));
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}/tests/manual/flight-cabin.html?backend=${backend}${query}`);
    await page.waitForFunction(() => window.__cabin, null, { timeout: 180000 });
    const info = await page.evaluate(() => window.__cabin.info);
    console.log(`${backend}: ${JSON.stringify(info)} (page ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, machine loaded: inflated)`);
    const shoot = async (name) => { const f = `${out}/${prefix}${name}.png`; await page.screenshot({ path: f }); return f; };
    for (const state of STATES) {
      const files = [];
      for (const seat of SEATS) {
        for (const [look, l] of Object.entries(LOOKS)) {
          const st = await page.evaluate((o) => window.__cabin.view(o), { state, seat, look: l });
          const name = `${backend}_${state}_${seat}_${look}`;
          files.push([name, await shoot(name)]);
          report.push(`${prefix}${name}: eye ${st.eye.join(', ')} near ${st.near} far ${(st.far / 1000).toFixed(1)} km fov ${st.fov.toFixed(1)}`);
        }
      }
      await sheet(`${prefix}sheet_${backend}_${state}`, files, 4);
    }
    const edgeFiles = [];
    for (const [name, o] of Object.entries(EDGES)) {
      await page.evaluate((x) => window.__cabin.view(x), { state: 'level', ...o });
      edgeFiles.push([`${backend}_edge_${name}`, await shoot(`${backend}_edge_${name}`)]);
    }
    for (const [name, o] of Object.entries(OUTSIDE)) {
      await page.evaluate((x) => window.__cabin.outside(x), { state: 'level', ...o });
      edgeFiles.push([`${backend}_${name}`, await shoot(`${backend}_${name}`)]);
    }
    await sheet(`${prefix}sheet_${backend}_edges`, edgeFiles, 4);
    const s = await page.evaluate(() => window.__cabin.stats());
    console.log(`${backend}: airframe ${s.airframeTriangles} triangles, cabin ${s.cabinTriangles}; ${edgeFiles.length + STATES.length * 16} shots in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await page.close();
  }
} finally {
  writeFileSync(`${out}/${prefix}report.txt`, `${report.join('\n')}\n`);
  if (problems.length) console.log(`\nbrowser console (${problems.length}):\n${[...new Set(problems)].slice(0, 25).join('\n')}`);
  await browser.close();
}

/** A contact sheet of the PNGs, labelled, cols across. */
async function sheet(name, files, cols) {
  const p = await browser.newPage({ viewport: { width: cols * 480, height: Math.ceil(files.length / cols) * 290 }, deviceScaleFactor: 1 });
  const tiles = files.map(([label, f]) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${label}</figcaption></figure>`).join('');
  await p.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},480px)}figure{margin:0;position:relative}img{width:480px;height:270px;display:block}figcaption{position:absolute;left:4px;top:2px;color:#fff;font:12px monospace;text-shadow:0 0 3px #000}</style>${tiles}`);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await p.close();
}

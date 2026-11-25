// Screenshots of the window-seat harness (tests/manual/flight-cabin.html) on this machine's GPU, on both backends of
// the new renderer: the modelled cabin from the default seat and from a seat ahead of, over and behind the wing on
// each side, by day and by night (each from its default look, the window centred); the default seat's head range
// (forward, aft, down, up, 13 and 85 mm, at the pane, the clean view, the shade drawn, a blank-wall seat, an aisle
// seat); the cabin and airframe from outside (nothing of the cabin may show through the skin); and the seat map.
// Writes one PNG per view and contact sheets named sheet_<backend>_<day|night>.png, sheet_<backend>_range.png and
// seatmap_<backend>.png, plus report.txt with each view's eye, look and triangle counts.
//
// Serve the repo first:   pnpm exec vite --port 5361 --strictPort
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
const port = positional[1] || 5361;
const only = args.includes('--backend') ? [args[args.indexOf('--backend') + 1]] : ['webgpu', 'webgl'];
const quick = args.includes('--quick');
if (!out) { console.error('usage: node tests/manual/flight-cabin-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--quick]'); process.exit(2); }
mkdirSync(out, { recursive: true });

const RANGE = {
  'default': {},
  'fwd60': { look: { yaw: 60, pitch: -5 } },
  'aft60-lean': { look: { yaw: -60, pitch: -8, lean: 0.25 } },
  'down50-lean': { look: { pitch: -50, lean: 0.25 } },
  'up30': { look: { pitch: 30 } },
  '13mm': { look: { lens: 13 } },
  '85mm': { look: { lens: 85 } },
  'fwd80-13mm-atpane': { look: { yaw: 80, pitch: -10, lens: 13, lean: 0.25, slide: 0.18 } },
  'shade-closed': { shade: 1 },
  'psu-up-fwd': { look: { yaw: 75, pitch: 35, lens: 14 } },
  'seatback-fwd': { look: { yaw: 70, pitch: -25, lens: 18 } },
  'night-psu': { night: true, look: { yaw: 75, pitch: 35, lens: 14 } },
  'shade-half': { shade: 0.5 },
  'clean': { clean: true },
  'blankwall-10A': { seat: '10A' },
  'aisle-23D': { seat: '23D' },
  'middle-23E': { seat: '23E' },
  'night-lights-full': { night: true, cabinLight: 1 },
  'night-lights-off': { night: true, cabinLight: 0 },
};
const OUTSIDE = { 'out-side': { azimuth: 90, elevation: 4, distance: 30 }, 'out-front34': { azimuth: 40, elevation: 12, distance: 50 } };

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
    const seats = { right: await page.evaluate(() => window.__cabin.seats('right')), left: await page.evaluate(() => window.__cabin.seats('left')) };
    const list = [];
    for (const side of quick ? ['right'] : ['right', 'left']) for (const [where, id] of Object.entries(seats[side])) if (!list.some((x) => x.id === id)) list.push({ where: `${side}-${where}`, id });
    for (const night of quick ? [false] : [false, true]) {
      const files = [];
      for (const s of list) {
        const st = await page.evaluate((o) => window.__cabin.view(o), { seat: s.id, night });
        const name = `${backend}_${night ? 'night' : 'day'}_${s.where}_${s.id}`;
        files.push([name, await shoot(name)]);
        report.push(`${prefix}${name}: eye ${st.eye.join(', ')} look ${JSON.stringify(Object.fromEntries(Object.entries(st.look).map(([k, v]) => [k, +v.toFixed(3)])))} cabin ${st.cabinTriangles} tris ${st.cabinDrawCalls} draws, airframe ${st.airframeTriangles}, frame draws ${st.drawCalls}`);
      }
      await sheet(`${prefix}sheet_${backend}_${night ? 'night' : 'day'}`, files, 4);
    }
    const range = [];
    for (const [name, o] of Object.entries(RANGE)) {
      if (quick && !['default', 'fwd60', 'shade-closed', 'blankwall-10A'].includes(name)) continue;
      const st = await page.evaluate((x) => window.__cabin.view(x), { seat: seats.right.default, ...o });
      range.push([`${backend}_range_${name}`, await shoot(`${backend}_range_${name}`)]);
      report.push(`${prefix}${backend}_range_${name}: seat ${st.seat} eye ${st.eye.join(', ')} look ${JSON.stringify(Object.fromEntries(Object.entries(st.look).map(([k, v]) => [k, +v.toFixed(3)])))}`);
    }
    for (const [name, o] of Object.entries(OUTSIDE)) {
      await page.evaluate((x) => window.__cabin.outside(x), o);
      range.push([`${backend}_${name}`, await shoot(`${backend}_${name}`)]);
    }
    await sheet(`${prefix}sheet_${backend}_range`, range, 4);
    await page.evaluate((x) => window.__cabin.view(x), { seat: seats.right.default });
    const m = await page.evaluate(() => window.__cabin.seatMap({ stripSide: 'right', focus: '16F' }));
    await page.screenshot({ path: `${out}/${prefix}seatmap_${backend}.png` });
    report.push(`${prefix}seatmap_${backend}: ${JSON.stringify(m)}`);
    const s = await page.evaluate(() => window.__cabin.stats());
    console.log(`${backend}: airframe ${s.airframeTriangles} triangles, cabin ${s.cabinTriangles} in ${s.cabinDrawCalls} draws; ${list.length * 2 + range.length + 1} shots in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
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

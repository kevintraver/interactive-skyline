// Screenshots of the airframe harness (tests/manual/flight-airframe.html) on this machine's GPU, on both backends of the
// new renderer: from seat 22F and from outside, the synthetic arrival stepped through its configurations (clean wing in
// the descent, slats and flaps 1, 5, 15, 30, 40, gear down, touchdown with the spoilers up and the tip dropped,
// reversers open, flaps retracting on the taxiway), then a night set with each lamp group alone and all together.
// Writes <backend>_<name>.png, contact sheets sheet_<backend>_<set>.png and report.txt (state, tips, lamp levels,
// draw calls and triangles with and without the airframe, the model's update time).
//
// Serve the repo first:   pnpm exec vite --port 5331 --strictPort
// then:                   node tests/manual/flight-airframe-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--only <substring>]
// (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--backend', '--only'].includes(args[i - 1]));
const out = positional[0];
const port = positional[1] || 5331;
const backends = args.includes('--backend') ? [args[args.indexOf('--backend') + 1]] : ['webgpu', 'webgl'];
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
if (!out) { console.error('usage: node tests/manual/flight-airframe-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--only name]'); process.exit(2); }
mkdirSync(out, { recursive: true });

// the wing from 22F: the passenger's default look (26 mm), and the clean view (eye at the pane, no cabin) on an 18 mm
// lens turned toward the wing, which takes in root to tip as a phone held to the window does
const WING = {};
const WIDE = { look: { yaw: 40, pitch: -15, lens: 18 }, clean: true };
const TAXI = { groundSpoiler: 0, reverser: 0 };
const CONFIG = {
  '01-clean-descent': { t: 200 },
  '02-slats-flaps1': { t: 330 },
  '03-flaps5': { t: 400 },
  '04-flaps15-gear': { t: 440 },
  '05-flaps30': { t: 480 },
  '06-flaps40': { t: 480, set: { flap: 40 } },
  '07-touchdown': { t: 540.2 },
  '08-spoilers-tipdown': { t: 542 },
  '09-reversers': { t: 548 },
  '10-taxi-flaps15': { t: 600, set: { ...TAXI, flap: 15 } },
  '11-taxi-flaps5': { t: 600, set: { ...TAXI, flap: 5, slat: 1 } },
  '12-taxi-clean': { t: 600, set: { ...TAXI, flap: 0, slat: 0 } },
};
const OUTSIDE = {
  rear34: { azimuth: 135, elevation: 18, distance: 32, lens: 28, target: [9, 2.5, 2] },
  under: { azimuth: 60, elevation: -20, distance: 38, lens: 28, target: [3, 1.5, -2] },
  side: { azimuth: 90, elevation: 3, distance: 60, lens: 35, target: [0, 3, -4] },
};
const SETS = [];
for (const [name, c] of Object.entries(CONFIG)) {
  SETS.push(['day-seat', `seat_${name}`, { ...c, seat: '22F', look: WING }]);
  SETS.push(['day-wide', `wide_${name}`, { ...c, seat: '22F', ...WIDE }]);
  for (const [o, cam] of Object.entries(OUTSIDE)) SETS.push([`day-out-${o}`, `out-${o}_${name}`, { ...c, outside: cam }]);
}
// the night: each lamp group alone at its brightest moment, then all; flashes caught at their peaks
const N = { NAV: 1, BEACON: 2, STROBE: 4, LANDING: 8, TAXI: 16, TURNOFF: 32, LOGO: 64, WING: 128 };
const PEAK = { BEACON: 0.65, STROBE: 0.04 };
const nightAt = { t: 480, night: true };
for (const [g, bit] of Object.entries(N)) {
  const c = { ...nightAt, set: { lights: bit }, wallS: PEAK[g] ?? 0.3 };
  SETS.push(['night-seat', `night-seat_${g}`, { ...c, seat: '22F', ...WIDE }]);
  SETS.push(['night-out', `night-out_${g}`, { ...c, outside: OUTSIDE.rear34 }]);
}
for (const [label, wallS] of [['all-strobe', 0.04], ['all-beacon', 0.65], ['all-dark', 0.3]]) {
  SETS.push(['night-seat', `night-seat_${label}`, { ...nightAt, set: { lights: 255 }, wallS, seat: '22F', look: WING }]);
  SETS.push(['night-out', `night-out_${label}`, { ...nightAt, set: { lights: 255 }, wallS, outside: OUTSIDE.side }]);
  SETS.push(['night-out', `night-front_${label}`, { ...nightAt, set: { lights: 255 }, wallS, outside: { azimuth: 30, elevation: 8, distance: 45, lens: 28, target: [0, 2.5, -6] } }]);
}
// the flex: the tip in flight and at touchdown against the wing held at its ground shape, seen along the span from behind
const ALONG = { azimuth: 172, elevation: 2, distance: 30, lens: 50, target: [10, 3, 2] };
for (const [name, c] of [['flight', { t: 480 }], ['touchdown-spoilers', { t: 542 }]]) {
  SETS.push(['flex', `flex_${name}`, { ...c, outside: ALONG }]);
  SETS.push(['flex', `flex_${name}_ground-shape`, { ...c, outside: ALONG, flex: false }]);
}
SETS.push(['night-seat', 'night-seat_reduced-motion', { ...nightAt, set: { lights: 255 }, wallS: 0.04, reducedMotion: true, seat: '22F', look: WING }]);
SETS.push(['night-seat', 'night-seat_touchdown-all', { t: 545, night: true, set: { lights: 255 }, wallS: 0.3, seat: '22F', look: WING }]);

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
    await page.goto(`http://localhost:${port}/tests/manual/flight-airframe.html?backend=${backend}`);
    await page.waitForFunction(() => window.__af, null, { timeout: 180000 });
    await page.evaluate(() => window.__af.ready);
    const info = await page.evaluate(() => window.__af.info);
    console.log(`${backend}: ${JSON.stringify(info)} (ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, machine loaded: inflated)`);
    const sheets = new Map();
    for (const [set, name, o] of SETS) {
      if (only && !name.includes(only)) continue;
      const st = await page.evaluate((x) => window.__af.view(x), o);
      const f = `${out}/${backend}_${name}.png`;
      await page.screenshot({ path: f, timeout: 120000 });
      if (!sheets.has(set)) sheets.set(set, []);
      sheets.get(set).push([name, f]);
      report.push(`${backend} ${name}: ${JSON.stringify(st)}`);
    }
    for (const [set, files] of sheets) await sheet(`sheet_${backend}_${set}`, files, 4);
    console.log(`${backend}: ${report.length} shots so far, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await page.close();
  }
} finally {
  writeFileSync(`${out}/report.txt`, `${report.join('\n')}\n${problems.length ? `\nbrowser console:\n${[...new Set(problems)].join('\n')}\n` : ''}`);
  if (problems.length) console.log(`\nbrowser console (${problems.length}):\n${[...new Set(problems)].slice(0, 25).join('\n')}`);
  await browser.close();
}

/** A contact sheet of the PNGs, labelled, cols across. */
async function sheet(name, files, cols) {
  const p = await browser.newPage({ viewport: { width: cols * 480, height: Math.ceil(files.length / cols) * 270 }, deviceScaleFactor: 1 });
  const tiles = files.map(([label, f]) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${label}</figcaption></figure>`).join('');
  await p.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},480px)}figure{margin:0;position:relative}img{width:480px;height:270px;display:block}figcaption{position:absolute;left:4px;top:2px;color:#fff;font:12px monospace;text-shadow:0 0 3px #000}</style>${tiles}`);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await p.close();
}

// Screenshots of the window-pane harness (tests/manual/flight-window.html) on this machine's GPU, on both backends of
// the new renderer, each view with the pane on and beside it the same view with the pane off: by day with the sun at
// several angles to the line of sight through the window (scratches and dirt flaring near it, nothing with it behind),
// at cruise with the journey's frost (focused far and on the pane), on the descent with the frost melting, in rain on
// approach and taxiing, and at night over a field of lamps with the cabin lights full, dimmed and off. Then the pane's
// frame cost: throughput with the pane on and off, at the default look and leaning in with the window filling the view.
// Writes one PNG per view, contact sheets sheet_<backend>_<group>.png (pairs: pane on | pane off), and report.txt.
//
// Serve the repo first:   pnpm exec vite --port 5391 --strictPort
// then:                   node tests/manual/flight-window-shots.mjs <out-dir> [port] [--backend webgl|webgpu]
//                          [--quality low|high|ultra] [--only <view,...>] [--no-cost]
// (keep the out dir outside the repo)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && !['--backend', '--quality', '--only'].includes(args[i - 1]));
const out = positional[0];
const port = positional[1] || 5391;
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu', 'webgl'];
const quality = opt('--quality') || 'high';
const only = opt('--only') ? opt('--only').split(',') : null;
const cost = !args.includes('--no-cost');
if (!out) { console.error('usage: node tests/manual/flight-window-shots.mjs <out-dir> [port] [--backend webgl|webgpu] [--quality q] [--only a,b]'); process.exit(2); }
mkdirSync(out, { recursive: true });

const clear = { frost: 0, fog: 0, wet: 0, mist: 0, rainRateMmH: 0 };
/** group -> view name -> __win.view() options (each is also shot with the pane off). */
const GROUPS = {
  sun: {
    'sun-4': { state: 'cruise', pane: clear, sun: { angle: 4 } },
    'sun-12': { state: 'cruise', pane: clear, sun: { angle: 12 } },
    'sun-30': { state: 'cruise', pane: clear, sun: { angle: 30 } },
    'sun-60': { state: 'cruise', pane: clear, sun: { angle: 60 } },
    'sun-fwd25-up12': { state: 'cruise', pane: clear, sun: { angle: 12, az: 25 } },
    'sun-behind': { state: 'cruise', pane: clear, sun: { angle: 30, az: 180 } },
  },
  frost: {
    'cruise-frost': { state: 'cruise', sun: { angle: 40 } },
    'cruise-frost-sun10': { state: 'cruise', sun: { angle: 10 } },
    'cruise-frost-focus-pane': { state: 'cruise', sun: { angle: 40 }, focus: 'pane' },
    'cruise-frost-lean': { state: 'cruise', sun: { angle: 40 }, look: { lean: 0.22, pitch: -12 } },
    'descent-melting': { state: 'descent', sun: { angle: 40 } },
    'descent-fog': { state: 'descent', t: 1015, sun: { angle: 40 } },
    'debug-ice': { state: 'cruise', sun: { angle: 40 }, debug: 1 },
    'debug-front': { state: 'cruise', sun: { angle: 40 }, debug: 2 },
    'debug-arrival': { state: 'cruise', sun: { angle: 40 }, debug: 3 },
  },
  rain: {
    'approach-rain': { state: 'approach', pane: { ...clear, wet: 0.85, rainRateMmH: 6 }, sun: { angle: 50 } },
    'approach-rain-focus-pane': { state: 'approach', pane: { ...clear, wet: 0.85, rainRateMmH: 6 }, sun: { angle: 50 }, focus: 'pane' },
    'taxi-rain': { state: 'taxi', pane: { ...clear, wet: 0.8, rainRateMmH: 4 }, sun: { angle: 50 } },
    'taxi-rain-focus-pane': { state: 'taxi', pane: { ...clear, wet: 0.8, rainRateMmH: 4 }, sun: { angle: 50 }, focus: 'pane' },
    'debug-drops-approach': { state: 'approach', pane: { ...clear, wet: 0.85, rainRateMmH: 6 }, focus: 'pane', debug: 4 },
    'cloud-mist': { state: 'descent', pane: { ...clear, mist: 0.9 }, sun: { angle: 50 } },
  },
  night: {
    'night-lights-full': { state: 'approach', night: true, cabinLight: 1 },
    'night-lights-dim': { state: 'approach', night: true, cabinLight: 0.3 },
    'night-lights-off': { state: 'approach', night: true, cabinLight: 0 },
    'night-full-down': { state: 'approach', night: true, cabinLight: 1, look: { pitch: -25, lean: 0.15 } },
    'night-dim-rain': { state: 'approach', night: true, cabinLight: 0.3, pane: { ...clear, wet: 0.8, rainRateMmH: 5 } },
    'night-cruise-frost': { state: 'cruise', night: true, cabinLight: 0.3 },
  },
};

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const W = 1280, H = 720;
const problems = [];
const report = [];
try {
  for (const backend of backends) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${backend} ${m.type()}] ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => problems.push(`[${backend} pageerror] ${e.message.slice(0, 300)}`));
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}/tests/manual/flight-window.html?backend=${backend}&quality=${quality}`);
    await page.waitForFunction(() => window.__win, null, { timeout: 180000 });
    const info = await page.evaluate(() => window.__win.info);
    console.log(`${backend}: ${JSON.stringify(info)} (ready in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    report.push(`${backend} ${quality}: ${JSON.stringify(info)}`);
    for (const [group, views] of Object.entries(GROUPS)) {
      const files = [];
      for (const [name, o] of Object.entries(views)) {
        if (only && !only.includes(name) && !only.includes(group)) continue;
        for (const paneOn of [true, false]) {
          const st = await page.evaluate((x) => window.__win.view(x), { ...o, paneOn });
          const file = `${out}/${backend}_${name}${paneOn ? '' : '_off'}.png`;
          await page.screenshot({ path: file });
          files.push([`${name}${paneOn ? '' : ' (pane off)'}`, file]);
          if (paneOn) report.push(`${backend} ${name}: t ${st.t.toFixed(0)} pane ${JSON.stringify(Object.fromEntries(Object.entries(st.pane).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])))} sunE ${st.sunE.toFixed(3)} reflection ${st.reflection.toFixed(3)} captures ${st.captures} draws ${st.drawCalls} taps ${st.taps}`);
        }
      }
      if (files.length) await sheet(`sheet_${backend}_${group}`, files, 4);
    }
    // F5.2's acceptance: with every effect off the view equals the plain composite within one grey level
    for (const [name, o] of Object.entries({ 'check-day': { state: 'cruise', sun: { angle: 12 } }, 'check-night': { state: 'approach', night: true, cabinLight: 1 } })) {
      const none = { frost: false, condensation: false, droplets: false, scratches: false, reflections: false, transmission: false };
      await page.evaluate((x) => window.__win.view(x), { ...o, effects: none, paneOn: true });
      const a = await page.screenshot();
      await page.evaluate((x) => window.__win.view(x), { ...o, paneOn: false });
      const b = await page.screenshot();
      writeFileSync(`${out}/${backend}_${name}_effects-off.png`, a);
      writeFileSync(`${out}/${backend}_${name}_pane-off.png`, b);
      const d = await diff(a, b);
      // and the pane is drawn there at all: with its effects on (the stack's loss alone) the window changes
      await page.evaluate((x) => window.__win.view(x), { ...o, paneOn: true });
      const on = await diff(await page.screenshot(), b);
      const drawn = on.over1 > 10000;
      const line = `${backend} ${name}: every effect off against the pane off: max difference ${d.max} grey levels, ${d.over1} pixels over 1 of ${d.n} (${d.max <= 1 && drawn ? 'PASS' : 'FAIL'}; with the effects on ${on.over1} pixels differ, so the pane ${drawn ? 'is' : 'is NOT'} drawn)`;
      console.log(line);
      report.push(line);
    }
    if (cost) {
      for (const [name, o] of Object.entries({ default: { state: 'cruise', sun: { angle: 30 } }, 'lean-in': { state: 'cruise', sun: { angle: 30 }, look: { lean: 0.25, lens: 18 } },
        'rain-lean-in': { state: 'approach', pane: { ...clear, wet: 0.85, rainRateMmH: 6 }, look: { lean: 0.25, lens: 18 } },
        // every effect off: what the copy of the frame, its mips and the kept multisampled buffers cost alone
        'lean-in-effects-off': { state: 'cruise', pane: clear, look: { lean: 0.25, lens: 18 },
          effects: { frost: false, condensation: false, droplets: false, scratches: false, reflections: false, transmission: false } } })) {
        await page.evaluate((x) => window.__win.view(x), o);
        const runs = [];
        for (let k = 0; k < 3; k++) {
          const on = await page.evaluate(() => window.__win.cost({ frames: 120, paneOn: true }));
          const off = await page.evaluate(() => window.__win.cost({ frames: 120, paneOn: false }));
          runs.push([on.msPerFrame, off.msPerFrame]);
        }
        const med = (i) => runs.map((r) => r[i]).sort((a, b) => a - b)[1];
        const line = `${backend} ${quality} cost ${name}: pane on ${med(0).toFixed(2)} ms, off ${med(1).toFixed(2)} ms, pane ${(med(0) - med(1)).toFixed(2)} ms per frame (median of 3 x 120 frames, throughput) runs ${JSON.stringify(runs.map((r) => r.map((v) => +v.toFixed(2))))}`;
        console.log(line);
        report.push(line);
      }
    }
    const s = await page.evaluate(() => window.__win.stats());
    report.push(`${backend} stats: ${JSON.stringify(s)}`);
    await page.close();
  }
} finally {
  writeFileSync(`${out}/report.txt`, `${report.join('\n')}\n`);
  if (problems.length) console.log(`\nbrowser console (${problems.length}):\n${[...new Set(problems)].slice(0, 25).join('\n')}`);
  await browser.close();
}

/** Per-channel difference of two PNG screenshots (decoded in a page): { max, over1, n }. */
async function diff(a, b) {
  const p = await browser.newPage();
  const r = await p.evaluate(async ([x, y]) => {
    const load = async (s) => { const im = new Image(); im.src = `data:image/png;base64,${s}`; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const [A, B] = [await load(x), await load(y)];
    let max = 0, over1 = 0;
    for (let i = 0; i < A.length; i += 4) {
      // the bottom 28 rows hold the harness's log line, which names the pane's state
      const row = Math.floor(i / 4 / 1280);
      if (row >= 720 - 28) continue;
      const m = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      if (m > max) max = m;
      if (m > 1) over1++;
    }
    return { max, over1, n: A.length / 4 };
  }, [a.toString('base64'), b.toString('base64')]);
  await p.close();
  return r;
}

/** A contact sheet of the PNGs, labelled, cols across. */
async function sheet(name, files, cols) {
  const p = await browser.newPage({ viewport: { width: cols * 480, height: Math.ceil(files.length / cols) * 290 }, deviceScaleFactor: 1 });
  const tiles = files.map(([label, f]) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${label}</figcaption></figure>`).join('');
  await p.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},480px)}figure{margin:0;position:relative}img{width:480px;height:270px;display:block}figcaption{position:absolute;left:4px;top:2px;color:#fff;font:12px monospace;text-shadow:0 0 3px #000}</style>${tiles}`);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await p.close();
}

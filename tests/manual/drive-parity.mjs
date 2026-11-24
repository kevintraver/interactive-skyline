// The drive's parity tool (plan 02, third stretch, decision 1): the same place, moment and parts drawn on the classic
// renderer and on plan 01's renderer at the classic display (`?display=classic`: ACES, exposure 1, no bloom), once per
// backend of the new renderer, on this machine's GPU. Prints the mean absolute difference of every frame against a
// limit and writes both pictures and a difference picture. The exit code is the verdict: 0 when every shot passes.
//
// Serve the repository first (source or build), then:
//   node tests/manual/drive-parity.mjs [--port 5311] [--out <dir outside the repo>] [--shots <file.json | JSON>]
//        [--backends webgl,webgpu] [--limit 2] [--only <name,...>] [--shipped]
//
// A shot: { name, route, s (metres along the route's road), t ('day' | 'night' | ISO time | ms), view ('clean'),
//   look ({ yaw, pitch, lens }), target (a removable building's id: the head turns to it, then look.lens applies),
//   parts ('none', 'a,b', or 'all' for no ?parts= at all), rain (a preset or mm/h), query (more address parameters for
//   both renderers, e.g. 'weathersky=off'), limit (percent), reason }.
// Without --shots the static-world set below runs. A shot's `limit` replaces the default for that shot only, and
// should carry a `reason`.
//
// Honest: canvas pixels only (the frame is drawn and read in one task; the interface is not in it). Deterministic:
// the drive's clock is paused, the extras' show clock frozen (attractions.freeze), the exposure held by the classic
// display. Fast: one page per renderer and parts set, reused for every shot; a route change is the drive's own.
//
// --shipped also writes the new renderer's frame in the shipped look (no display=classic) next to the others, for
// looking at; it is not compared.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const port = Number(opt('port', 5311));
const out = opt('out', `/private/tmp/drive-parity-${Date.now()}`);
const backends = opt('backends', 'webgl,webgpu').split(',').filter(Boolean);
const defaultLimit = Number(opt('limit', 2));
const only = opt('only', null)?.split(',');
const shipped = flag('shipped');
const W = 1280, H = 720;

/** Times of the static-world set: 12:30 and 21:00 Pacific on 21 November 2026. */
const TIMES = { day: '2026-11-21T20:30:00Z', night: '2026-11-22T05:00:00Z' };

// The static world: parts none, clean camera, by day and at night on all three routes. The places: the Hoover Dam
// bridge, an interchange with decks overhead, corridor buildings near, and the skyline from 20 km and more.
const STRAT = 'w135457469'; // the Strat, the reveal's target in routes.json
const PLACES = [
  // the Hoover Dam patch: Black Canyon and the water below the bridge's Nevada end, where US-93 begins
  { name: 'us93-dam', route: 'us93', s: 5, look: { yaw: -110, pitch: -6, lens: 20 } },
  // the Strip from Railroad Pass, about 27 km away
  { name: 'us93-skyline', route: 'us93', s: 25500, target: STRAT, look: { lens: 100 } },
  { name: 'us93-corridor', route: 'us93', s: 47700, look: { yaw: 30, lens: 35 } },
  // the Strip from I-15 past Sloan, about 20 km away
  { name: 'i15n-skyline', route: 'i15n', s: 45000, target: STRAT, look: { lens: 100 } },
  // decks overhead: the crossing at s 44.5 km, and Tropicana Avenue's interchange
  { name: 'i15n-decks', route: 'i15n', s: 44750, look: { pitch: 10, lens: 24 } },
  { name: 'i15n-tropicana', route: 'i15n', s: 57700, look: { pitch: 3, lens: 30 } },
  // corridor buildings near: the resort towers by Flamingo
  { name: 'i15n-corridor', route: 'i15n', s: 61500, look: { yaw: 45, lens: 30 } },
  { name: 'i15s-apex', route: 'i15s', s: 7600, look: { lens: 50 } },
  { name: 'i15s-corridor', route: 'i15s', s: 36500, look: { yaw: 30, lens: 35 } },
];
const DEFAULT_SHOTS = PLACES.flatMap((p) => ['day', 'night'].map((t) => ({ ...p, name: `${p.name}-${t}`, t, view: 'clean', parts: 'none' })));

function readShots() {
  const v = opt('shots', null);
  if (!v) return DEFAULT_SHOTS;
  return JSON.parse(existsSync(v) ? readFileSync(v, 'utf8') : v);
}
const shots = readShots().filter((s) => !only || only.includes(s.name));
mkdirSync(out, { recursive: true });

// ------------------------------------------------------------------ PNG writing (RGBA, 8 bit), no dependency
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Mean absolute difference of RGB, percent of full scale, and an amplified difference picture. */
function compare(a, b) {
  const n = a.length / 4, diff = Buffer.alloc(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.abs(a[i + c] - b[i + c]);
      d += v;
      diff[i + c] = Math.min(255, v * 4);
    }
    diff[i + 3] = 255;
    sum += d;
  }
  return { mad: (sum / (n * 3 * 255)) * 100, diff };
}

// ------------------------------------------------------------------ the browser
const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    // no test reaches a real weather service (as playwright.config.js)
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
const RENDERERS = {
  classic: 'renderer=legacy',
  webgl: 'renderer=webgpu&backend=webgl&display=classic',
  webgpu: 'renderer=webgpu&backend=webgpu&display=classic',
  'shipped-webgpu': 'renderer=webgpu&backend=webgpu',
};
const pages = new Map(); // `${renderer}|${parts}|${rain}` -> page

async function pageFor(renderer, shot) {
  const parts = shot.parts ?? 'none', rain = shot.rain ?? '', extra = shot.query ?? ''; // query: more address parameters, both renderers (weather port)
  const key = `${renderer}|${parts}|${rain}|${extra}`;
  if (pages.has(key)) return pages.get(key);
  // one page per renderer at a time: a page for another parts set replaces the last one
  for (const [k, p] of pages) if (k.startsWith(`${renderer}|`)) { await p.close(); pages.delete(k); }
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.problems = [];
  await page.routeWebSocket(/.*/, () => {}); // a dev server's hot-update socket answered silently: other work in the checkout must not reload the page (weather port)
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page.problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => page.problems.push(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  // parts 'all' leaves the parameter out: every part the renderer runs (and an older build without ?parts= takes the same address)
  const q = `city=lv&${RENDERERS[renderer]}${parts === 'all' ? '' : `&parts=${encodeURIComponent(parts)}`}${rain ? `&rain=${encodeURIComponent(rain)}` : ''}${extra ? `&${extra}` : ''}`;
  await page.goto(`http://localhost:${port}/?${q}`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 180000 });
  page.info = await page.evaluate(async () => {
    const s = window.__skyline;
    s.attractions.freeze(20);
    await s.attractions.ready;
    return s.rendererInfo || { kind: 'legacy' };
  });
  pages.set(key, page);
  return page;
}

/** Draw the shot on a page and read the canvas: { rgba, ms, pose } or { error }. */
async function grab(page, shot) {
  const t = TIMES[shot.t] ?? shot.t;
  const t0 = Date.now();
  const r = await page.evaluate(async ({ route, s, t, view, look, target }) => {
    const sk = window.__skyline, d = sk.drive;
    const tMs = typeof t === 'number' ? t : Date.parse(t);
    const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);
    try {
      if (!d.active() || d.route()?.id !== route) await withTimeout(d.start(route, { s, t: tMs, view }), 120000, 'drive.start');
      d.pause();
      d.setView(view);
      d.seek({ s, t: tMs });
      d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
      if (target) { d.lookAtBuilding(target); if (look.lens) d.look({ lens: look.lens }); }
      await withTimeout(d.whenSettled(), 90000, 'drive.whenSettled');
      for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
      // draw and read in one task: neither WebGPU nor the new renderer's WebGL2 backend keeps the drawing buffer
      const canvas = sk.renderer.domElement;
      d.renderFrame();
      const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('the canvas gave no picture'))), 'image/png'));
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let bin = '';
      for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
      const p = d.pose();
      return { w: bmp.width, h: bmp.height, b64: btoa(bin), pose: { s: Math.round(p.s), sun: Math.round(p.sunElevation * 10) / 10 } };
    } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
  }, { route: shot.route, s: shot.s, t, view: shot.view ?? 'clean', look: shot.look ?? {}, target: shot.target ?? null });
  if (r.error) return r;
  return { rgba: Buffer.from(r.b64, 'base64'), w: r.w, h: r.h, pose: r.pose, ms: Date.now() - t0 };
}

const rows = [];
let failed = 0;
const started = Date.now();
console.log(`out: ${out}`);
for (const shot of shots) {
  const limit = shot.limit ?? defaultLimit;
  const ref = await grab(await pageFor('classic', shot), shot);
  if (ref.error) { console.log(`${shot.name.padEnd(24)} classic  ERROR ${ref.error}`); failed++; rows.push({ shot: shot.name, backend: 'classic', error: ref.error }); continue; }
  writeFileSync(join(out, `${shot.name}.classic.png`), png(ref.w, ref.h, ref.rgba));
  for (const backend of backends) {
    const page = await pageFor(backend, shot);
    const got = await grab(page, shot);
    if (got.error || got.w !== ref.w || got.h !== ref.h) {
      const why = got.error || `size ${got.w}x${got.h} against ${ref.w}x${ref.h}`;
      console.log(`${shot.name.padEnd(24)} ${backend.padEnd(7)}  FAIL  ${why}`);
      failed++; rows.push({ shot: shot.name, backend, error: why });
      continue;
    }
    const { mad, diff } = compare(ref.rgba, got.rgba);
    const pass = mad <= limit;
    if (!pass) failed++;
    writeFileSync(join(out, `${shot.name}.${backend}.png`), png(got.w, got.h, got.rgba));
    writeFileSync(join(out, `${shot.name}.${backend}.diff.png`), png(got.w, got.h, diff));
    rows.push({ shot: shot.name, backend, mad: Math.round(mad * 100) / 100, limit, pass, pose: got.pose, ms: got.ms });
    console.log(`${shot.name.padEnd(24)} ${backend.padEnd(7)}  ${mad.toFixed(2).padStart(6)} %  (limit ${limit} %)  ${pass ? 'PASS' : 'FAIL'}  s ${got.pose.s} sun ${got.pose.sun}  ${got.ms} ms${shot.reason ? `  [${shot.reason}]` : ''}`);
  }
  if (shipped) {
    const got = await grab(await pageFor('shipped-webgpu', shot), shot);
    if (!got.error) writeFileSync(join(out, `${shot.name}.shipped.png`), png(got.w, got.h, got.rgba));
    else console.log(`${shot.name.padEnd(24)} shipped  ERROR ${got.error}`);
  }
}
for (const [key, page] of pages) {
  const info = page.info ? `${page.info.kind}/${page.info.backend || 'webgl'}` : '';
  const problems = [...new Set(page.problems)];
  if (problems.length) console.log(`\n${key} (${info}) said:\n  ${problems.slice(0, 12).join('\n  ')}${problems.length > 12 ? `\n  ... ${problems.length - 12} more` : ''}`);
}
writeFileSync(join(out, 'parity.json'), JSON.stringify({ rows, failed, seconds: (Date.now() - started) / 1000 }, null, 1));
console.log(`\n${rows.length} comparisons, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s; images in ${out}`);
await browser.close();
process.exit(failed ? 1 : 0);

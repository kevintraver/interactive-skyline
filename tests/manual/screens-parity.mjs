// Parity of the screens and billboards parts between the classic renderer and plan 01's (plan 02, third stretch,
// decision 1), measured where the part draws. The parity tool (drive-parity.mjs) compares whole frames, and a billboard
// is a few thousand pixels of 921,600: with every board missing on the new renderer its frames still pass at 2 %. This
// runs the parity tool on each shot twice, with the part and with `parts=none`, and compares only the part's pixels:
//
//   mask      the pixels where the classic renderer's frame with the part differs from its frame without it by more
//             than MASK_STEP (of 765, summed over R, G, B): the boards, their faces, the Sphere's lit patch
//   masked    the mean absolute difference over the mask between the classic frame and the new renderer's, percent
//   missing   the share of the mask where the new frame is nearer the classic frame without the part than with it:
//             the part's pixels the new renderer did not draw
// A shot passes when masked <= its limit and missing <= MISSING_MAX. The whole-frame figure is printed as well.
//
// The Sphere's lit patch cannot be judged from the road: from I-15 its light covers at most 59 pixels of a frame (the
// Sphere stands 1.3 km off the road and lights 900 m around it). So the patch is drawn from a probe camera 350 m up and
// 350 m south-east of the ground at the Sphere (as screens-probe.mjs does on the classic renderer), on each renderer at
// the classic display, with the light on and off, the Sphere shown, moved (200 m west, 150 m north) and hidden. The
// mask is where the classic renderer's light-on frame differs from its light-off frame; the masked and missing
// figures are as above, and the patch's centroid (weighted by the light's added brightness, on each renderer) must lie
// within CENTROID_SHARE of the patch's size of the classic renderer's.
//
// Serve the repository first, then:
//   node tests/manual/screens-parity.mjs [--port 5322] [--out <dir outside the repo>] [--backends webgl,webgpu]
//        [--only <name,...>] [--shipped]
// The exit code is the verdict.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = opt('port', '5322');
const out = opt('out', `/private/tmp/screens-parity-${Date.now()}`);
const backends = opt('backends', 'webgl,webgpu');
const only = opt('only', null)?.split(',');
const MASK_STEP = 24;
const MISSING_MAX = 2; // percent of the mask
const LIMIT = 6; // percent, masked
const SPHERE = 'w976405284';
const NIGHT_MS = Date.parse('2026-11-22T05:00:00Z');
const CENTROID_SHARE = 0.02; // the patch's centroid within 2 % of its size (the square root of its lit pixels) of the classic renderer's

// The two digital places look down the road at boards out to 10 km. Beyond about 1.7 km the classic renderer's depth
// buffer (24 bits, near plane 1 m) resolves less than the 0.32 m between a face and its frame, so there the frame
// z-fights through the face (dark bars); plan 01's reversed depth draws the face. Measured on bb-digital-46200-day: the
// centre pixels of all faces within 1.7 km are identical, every face that differs is 1.75 to 10 km away.
const FAR = 'faces beyond 1.7 km z-fight with their frames on the classic renderer only';
// Places with boards near and ahead on I-15 northbound (found on the classic renderer: the nearest face facing the road
// 80 to 130 m ahead), and the Sphere from the road. Each by day and at night.
const PLACES = [
  { name: 'bb-static-52600', s: 52600, look: { lens: 35 }, parts: 'billboards' },
  { name: 'bb-digital-46200', s: 46200, look: { lens: 50 }, parts: 'billboards', missingMax: 9, reason: FAR },
  { name: 'bb-digital-48000', s: 48000, look: { lens: 50 }, parts: 'billboards', missingMax: 7, reason: FAR },
  { name: 'bb-static-64800', s: 64800, look: { lens: 35 }, parts: 'billboards' },
];
// Night limits, with the reason (see the report in the shot's line).
const NIGHT = {};
const SHOTS = PLACES.flatMap((p) => ['day', 'night'].map((t) => ({ ...p, name: `${p.name}-${t}`, t, ...(t === 'night' ? NIGHT[p.name] || {} : {}) })))
  .filter((s) => !only || only.includes(s.name));

// grouped by parts set: the parity tool keeps one page per renderer and parts set, and a new set reloads it
const toolShots = ['billboards', 'none'].flatMap((set) => SHOTS.flatMap((s) => {
  const base = { route: 'i15n', s: s.s, t: s.t, view: 'clean', look: s.look, ...(s.target ? { target: s.target } : {}) };
  if (set === 'none') return [{ ...base, name: `${s.name}.none`, parts: 'none', limit: 100 }];
  return s.parts === set ? [{ ...base, name: s.name, parts: s.parts, limit: 100 }] : [];
}));
mkdirSync(out, { recursive: true });
const shotFile = join(out, 'tool-shots.json');
writeFileSync(shotFile, JSON.stringify(toolShots, null, 1));
const tool = join(dirname(fileURLToPath(import.meta.url)), 'drive-parity.mjs');
const run = !toolShots.length ? { stdout: '', stderr: '' } : spawnSync(process.execPath, [tool, '--port', port, '--out', out, '--shots', shotFile, '--backends', backends, ...(args.includes('--shipped') ? ['--shipped'] : [])], { encoding: 'utf8', maxBuffer: 1 << 26 });
writeFileSync(join(out, 'tool.log'), `${run.stdout}\n${run.stderr}`);

/** RGBA pixels of a PNG written by drive-parity.mjs (8-bit RGBA, filter 0 on every row). */
function readPng(file) {
  const buf = readFileSync(file);
  let w = 0, h = 0;
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12); }
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error(`${file}: row filter ${raw[y * (w * 4 + 1)]}, expected 0`);
    raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  }
  return { w, h, px };
}

/** An RGBA PNG (filter 0 rows) of a 1280 x 720 frame, as drive-parity.mjs writes them. */
function pngOf(rgba, w = 1280, h = 720) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dist = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
function measure(ref, none, got) {
  let n = 0, sum = 0, missing = 0, all = 0;
  for (let i = 0; i < ref.length; i += 4) {
    const d = dist(ref, got, i);
    all += d;
    if (dist(ref, none, i) <= MASK_STEP) continue;
    n++;
    sum += d;
    if (dist(got, none, i) < d) missing++;
  }
  const px = ref.length / 4;
  return { maskPx: n, masked: n ? (sum / (n * 765)) * 100 : 0, missing: n ? (missing / n) * 100 : 0, whole: (all / (px * 765)) * 100 };
}

const rows = [];
let failed = 0;
console.log(`out: ${out}\n`);
console.log('shot                       backend   mask px   masked %  missing %  whole %   verdict');
for (const s of SHOTS) {
  const f = (name, r) => join(out, `${name}.${r}.png`);
  if (!existsSync(f(s.name, 'classic')) || !existsSync(f(`${s.name}.none`, 'classic'))) {
    console.log(`${s.name.padEnd(26)} classic   no picture (see ${join(out, 'tool.log')})`); failed++; continue;
  }
  const ref = readPng(f(s.name, 'classic')).px, none = readPng(f(`${s.name}.none`, 'classic')).px;
  for (const b of backends.split(',')) {
    if (!existsSync(f(s.name, b))) { console.log(`${s.name.padEnd(26)} ${b.padEnd(8)}  no picture`); failed++; rows.push({ shot: s.name, backend: b, error: 'no picture' }); continue; }
    const m = measure(ref, none, readPng(f(s.name, b)).px);
    const limit = s.limit ?? LIMIT;
    const missingMax = s.missingMax ?? MISSING_MAX;
    const pass = m.maskPx > 0 && m.masked <= limit && m.missing <= missingMax;
    if (!pass) failed++;
    rows.push({ shot: s.name, backend: b, ...m, limit, pass, reason: s.reason });
    console.log(`${s.name.padEnd(26)} ${b.padEnd(8)} ${String(m.maskPx).padStart(8)}  ${m.masked.toFixed(2).padStart(8)}  ${m.missing.toFixed(2).padStart(9)}  ${m.whole.toFixed(2).padStart(7)}   ${pass ? 'PASS' : 'FAIL'} (limits ${limit} %, missing ${missingMax} %)${s.reason ? `  [${s.reason}]` : ''}`);
  }
}
// ------------------------------------------------------------------ the Sphere's lit patch, from a probe camera
const doPatch = !only || only.some((n) => n.startsWith('sphere-patch'));
if (doPatch) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    channel: 'chromium', headless: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
      '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
  });
  const Q = { classic: 'renderer=legacy', webgl: 'renderer=webgpu&backend=webgl&display=classic', webgpu: 'renderer=webgpu&backend=webgpu&display=classic' };
  const frames = {};
  for (const r of ['classic', ...backends.split(',')]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await page.routeWebSocket(/.*/, () => {});
    await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
    await page.goto(`http://localhost:${port}/?city=lv&${Q[r]}&parts=screens`);
    await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 300000 });
    frames[r] = await page.evaluate(async ({ SPHERE, NIGHT_MS }) => {
      const s = window.__skyline, d = s.drive, raf = () => new Promise((res) => requestAnimationFrame(res));
      await s.attractions?.ready;
      await d.start('i15n', { s: 59500, t: NIGHT_MS, view: 'clean' });
      d.pause(); d.setView('clean');
      let scr = null;
      for (let i = 0; i < 900 && !scr; i++) { await raf(); scr = s.scene.getObjectByName('drive')?.userData.screensPart || null; }
      await Promise.race([d.whenSettled(), new Promise((res) => setTimeout(res, 60000))]);
      for (let i = 0; i < 3; i++) await raf();
      const legacy = !s.renderer.isWebGPURenderer;
      const cam = s.camera.clone();
      cam.fov = 50; cam.near = 1; cam.far = 20000; cam.aspect = 1280 / 720;
      const C = { x: 966.2, y: 20, z: -726.3 }; // fixed: a moved Sphere moves its patch across the frame
      cam.position.set(C.x + 350, C.y + 350, C.z + 350); cam.up.set(0, 1, 0); cam.lookAt(C.x, C.y, C.z);
      cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      const canvas = s.renderer.domElement;
      const draw = async (on) => {
        scr.setLight(on);
        let px;
        if (legacy) {
          const f = { simMs: NIGHT_MS, dtSimMs: 0, camera: s.camera, rate: 1, playing: false };
          scr.beforeRender(f);
          s.renderer.render(s.scene, cam);
          const gl = s.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, raw = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
          scr.afterRender(f);
          px = new Uint8Array(w * h * 4); // rows bottom-up in GL: flip to top-down
          for (let y = 0; y < h; y++) px.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        } else {
          s.pipeline.setCamera(cam);
          s.pipeline.render();
          const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no picture'))), 'image/png'));
          const bmp = await createImageBitmap(blob), c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
          g.drawImage(bmp, 0, 0);
          px = g.getImageData(0, 0, bmp.width, bmp.height).data;
          s.pipeline.setCamera(s.camera);
        }
        scr.setLight(true);
        let bin = '';
        for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
        return btoa(bin);
      };
      const entry = s.tall.find((e) => e.data.id === SPHERE);
      const out = {};
      out.shownOn = await draw(true); out.shownOff = await draw(false);
      s.place(entry, -200, -150); await raf(); await raf();
      out.movedOn = await draw(true); out.movedOff = await draw(false);
      s.place(entry, 0, 0);
      entry.mesh.visible = false; s.place(entry, 0, 0); await raf(); await raf();
      out.hiddenOn = await draw(true); out.hiddenOff = await draw(false);
      entry.mesh.visible = true; s.place(entry, 0, 0);
      return out;
    }, { SPHERE, NIGHT_MS });
    await page.close();
  }
  await browser.close();
  const buf = (b64) => Buffer.from(b64, 'base64');
  /** the light's added brightness per pixel (on minus off, summed over R, G, B) and its centroid */
  const added = (on, off) => {
    let cx = 0, cy = 0, wsum = 0, lit = 0;
    for (let i = 0; i < on.length; i += 4) {
      const v = Math.max(0, on[i] - off[i]) + Math.max(0, on[i + 1] - off[i + 1]) + Math.max(0, on[i + 2] - off[i + 2]);
      if (v > 6) lit++;
      const q = i / 4; cx += (q % 1280) * v; cy += Math.floor(q / 1280) * v; wsum += v;
    }
    return { lit, centroid: wsum ? [cx / wsum, cy / wsum] : null };
  };
  for (const v of ['shown', 'moved', 'hidden']) {
    const refOn = buf(frames.classic[`${v}On`]), refOff = buf(frames.classic[`${v}Off`]);
    const ref = added(refOn, refOff);
    writeFileSync(join(out, `sphere-patch-${v}.classic.png`), pngOf(refOn));
    writeFileSync(join(out, `sphere-patch-${v}.off.classic.png`), pngOf(refOff));
    for (const b of backends.split(',')) {
      const on = buf(frames[b][`${v}On`]), off = buf(frames[b][`${v}Off`]);
      writeFileSync(join(out, `sphere-patch-${v}.${b}.png`), pngOf(on));
      writeFileSync(join(out, `sphere-patch-${v}.off.${b}.png`), pngOf(off));
      const got = added(on, off);
      let pass, line;
      if (v === 'hidden') {
        pass = ref.lit === 0 && got.lit === 0;
        line = `lit px classic ${ref.lit}, ${b} ${got.lit} (no light: both 0)`;
        rows.push({ shot: `sphere-patch-${v}`, backend: b, litClassic: ref.lit, lit: got.lit, pass });
        console.log(`${`sphere-patch-${v}`.padEnd(26)} ${b.padEnd(8)} ${line.padStart(40)}   ${pass ? 'PASS' : 'FAIL'}`);
      } else {
        const m = measure(refOn, refOff, on);
        const dc = ref.centroid && got.centroid ? Math.hypot(ref.centroid[0] - got.centroid[0], ref.centroid[1] - got.centroid[1]) : Infinity;
        const within = CENTROID_SHARE * Math.sqrt(ref.lit);
        pass = m.maskPx > 0 && m.masked <= LIMIT && m.missing <= MISSING_MAX && dc <= within;
        rows.push({ shot: `sphere-patch-${v}`, backend: b, ...m, centroidPx: dc, litClassic: ref.lit, lit: got.lit, pass });
        console.log(`${`sphere-patch-${v}`.padEnd(26)} ${b.padEnd(8)} ${String(m.maskPx).padStart(8)}  ${m.masked.toFixed(2).padStart(8)}  ${m.missing.toFixed(2).padStart(9)}  ${m.whole.toFixed(2).padStart(7)}   ${pass ? 'PASS' : 'FAIL'} (limit ${LIMIT} %; centroid ${dc.toFixed(1)} px of ${within.toFixed(1)}; lit px ${got.lit} vs ${ref.lit})`);
      }
      if (!pass) failed++;
    }
  }
}

const said = run.stdout.split('\n').filter((l) => /said:|^\s+\[/.test(l));
if (said.length) console.log(`\nthe pages said:\n${said.slice(0, 20).join('\n')}`);
writeFileSync(join(out, 'screens-parity.json'), JSON.stringify({ rows, failed }, null, 1));
console.log(`\n${rows.length} comparisons, ${failed} failed; images in ${out}`);
process.exit(failed ? 1 : 0);

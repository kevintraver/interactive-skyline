// The cabin in the scene pass (plan 02, third stretch, decisions 3 and 7): does it hold on one camera with the session's
// 0.1 m near plane? For head poses out to the rig's limits, the frame drawn at near 0.1 m is compared with a control
// drawn at 0.01 m: a part of the cabin closer than 0.1 m (clipped) or a z-fight that the depth range brings shows as
// pixels that differ between the two. Compared twice: the whole frame, and the car alone (everything else hidden), which
// is the verdict: the world's own surfaces are the static world's port's test. Counts pixels whose largest channel
// differs by more than 8 levels.
// The logarithmic depth buffer three falls back to on WebGL2 without EXT_clip_control is not covered: it is chosen when
// the renderer is created (src/render/renderer.js), and switching it on a running page draws nothing usable.
// Whether drawing the cabin first saves the world's shading behind it is measured by cabin-cost.mjs (case `last`).
//
//   node tests/manual/cabin-depth.mjs [--port 5323] [--backends webgpu,webgl] [--quick] [--out <dir outside the repo>]
// Exit code 0 when the car alone differs in at most --limit of the frame's pixels at every pose (default 0.05 %).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5323));
const backends = opt('backends', 'webgpu,webgl').split(',');
const runs = backends.map((b) => ({ backend: b }));
const out = opt('out', null);
const limitShare = Number(opt('limit', 0.05)) / 100;
const W = 1280, H = 720;
if (out) mkdirSync(out, { recursive: true });
const POSES = process.argv.includes('--quick') ? [{ yaw: 0, pitch: 0, lens: 28 }] : [
  { yaw: 0, pitch: 0, lens: 28 }, { yaw: 150, pitch: 0, lens: 24 }, { yaw: -150, pitch: 0, lens: 24 },
  { yaw: 0, pitch: -40, lens: 24 }, { yaw: 0, pitch: 50, lens: 24 }, { yaw: 90, pitch: -30, lens: 24 },
  { yaw: -90, pitch: -30, lens: 24 }, { yaw: 39.2, pitch: -7.1, lens: 28 }, { yaw: -59.9, pitch: -4.6, lens: 28 },
  { yaw: -30.8, pitch: 12.5, lens: 28 },
];

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'] });
let failed = 0;
const rows = [];
for (const run of runs) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 200)); });
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`http://localhost:${port}/?city=lv&renderer=webgpu&backend=${run.backend}&display=classic&parts=cabin`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 180000 });
  const depth = await page.evaluate(async () => {
    const sk = window.__skyline;
    sk.attractions?.freeze(20);
    const t = Date.parse('2026-11-21T20:30:00Z');
    await sk.drive.start('i15n', { s: 45000, t, view: 'cabin' });
    await new Promise((res) => { const f = () => (sk.drive.cabin() ? res() : setTimeout(f, 100)); f(); });
    sk.drive.pause();
    sk.drive.seek({ s: 45000, t });
    return sk.drive.cabin().stats().depth;
  });
  for (const pose of POSES) {
    const r = await page.evaluate(async ({ pose }) => {
      const sk = window.__skyline, d = sk.drive, cam = sk.camera;
      d.look(pose);
      await d.whenSettled();
      for (let i = 0; i < 2; i++) await new Promise((res) => requestAnimationFrame(res));
      const grab = async (near) => {
        cam.near = near; cam.updateProjectionMatrix();
        d.renderFrame();
        const blob = await new Promise((res) => sk.renderer.domElement.toBlob(res, 'image/png'));
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      // the whole frame, then the car alone (everything else hidden): the cabin's own clipping and z-fighting
      const car = d.cabin().car;
      const kept = new Set(); for (let o = car; o; o = o.parent) kept.add(o);
      const hidden = [];
      const only = (on) => {
        if (!on) { for (const [o, v] of hidden) o.visible = v; hidden.length = 0; return; }
        for (const o of kept) for (const c of o.parent ? o.parent.children : []) if (!kept.has(c)) { hidden.push([c, c.visible]); c.visible = false; }
      };
      const a = await grab(0.1), b = await grab(0.01);
      only(true);
      const ca = await grab(0.1), cb = await grab(0.01);
      only(false);
      cam.near = 0.1; cam.updateProjectionMatrix();
      let cabinDiff = 0, cabinPx = 0;
      const cmask = new Uint8ClampedArray(ca.length);
      for (let i = 0; i < ca.length; i += 4) {
        if (ca[i] || ca[i + 1] || ca[i + 2] || cb[i] || cb[i + 1] || cb[i + 2]) cabinPx++;
        const m = Math.max(Math.abs(ca[i] - cb[i]), Math.abs(ca[i + 1] - cb[i + 1]), Math.abs(ca[i + 2] - cb[i + 2]));
        if (m > 8) cabinDiff++;
        cmask[i] = m > 8 ? 255 : ca[i] >> 1; cmask[i + 1] = m > 8 ? 0 : ca[i + 1] >> 1; cmask[i + 2] = m > 8 ? 0 : ca[i + 2] >> 1; cmask[i + 3] = 255;
      }
      const b64 = (arr) => { let s = ''; for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000)); return btoa(s); };
      let diff = 0;
      const mask = new Uint8ClampedArray(a.length);
      for (let i = 0; i < a.length; i += 4) {
        const m = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (m > 8) { diff++; mask[i] = 255; }
        mask[i + 1] = a[i + 1] >> 2; mask[i + 3] = 255;
      }
      let bin = '';
      for (let i = 0; i < mask.length; i += 0x8000) bin += String.fromCharCode.apply(null, mask.subarray(i, i + 0x8000));
      return { diff, cabinDiff, cabinPx, mask: btoa(bin), cabinMask: b64(cmask), frame: b64(new Uint8ClampedArray(a)) };
    }, { pose });
    const share = r.cabinDiff / (W * H);
    const pass = share <= limitShare;
    if (!pass) failed++;
    const name = `${run.backend} yaw ${pose.yaw} pitch ${pose.pitch} lens ${pose.lens}`;
    rows.push({ run: `${run.backend}`, depth, pose, cabinDiff: r.cabinDiff, cabinPx: r.cabinPx, frameDiff: r.diff, pass });
    console.log(`${name.padEnd(44)} depth ${depth.padEnd(11)} cabin ${String(r.cabinDiff).padStart(5)} of ${String(r.cabinPx).padStart(6)} px differ, frame ${String(r.diff).padStart(6)}  ${pass ? 'PASS' : 'FAIL'}`);
    if (out) {
      const f = name.replace(/ /g, '_');
      writeFileSync(`${out}/${f}.frame-diff.png`, png(W, H, Buffer.from(r.mask, 'base64')));
      writeFileSync(`${out}/${f}.cabin-diff.png`, png(W, H, Buffer.from(r.cabinMask, 'base64')));
      writeFileSync(`${out}/${f}.frame.png`, png(W, H, Buffer.from(r.frame, 'base64')));
    }
  }
  if (problems.length) console.log(`  page errors: ${[...new Set(problems)].slice(0, 5).join(' | ')}`);
  await page.close();
}
if (out) writeFileSync(`${out}/depth.json`, JSON.stringify(rows, null, 1));
await browser.close();
process.exit(failed ? 1 : 0);

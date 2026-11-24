// Settled frames from two servers compared pixel by pixel: for each case the drive is opened cold from its address, paused,
// settled (drive.whenSettled), and the canvas read back (the drawing buffer is preserved); the two images are then
// differenced, inside the mirror faces (their corners through the cabin camera) and outside them, and a diff image is
// written (differences in magenta, more than 2 levels; the rest of the frame dimmed).
// Serve both (for example the build before a change and after it), then:
//   node tests/manual/settled-compare.mjs <out-dir> <port A> <port B> '<cases>' [device pixel ratio, default 1]
// <cases> as frame-pacing.mjs: [{ name, route, s, t, view?, rain?, warm? }, ...]; warm (ms): play that long first, then seek
// back to the same place and time (for state that the first frames settle, such as the wet term's order). Keep the out
// dir outside the repo.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const [out, portA, portB, casesJson, dprArg] = process.argv.slice(2);
const cases = JSON.parse(casesJson);
const dpr = Number(dprArg || 1);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });

async function capture(port, c) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dpr });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
  const q = `city=lv&mode=drive&route=${c.route}&s=${c.s}&t=${encodeURIComponent(c.t)}&view=${c.view || 'cabin'}${c.rain ? '&rain=' + c.rain : ''}`;
  await page.goto(`http://localhost:${port}/?${q}&renderer=legacy`);
  await page.waitForFunction(() => window.__skyline?.drive?.active?.() && window.__skyline.drive.pose(), null, { timeout: 120000 });
  const r = await page.evaluate(async (warm) => {
    const sk = window.__skyline, d = sk.drive;
    if (warm) { // play a while (one-off work that waits for frames runs), then back to the same place and time
      await d.whenSettled();
      const at = d.pose();
      d.play(); await new Promise((res) => setTimeout(res, warm)); d.pause();
      d.seek({ s: at.s, t: at.t });
    }
    d.pause();
    await d.whenSettled();
    await new Promise((res) => setTimeout(res, 1500)); // idle work (twin grids, compiles) done; then settle again
    await d.whenSettled();
    const canvas = sk.renderer.domElement;
    const c = d.cabin(), rects = [];
    if (c && d.view() === 'cabin') {
      for (const name of ['left', 'right', 'center']) {
        const m = c.mirrors[name], cam = c.cabinCamera, xs = [], ys = [];
        for (const k of ['bottomLeft', 'bottomRight', 'topRight', 'topLeft']) {
          const v = m.corners[k].clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
          xs.push(((v.x + 1) / 2) * canvas.width); ys.push(((1 - v.y) / 2) * canvas.height);
        }
        rects.push([Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3]);
      }
    }
    return { url: canvas.toDataURL('image/png'), rects, w: canvas.width, h: canvas.height, iso: d.pose().iso };
  }, c.warm || 0);
  await page.close();
  return r;
}

for (const c of cases) {
  const a = await capture(portA, c), b = await capture(portB, c);
  const page = await browser.newPage();
  const res = await page.evaluate(async ({ a, b }) => {
    const load = (u) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = u; });
    const [ia, ib] = await Promise.all([load(a.url), load(b.url)]);
    const w = ia.width, h = ia.height, cv = new OffscreenCanvas(w, h), g = cv.getContext('2d');
    g.drawImage(ia, 0, 0); const A = g.getImageData(0, 0, w, h).data;
    g.drawImage(ib, 0, 0); const B = g.getImageData(0, 0, w, h).data;
    const D = new ImageData(w, h);
    const inMirror = (x, y) => a.rects.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
    const st = { in: { n: 0, d2: 0, d16: 0, max: 0, sum: 0 }, out: { n: 0, d2: 0, d16: 0, max: 0, sum: 0 } };
    let box = null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = 4 * (y * w + x);
      const dd = Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2]));
      const s = inMirror(x, y) ? st.in : st.out;
      s.n++; s.sum += dd; if (dd > 2) s.d2++; if (dd > 16) s.d16++; if (dd > s.max) s.max = dd;
      if (dd > 2 && s === st.out) box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
      if (dd > 2) { D.data[k] = 255; D.data[k + 1] = 0; D.data[k + 2] = 255; } else { D.data[k] = B[k] * 0.35; D.data[k + 1] = B[k + 1] * 0.35; D.data[k + 2] = B[k + 2] * 0.35; }
      D.data[k + 3] = 255;
    }
    g.putImageData(D, 0, 0);
    const blob = await cv.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const f = (s) => ({ px: s.n, over2: s.d2, over16: s.d16, max: s.max, mean: +(s.sum / Math.max(1, s.n)).toFixed(4) });
    return { inMirrors: f(st.in), outside: f(st.out), outsideBox: box, diff: Array.from(buf) };
  }, { a, b });
  const slug = c.name.replace(/[^a-z0-9]+/gi, '-');
  writeFileSync(`${out}/${slug}-diff.png`, Buffer.from(res.diff));
  writeFileSync(`${out}/${slug}-A.png`, Buffer.from(a.url.split(',')[1], 'base64'));
  writeFileSync(`${out}/${slug}-B.png`, Buffer.from(b.url.split(',')[1], 'base64'));
  console.log(c.name.padEnd(28), a.iso, JSON.stringify({ inMirrors: res.inMirrors, outside: res.outside, outsideBox: res.outsideBox }));
  await page.close();
}
await browser.close();

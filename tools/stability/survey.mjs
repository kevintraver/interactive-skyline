// For every tall building: fly to it, and from three sides render the view twice, the second time with the camera
// nudged by a hair. Stable geometry gives the same picture; surfaces that fight each other (z-fighting) flip.
// usage: node tools/stability/survey.mjs <outDir> <baseUrl> <city> <day|night> [label] [extraQuery]
// On the new renderer pass '&display=classic' so the automatic exposure cannot differ between the two pictures.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');
const [out, base, city, light, label = 'survey', extra = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${base}/?city=${city}${extra}`, { timeout: 180000 });
await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
await page.evaluate(() => window.__skyline.attractions.ready);
await page.addStyleTag({ content: '#top,#bar,#tools,.views,#dock,#credit,#card,#tip,#results{visibility:hidden!important}' });
await page.evaluate((night) => { const s = window.__skyline; s.attractions.freeze(47); if (night) s.setSetting('night', true); }, light === 'night');
await page.waitForTimeout(3000);
const ids = await page.evaluate(() => window.__skyline.tall.map((e) => ({ id: e.data.id, name: e.data.name || 'Unnamed building' })));
const results = [];
for (const b of ids) {
  await page.evaluate((id) => { const s = window.__skyline; s.select(null); s.focusOn(s.tall.find((e) => e.data.id === id)); }, b.id);
  await page.waitForFunction(() => !window.__skyline.flying(), null, { timeout: 20000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const s = window.__skyline, cam = s.camera, c = s.controls, canvas = s.renderer.domElement;
    const w = canvas.width, h = canvas.height, bw = w >> 2, bh = h >> 2;
    const copy = (window.__copy ||= Object.assign(document.createElement('canvas'), { width: w, height: h })), ctx = copy.getContext('2d', { willReadFrequently: true });
    const grab = () => {
      // the canvas's picture is read in the task that drew it (both renderers); rows come top first, flipped below
      if (s.pipeline) s.pipeline.render(); else s.renderer.render(s.scene, cam);
      ctx.drawImage(canvas, 0, 0);
      const px = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(bw * bh);               // 4 x 4 block means of luma, bottom row first
      for (let y = 0; y < bh * 4; y++) for (let x = 0; x < bw * 4; x++) { const i = ((h - 1 - y) * w + x) * 4; lum[(y >> 2) * bw + (x >> 2)] += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 16; }
      return lum;
    };
    const t = c.target, off0 = cam.position.clone().sub(t), out = [];
    const r0 = Math.hypot(off0.x, off0.z), a0 = Math.atan2(off0.x, off0.z);
    const place = (az, scale) => { cam.position.set(t.x + Math.sin(az) * r0 * scale, t.y + off0.y * scale, t.z + Math.cos(az) * r0 * scale); cam.lookAt(t); cam.updateMatrixWorld(); };
    for (const turn of [0, 2.1, 4.2]) {
      place(a0 + turn, 1); const A = grab();
      place(a0 + turn + 0.00017, 1.0004); const B = grab();
      let n = 0, x0 = bw, y0 = bh, x1 = 0, y1 = 0;
      for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - B[i]) > 22) { n++; const x = i % bw, y = (i / bw) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      out.push({ turn, blocks: n, box: n ? [x0 * 4, (bh - 1 - y1) * 4, (x1 + 1) * 4, (bh - y0) * 4] : null });
    }
    cam.position.copy(t).add(off0); c.update();
    return out;
  });
  const worst = r.reduce((a, x) => (x.blocks > a.blocks ? x : a), r[0]);
  results.push({ ...b, worst: worst.blocks, turn: worst.turn, box: worst.box, all: r.map((x) => x.blocks) });
}
results.sort((a, b) => b.worst - a.worst);
fs.mkdirSync(`${out}/${label}`, { recursive: true });
fs.writeFileSync(`${out}/${label}/${city}-${light}.json`, JSON.stringify(results, null, 1));
console.log(label, city, light, 'buildings', results.length, 'with >40 flipping blocks:', results.filter((r) => r.worst > 40).length, ' >150:', results.filter((r) => r.worst > 150).length);
for (const r of results.slice(0, 25)) console.log(String(r.worst).padStart(6), r.all.join('/').padEnd(16), r.id, r.name);
await browser.close();

// Same measurement as the survey for chosen buildings, but keep both pictures (taken inside one synchronous call).
// usage: node tools/stability/pair.mjs <out> <baseUrl> <city> <day|night> [--query=&display=classic] <id[@turn]...>
// Works on both renderers: the new one draws through its pipeline, and its canvas is read in the task that drew it.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');
const [out, base, city, light, ...rest] = process.argv.slice(2);
const extra = (rest.find((a) => a.startsWith('--query=')) || '--query=').slice(8);
const ids = rest.filter((a) => !a.startsWith('--'));
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${base}/?city=${city}${extra}`, { timeout: 180000 });
await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
await page.evaluate(() => window.__skyline.attractions.ready);
await page.evaluate((night) => { const s = window.__skyline; s.attractions.freeze(47); if (night) s.setSetting('night', true); }, light === 'night');
await page.waitForTimeout(3000);
fs.mkdirSync(`${out}/pair`, { recursive: true });
for (const spec of ids) {
  const [id, turnS] = spec.split('@'), turn = Number(turnS || 0);
  await page.evaluate((id) => { const s = window.__skyline; s.select(null); s.focusOn(s.tall.find((e) => e.data.id === id)); }, id);
  await page.waitForFunction(() => !window.__skyline.flying(), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(async (turn) => {
    async function whoFightsAsync(A, B, cam) {
      const s = window.__skyline, T = window.__skyline.webgpu, canvas = s.renderer.domElement;
      const load = async (u) => { const b = await (await fetch(u)).blob(); const bm = await createImageBitmap(b); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height); };
      const [a, b] = await Promise.all([load(A), load(B)]);
      const w = a.width, h = a.height, flips = [];
      for (let by = 0; by < h >> 2; by++) for (let bx = 0; bx < w >> 2; bx++) {
        let la = 0, lb = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const k = ((by * 4 + y) * w + bx * 4 + x) * 4; la += 0.2126 * a.data[k] + 0.7152 * a.data[k + 1] + 0.0722 * a.data[k + 2]; lb += 0.2126 * b.data[k] + 0.7152 * b.data[k + 1] + 0.0722 * b.data[k + 2]; }
        if (Math.abs(la - lb) / 16 > 22) flips.push([bx * 4 + 2, by * 4 + 2]);
      }
      const label = (o) => { for (let p = o; p; p = p.parent) { const e = s.tall.find((t) => t.mesh === p); if (e) return e.data.id; if (p.parent === s.scene) return p.name || p.type + ':' + (p.geometry ? p.geometry.attributes.position.count : ''); } return o.name || o.type; };
      const ray = new window.__skyline.three.Raycaster();
      const pairs = {};
      for (const [x, y] of flips.filter((_, i) => i % Math.max(1, Math.floor(flips.length / 60)) === 0)) {
        ray.setFromCamera({ x: (x / w) * 2 - 1, y: 1 - (y / h) * 2 }, cam);
        const hits = ray.intersectObjects(s.scene.children, true).filter((q) => q.object.isMesh && q.object.visible && q.object.material.side !== 1);
        if (!hits.length) continue;
        const near = hits.filter((q) => q.distance - hits[0].distance < 0.05);
        const key = [...new Set(near.map((q) => label(q.object)))].sort().join(' | ') + (near.length > 1 ? ` (${near.length} faces)` : '');
        pairs[key] = (pairs[key] || 0) + 1;
      }
      return { flips: flips.length, pairs };
    }
    const whoFights = (A, B, cam) => whoFightsAsync(A, B, cam.clone());
    const s = window.__skyline, cam = s.camera, c = s.controls, t = c.target, off0 = cam.position.clone().sub(t);
    const r0 = Math.hypot(off0.x, off0.z), a0 = Math.atan2(off0.x, off0.z);
    const place = (az, scale) => { cam.position.set(t.x + Math.sin(az) * r0 * scale, t.y + off0.y * scale, t.z + Math.cos(az) * r0 * scale); cam.lookAt(t); cam.updateMatrixWorld(); };
    const shot = () => { if (s.pipeline) s.pipeline.render(); else s.renderer.render(s.scene, cam); return s.renderer.domElement.toDataURL('image/png'); };
    place(a0 + turn, 1); const A = shot(); const A2 = shot();
    place(a0 + turn + 0.00017, 1.0004); const B = shot();
    // which surfaces lie within 5 cm of each other under the blocks that flipped: ray-cast the middle of each
    const fights = whoFights(A, B, cam);
    const info = { fights, near: cam.near, far: cam.far, pos: cam.position.toArray().map(Math.round), target: t.toArray().map(Math.round), shadowAuto: s.renderer.shadowMap.autoUpdate, info: s.renderer.info.render.calls };
    cam.position.copy(t).add(off0); c.update();
    info.fights = await info.fights;
    return { A, A2, B, info };
  }, turn);
  r.info.fights = await r.info.fights;
  for (const k of ['A', 'A2', 'B']) fs.writeFileSync(`${out}/pair/${id}-${k}.png`, Buffer.from(r[k].split(',')[1], 'base64'));
  console.log(id, turn, JSON.stringify(r.info));
}
await browser.close();

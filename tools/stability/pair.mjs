// Same measurement as the survey for chosen buildings, but keep both pictures (taken inside one synchronous call).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');
const [out, base, city, light, ...ids] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${base}/?city=${city}`, { timeout: 180000 });
await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
await page.evaluate(() => window.__skyline.attractions.ready);
await page.evaluate((night) => { const s = window.__skyline; s.attractions.freeze(47); if (night) s.setSetting('night', true); }, light === 'night');
await page.waitForTimeout(3000);
fs.mkdirSync(`${out}/pair`, { recursive: true });
for (const spec of ids) {
  const [id, turnS] = spec.split('@'), turn = Number(turnS);
  await page.evaluate((id) => { const s = window.__skyline; s.select(null); s.focusOn(s.tall.find((e) => e.data.id === id)); }, id);
  await page.waitForFunction(() => !window.__skyline.flying(), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const r = await page.evaluate((turn) => {
    const s = window.__skyline, cam = s.camera, c = s.controls, t = c.target, off0 = cam.position.clone().sub(t);
    const r0 = Math.hypot(off0.x, off0.z), a0 = Math.atan2(off0.x, off0.z);
    const place = (az, scale) => { cam.position.set(t.x + Math.sin(az) * r0 * scale, t.y + off0.y * scale, t.z + Math.cos(az) * r0 * scale); cam.lookAt(t); cam.updateMatrixWorld(); };
    const shot = () => { s.renderer.render(s.scene, cam); return s.renderer.domElement.toDataURL('image/png'); };
    place(a0 + turn, 1); const A = shot(); const A2 = shot();
    place(a0 + turn + 0.00017, 1.0004); const B = shot();
    const info = { near: cam.near, far: cam.far, pos: cam.position.toArray().map(Math.round), target: t.toArray().map(Math.round), shadowAuto: s.renderer.shadowMap.autoUpdate, info: s.renderer.info.render.calls };
    cam.position.copy(t).add(off0); c.update();
    return { A, A2, B, info };
  }, turn);
  for (const k of ['A', 'A2', 'B']) fs.writeFileSync(`${out}/pair/${id}-${k}.png`, Buffer.from(r[k].split(',')[1], 'base64'));
  console.log(id, turn, JSON.stringify(r.info));
}
await browser.close();

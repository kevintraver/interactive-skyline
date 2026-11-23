// Walk the camera through the world along a fixed path. For every pose save three frames:
//   m = as drawn while moving (two animation frames after the pose is set)
//   s = the same pose after standing still 700 ms
//   e = the camera nudged by a hair (0.05 % of its distance, 0.01 degree)
// m against s shows what is wrong only while moving; s against e shows surfaces that flip under a sub-pixel move.
// usage: node tools/stability/poses.mjs <outDir> <baseUrl> <label> <city> <day|night|dusk> [extraQuery]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');
const [out, base, label, city, light, extra = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
const q = light === 'dusk' ? `&t=${encodeURIComponent(city === 'lv' ? '2026-07-14T19:50:00-07:00' : '2026-07-14T20:55:00-06:00')}` : '';
await page.goto(`${base}/?city=${city}${q}${extra}`, { timeout: 180000 });
await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
await page.evaluate(() => window.__skyline.attractions.ready);
await page.addStyleTag({ content: '#top,#bar,#tools,.views,#dock,#credit,#card,#tip,#results{visibility:hidden!important}' });
await page.evaluate((night) => { const s = window.__skyline; s.attractions.freeze(47); if (night) s.setSetting('night', true); }, light === 'night');
await page.waitForTimeout(4000);
const start = await page.evaluate(() => {
  const s = window.__skyline, c = s.controls, cam = s.camera, r = s.renderer;
  const dx = cam.position.x - c.target.x, dy = cam.position.y - c.target.y, dz = cam.position.z - c.target.z, dist = Math.hypot(dx, dy, dz);
  window.__pose = (p) => {
    const polar = Math.min(p.polar, c.maxPolarAngle - 0.002), sp = Math.sin(polar);
    // only where a visitor can now go: the pivot inside the camera limits' bounds, on the ground
    const L = s.cameraLimits;
    if (L) { p = { ...p, tx: Math.min(L.bounds.maxX, Math.max(L.bounds.minX, p.tx)), tz: Math.min(L.bounds.maxZ, Math.max(L.bounds.minZ, p.tz)) }; p.ty = L.groundAt(p.tx, p.tz); }
    c.target.set(p.tx, p.ty, p.tz);
    cam.position.set(p.tx + p.dist * sp * Math.sin(p.az), p.ty + p.dist * Math.cos(polar), p.tz + p.dist * sp * Math.cos(p.az));
    c.update(); s.invalidate();
    return [cam.position.x, cam.position.y, cam.position.z].map(Math.round);
  };
  return { tx: c.target.x, ty: c.target.y, tz: c.target.z, az: Math.atan2(dx, dz), polar: Math.acos(dy / dist), dist,
    backend: r.backend ? (r.backend.isWebGPUBackend ? 'webgpu' : 'webgl2-new') : 'classic', maxPolar: c.maxPolarAngle, min: c.minDistance, max: c.maxDistance, far: cam.far };
});
const k0 = { tx: start.tx, ty: start.ty, tz: start.tz, az: start.az, polar: start.polar, dist: start.dist };
const D = Math.PI / 180, km = 1000;
const keys = [
  ['start', k0],
  ['orbit', { ...k0, az: k0.az + 70 * D, polar: 60 * D, dist: 6 * km }],
  ['grazing', { ...k0, az: k0.az + 100 * D, polar: 89 * D, dist: 3 * km }],
  ['close', { ...k0, az: k0.az + 130 * D, polar: 78 * D, dist: Math.max(start.min, 220) }],
  ['top', { ...k0, az: k0.az + 130 * D, polar: 4 * D, dist: start.max }],
  ['east', { ...k0, tx: k0.tx + 30 * km, az: 90 * D, polar: 72 * D, dist: 20 * km }],
  ['north', { ...k0, tz: k0.tz - 35 * km, az: 0, polar: 75 * D, dist: 25 * km }],
  ['west', { ...k0, tx: k0.tx - 40 * km, az: -90 * D, polar: 80 * D, dist: start.max }],
  ['south', { ...k0, tz: k0.tz + 45 * km, az: 180 * D, polar: 70 * D, dist: 12 * km }],
  ['back', k0],
];
const STEPS = 6, poses = [];
for (let k = 0; k < keys.length - 1; k++) {
  const [name, a] = keys[k], b = keys[k + 1][1];
  for (let i = 0; i < STEPS; i++) {
    const t = i / STEPS, u = t * t * (3 - 2 * t), mix = (x, y) => x + (y - x) * u;
    poses.push({ leg: name, tx: mix(a.tx, b.tx), ty: a.ty, tz: mix(a.tz, b.tz), az: mix(a.az, b.az), polar: mix(a.polar, b.polar), dist: Math.exp(mix(Math.log(a.dist), Math.log(b.dist))) });
  }
}
const dir = `${out}/${label}/${city}-${light}`;
fs.mkdirSync(dir, { recursive: true });
const raf = (n = 2) => page.evaluate((k) => new Promise((done) => { const step = () => (k-- <= 0 ? done() : requestAnimationFrame(step)); requestAnimationFrame(step); }), n);
const id = (i) => String(i).padStart(3, '0');
const cams = [];
for (let i = 0; i < poses.length; i++) { cams.push(await page.evaluate((p) => window.__pose(p), poses[i])); await raf(2); await page.screenshot({ path: `${dir}/${id(i)}-m.png` }); }
for (let i = 0; i < poses.length; i++) {
  await page.evaluate((p) => window.__pose(p), poses[i]); await page.waitForTimeout(700); await raf(2);
  await page.screenshot({ path: `${dir}/${id(i)}-s.png` });
  await page.evaluate((p) => window.__pose(p), { ...poses[i], dist: poses[i].dist * 1.0005, az: poses[i].az + 0.01 * D }); await page.waitForTimeout(250); await raf(2);
  await page.screenshot({ path: `${dir}/${id(i)}-e.png` });
}
fs.writeFileSync(`${dir}/info.json`, JSON.stringify({ start, poses: poses.map((p, i) => ({ i, leg: p.leg, cam: cams[i], dist: Math.round(p.dist), polarDeg: +(p.polar / D).toFixed(1) })), errors: [...new Set(errors)].slice(0, 20) }, null, 1));
console.log(label, city, light, start.backend, 'poses', poses.length, 'errors', new Set(errors).size, [...new Set(errors)].slice(0, 2));
await browser.close();

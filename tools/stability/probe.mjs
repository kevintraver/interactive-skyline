// A few named camera situations, one screenshot each.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');
const [out, base, label, city] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${base}/?city=${city}`, { timeout: 180000 });
await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
await page.evaluate(() => window.__skyline.attractions.ready);
await page.addStyleTag({ content: '#top,#bar,#tools,.views,#dock,#credit,#card,#tip,#results{visibility:hidden!important}' });
await page.evaluate(() => window.__skyline.attractions.freeze(47));
await page.waitForTimeout(3000);
fs.mkdirSync(`${out}/probe`, { recursive: true });
const cx = 640, cy = 560;
const snap = async (name) => { await page.waitForTimeout(900); const st = await page.evaluate(() => { const s = window.__skyline, c = s.controls; return { polarDeg: +(c.getPolarAngle() * 180 / Math.PI).toFixed(1), dist: Math.round(s.camera.position.distanceTo(c.target)), camY: Math.round(s.camera.position.y), targetY: Math.round(c.target.y), target: [Math.round(c.target.x), Math.round(c.target.z)] }; }); await page.screenshot({ path: `${out}/probe/${label}-${city}-${name}.png` }); console.log(label, city, name, JSON.stringify(st)); };
// 1. real input: tilt as far down as the controls allow (right-drag up), at the starting distance and zoomed in
await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 40; i++) await page.mouse.move(cx, cy - 12 * i);
await page.mouse.up({ button: 'right' });
await snap('tilt-max');
await page.mouse.move(640, 500);
for (let i = 0; i < 25; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
await snap('tilt-max-zoomed-in');
// 2. real input: drag the map a long way toward the mountains (west), at low zoom-in
for (let k = 0; k < 30; k++) { await page.mouse.move(300, 600); await page.mouse.down(); await page.mouse.move(1100, 620, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(60); }
await snap('dragged-30x');
for (let k = 0; k < 60; k++) { await page.mouse.move(300, 600); await page.mouse.down(); await page.mouse.move(1100, 620, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(60); }
await snap('dragged-90x');
// 3. zoom all the way out there, and look around
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(30); }
await snap('far-zoomed-out');
await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' }); await page.mouse.move(cx + 500, cy, { steps: 10 }); await page.mouse.up({ button: 'right' });
await snap('far-rotated');
await browser.close();

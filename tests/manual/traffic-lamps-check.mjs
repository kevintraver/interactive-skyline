// The traffic's lamps and ribbons apart (D6.4): the same frame drawn whole, with the ribbons only and with the lamp
// sprites only, to see where one hands over to the other. Serve the repo first:
//   pnpm exec vite --port 5292 --strictPort
// then: node tests/manual/traffic-lamps-check.mjs <out-dir> <port> <s metres> <ISO time> [lens mm] [yaw deg] [height m] [pitch deg]
// height > 0 puts the camera that high above the car, looking along the road pitched down by pitch degrees (the
// traffic part places and draws for that camera), to see kilometres of road at once.
// Writes <s>-whole.png, <s>-ribbons.png, <s>-sprites.png, <s>-nopools.png and prints the lamps' stats.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const [out, port = 5292, s = 44200, iso = '2026-11-21T02:30:00Z', lens = 50, yaw = 0, height = 0, pitch = 0] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async () => { const sk = window.__skyline; sk.attractions.freeze(20); await sk.attractions.ready; await sk.drive.start('i15n', {}); sk.drive.pause(); sk.drive.setView('clean'); });
await page.waitForFunction(() => window.__skyline.scene.getObjectByName('traffic')?.userData.part?.model(), null, { timeout: 60000 });
const stats = await page.evaluate(async ({ s, t, lens, yaw, height, pitch }) => {
  const sk = window.__skyline, d = sk.drive;
  d.seek({ s, t });
  d.look({ yaw, pitch: 0, lens });
  await d.whenSettled();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (height > 0) {
    const p = d.pose(), cam = sk.camera, fw = p.forward, u = p.up;
    cam.position.set(p.position.x, p.position.y + height, p.position.z);
    const k = Math.tan((pitch * Math.PI) / 180);
    cam.lookAt(p.position.x + fw.x * 1000, p.position.y + height - 1000 * k, p.position.z + fw.z * 1000);
    cam.updateMatrixWorld();
    const right = { x: fw.y * u.z - fw.z * u.y, y: fw.z * u.x - fw.x * u.z, z: fw.x * u.y - fw.y * u.x };
    const part = sk.scene.getObjectByName('traffic').userData.part;
    const frame = { camera: cam, viewport: { width: innerWidth, height: innerHeight }, simMs: p.t, pose: { ...p, right }, sun: { elevation: -20 } };
    part.update(frame);
    part.beforeRender(frame);
  }
  // the three pictures in this same task, before the app's loop puts the camera back on the rig
  const lamps = sk.scene.getObjectByName('vehicle-lamps'), rib = sk.scene.getObjectByName('traffic-ribbons');
  const was = [lamps.visible, rib.visible];
  const shots = {};
  const pools = sk.scene.getObjectByName('traffic-head-pools'), wasP = pools.visible;
  for (const [name, l, r, pl] of [['whole', true, true, true], ['ribbons', false, true, true], ['sprites', true, false, true], ['nopools', true, true, false]]) {
    lamps.visible = was[0] && l; rib.visible = was[1] && r; pools.visible = wasP && pl;
    sk.renderer.render(sk.scene, sk.camera);
    shots[name] = sk.renderer.domElement.toDataURL('image/png');
  }
  lamps.visible = was[0]; rib.visible = was[1]; pools.visible = wasP;
  return { lamps: d.stats().traffic.lamps, shots };
}, { s: +s, t: Date.parse(iso), lens: +lens, yaw: +yaw, height: +height, pitch: +pitch });
console.log(JSON.stringify(stats.lamps));
for (const [name, url] of Object.entries(stats.shots)) writeFileSync(`${out}/${s}-${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
await browser.close();

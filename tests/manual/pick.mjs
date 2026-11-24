// What is under a pixel of the drive: opens a route cold as routes-app-shots.mjs does, then casts a ray from the
// camera through each pixel given and prints the objects it hits (name, its parents' names, material, the hit's
// map position and height above sea level), nearest first.
// Serve the repo first:   pnpm exec vite --port 5302 --strictPort
// then:   node tests/manual/pick.mjs <port> '<shot>' '[[x, y], ...]'
// <shot> is one shot of routes-app-shots.mjs: { route, s?, when?, view?, look? } (1280 x 720), and optionally
//   hide: [names]: objects of the scene with those names (or names starting so) are hidden first, and
//   png: a path to save the picture as drawn then
//   list: [x, y, r]: also prints every drawn object whose bounding sphere comes within r metres of map (x, y)
import { chromium } from '@playwright/test';

const port = process.argv[2] || 5302;
const shot = JSON.parse(process.argv[3]);
const pixels = JSON.parse(process.argv[4] || '[[640, 360]]');
const DAY = '2026-11-21T20:30:00Z', NIGHT = '2026-11-22T04:30:00Z';
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* defaults */ } });
const q = new URLSearchParams({ city: 'lv', mode: 'drive', route: shot.route, view: shot.view || 'clean', t: shot.when === 'night' ? NIGHT : DAY });
if (Number.isFinite(shot.s)) q.set('s', String(shot.s));
await page.goto(`http://localhost:${port}/?${q}&renderer=legacy`);
await page.waitForFunction(() => window.__skyline?.drive?.active?.() && window.__skyline.drive.pose()
  && !document.getElementById('drivebar')?.classList.contains('busy'), null, { timeout: 180000 });
const out = await page.evaluate(async ({ shot, pixels }) => {
  const s = window.__skyline, d = s.drive;
  d.pause();
  if (shot.look) d.look(shot.look);
  await d.whenSettled();
  for (let i = 0; i < 200 && !(d.stats()?.traffic); i++) await new Promise((r) => setTimeout(r, 50));
  await d.whenSettled();
  for (const n of shot.hide || []) s.scene.traverse((o) => { if (o.name && o.name.startsWith(n)) o.visible = false; });
  s.invalidate?.();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/three\.js(\?|$)|three\.module\.js/.test(n));
  const THREE = await import(url);
  const ray = new THREE.Raycaster();
  const base = 620, R = 6371000 * (7 / 6);
  const named = (o) => { const n = []; for (let p = o; p; p = p.parent) n.push(p.name || p.type); return n.join(' < '); };
  const listed = [];
  if (shot.list) {
    const [lx, ly, lr] = shot.list, c = new THREE.Vector3();
    s.scene.traverse((o) => {
      if (!o.geometry || !o.visible) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere; c.copy(bs.center).applyMatrix4(o.matrixWorld);
      const dd = Math.hypot(c.x - lx, -c.z - ly) - bs.radius * o.matrixWorld.getMaxScaleOnAxis();
      if (dd < lr && bs.radius < 3000) listed.push({ name: named(o), type: o.type, material: o.material?.name || o.material?.type, radius: +bs.radius.toFixed(1), count: o.count });
    });
  }
  const picked = pixels.map(([x, y]) => {
    ray.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), s.camera);
    const hits = ray.intersectObjects(s.scene.children, true).filter((h) => h.object.visible !== false).slice(0, 4);
    return { x, y, hits: hits.map((h) => {
      const mx = h.point.x, my = -h.point.z;
      return { name: named(h.object), type: h.object.type, attrs: Object.keys(h.object.geometry?.attributes || {}).join(','), instance: h.instanceId, kind: h.face && h.object.geometry.attributes.kind ? h.object.geometry.attributes.kind.getX(h.face.a) : undefined,
        normal: h.face ? [+h.face.normal.x.toFixed(2), +h.face.normal.y.toFixed(2), +(-h.face.normal.z).toFixed(2)] : undefined, material: h.object.material?.name || h.object.material?.type, dist: +h.distance.toFixed(1),
        map: [+mx.toFixed(1), +my.toFixed(1)], h: +(h.point.y + base + (mx * mx + my * my) / (2 * R)).toFixed(2) };
    }) };
  });
  return { picked, listed };
}, { shot, pixels });
if (shot.png) await page.screenshot({ path: shot.png });
console.log(JSON.stringify(out, null, 1));
await browser.close();

// GPU cost of the traffic with its lamps, ribbons and pools (D6.4; plan 02 section 9.1: traffic geometry and its
// sprites 1.0 ms, lamp sprites 0.8 ms on High). Serve the repo (pnpm exec vite --port 5292 --strictPort), then:
//   node tests/manual/traffic-lamps-budget.mjs <port> [bodies]
// At km 60 on Friday 20 November 2026 at 17:30 (dark, the evening peak) it times whole frames with
// EXT_disjoint_timer_query_webgl2, the traffic part shown and hidden (setEnabled), in two states:
//   as drawn: the drive's own frame (bodies in range, lamps out to 4 km, ribbons beyond, pools);
//   stress:   the model's vehicles ahead pulled toward the car until about `bodies` (default 600) are within a
//             kilometre and in view (as traffic-budget.mjs does), drawn with their lamps and pools; and the split
//             (pools, lamp sprites, bodies) by switching those off in turn.
import { chromium } from '@playwright/test';
const port = process.argv[2] || 5292, want = +(process.argv[3] || 600);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch {} });
await page.goto(`http://localhost:${port}/?city=lv`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 120000 });
await page.evaluate(async () => { const s = window.__skyline; s.attractions.freeze(20); await s.attractions.ready; await s.drive.start('i15n', {}); s.drive.pause(); s.drive.setView('clean'); });
await page.waitForFunction(() => window.__skyline.scene.getObjectByName('traffic')?.userData.part?.model(), null, { timeout: 60000 });
const r = await page.evaluate(async (want) => {
  const sk = window.__skyline, d = sk.drive;
  for (const el of document.body.querySelectorAll('*')) if (!(el instanceof HTMLCanvasElement) && !el.querySelector('canvas')) el.style.visibility = 'hidden';
  d.seek({ s: 60000, t: Date.parse('2026-11-21T01:30:00Z') });
  await d.whenSettled();
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const part = sk.scene.getObjectByName('traffic').userData.part;
  const median = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b[b.length >> 1]; };
  const time = async () => { const on = await sk.perf.renderFrames(90, 20); return median(on.ms); };
  const group = part.renderer.group;
  const asDrawn = { stats: d.stats().traffic };
  asDrawn.on = await time(); const infoOn = sk.perf.info();
  group.visible = false; asDrawn.off = await time(); const infoOff = sk.perf.info(); group.visible = true;
  asDrawn.calls = infoOn.calls - infoOff.calls; asDrawn.triangles = infoOn.triangles - infoOff.triangles;
  // stress: pull the vehicles ahead toward the car
  const p = d.pose();
  const model = part.model();
  const placed = model.fleet.place(p.t, p.s, p.s + 9000, null);
  const fw = p.forward, cp = p.position;
  let far = 0;
  for (let i = 0; i < placed.count; i++) far = Math.max(far, (placed.pos[3 * i] - cp.x) * fw.x + (placed.pos[3 * i + 2] - cp.z) * fw.z);
  const k = Math.min(1, 900 / far);
  for (let i = 0; i < placed.count; i++) {
    placed.pos[3 * i] = cp.x + (placed.pos[3 * i] - cp.x) * k;
    placed.pos[3 * i + 2] = cp.z + (placed.pos[3 * i + 2] - cp.z) * k;
    placed.s[i] = p.s + (placed.s[i] - p.s) * k;
  }
  placed.count = Math.min(placed.count, Math.round(want * 1.25));
  part.renderer.draw(placed, sk.camera, innerHeight, { s: p.s, range: 1e9 });
  const pxPerRad = innerHeight / (2 * Math.tan((sk.camera.getEffectiveFOV() * Math.PI) / 360));
  part.lamps.update({ near: null, far: placed, carS: p.s, ahead: 1e6, behind: 1e6, band: 0.25, eye: sk.camera.position, on: true, pxPerRad });
  part.pools.update({ near: placed, eye: sk.camera.position, ambient: 0, gain: 0.1, threshold: () => 1e9 });
  const stress = { bodies: part.renderer.stats(), lamps: part.lamps.stats(), pools: part.pools.stats() };
  stress.on = await time(); const sOn = sk.perf.info();
  group.visible = false; stress.off = await time(); const sOff = sk.perf.info(); group.visible = true;
  stress.calls = sOn.calls - sOff.calls; stress.triangles = sOn.triangles - sOff.triangles;
  // what each layer costs in the stress frame: the pools off, then the lamp sprites off too
  part.pools.mesh.visible = false; stress.noPools = await time();
  part.lamps.layer.mesh.visible = false; stress.bodiesOnly = await time();
  part.pools.mesh.visible = true; part.lamps.layer.mesh.visible = true;
  const st = asDrawn.stats;
  return {
    asDrawn: { msOn: asDrawn.on, msOff: asDrawn.off, cost: +(asDrawn.on - asDrawn.off).toFixed(3), calls: asDrawn.calls, triangles: asDrawn.triangles, drawn: st.drawn, sprites: st.lamps.sprites, pools: st.lamps.pools },
    stress: { msOn: stress.on, msOff: stress.off, cost: +(stress.on - stress.off).toFixed(3), poolsMs: +(stress.on - stress.noPools).toFixed(3), spritesMs: +(stress.noPools - stress.bodiesOnly).toFixed(3), bodiesMs: +(stress.bodiesOnly - stress.off).toFixed(3), calls: stress.calls, triangles: stress.triangles, drawn: stress.bodies.drawn, sprites: stress.lamps.sprites, pools: stress.pools.pools },
  };
}, want);
console.log(JSON.stringify(r));
await browser.close();

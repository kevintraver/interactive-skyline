// T2.4: the render pipeline (plan 01, sections 5.4, 5.7, 11.8). With bloom 0 and ACES (the classic display) its
// output matches the renderer drawing the scene directly, as T2.3 did, within 1 %; probe() returns the luminance of
// test quads of known emission within 2 %; a stage added at `overlay` changes the frame and removing it restores it.
// T2.5's probes: a sunlit white roof at noon reads 20,000 to 35,000 cd/m2, a lit window at night 30 to 90.
import { test, expect } from '@playwright/test';
import { boot, frames } from '../helpers/app.js';
import { stageScene, grab, compare } from '../helpers/parity.js';

test.describe.configure({ timeout: 900_000 });

/** The canvas drawn by `how` ('pipeline' or 'direct'), as RGB, reduced by 4. */
const shot = (page, how) => page.evaluate(async (how) => {
  const s = window.__skyline, canvas = s.renderer.domElement;
  if (how === 'direct') s.renderer.render(s.scene, s.camera); else s.pipeline.render();
  const blob = await new Promise((r) => canvas.toBlob(r));
  const bmp = await createImageBitmap(blob);
  const w = Math.floor(bmp.width / 4), h = Math.floor(bmp.height / 4);
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data, rgb = [];
  for (let i = 0; i < px.length; i += 4) rgb.push(px[i], px[i + 1], px[i + 2]);
  return { w, h, rgb };
}, how);

test('pipeline at the classic display matches the direct render within 1 %', async ({ page }) => {
  await boot(page, 'lv', 'backend=webgl&display=classic');
  const rows = [];
  for (const scene of [{ view: 'east', look: 'day' }, { view: 'strat', look: 'night' }]) {
    await stageScene(page, scene);
    rows.push({ ...scene, ...compare(await shot(page, 'direct'), await shot(page, 'pipeline')) });
  }
  console.log(JSON.stringify(rows));
  for (const r of rows) expect(r.mad, `${r.view} ${r.look}`).toBeLessThanOrEqual(0.01);
});

test('probe() reads known emission within 2 %, and stages change the frame', async ({ page }) => {
  await boot(page, 'slc', 'backend=webgl');
  await stageScene(page, { view: 'aerial', look: 'day' });
  const r = await page.evaluate(async () => {
    const s = window.__skyline, { MeshBasicNodeMaterial, Mesh, PlaneGeometry } = s.webgpu, { vec3, vec4 } = s.tsl;
    // two quads in front of the camera, left and right, emitting a known luminance in cd/m2 (times the exposure)
    const quad = (cd, x) => {
      const m = new MeshBasicNodeMaterial({ fog: false, depthTest: false });
      m.colorNode = s.env.nodes.emissive(vec3(cd, cd, cd));
      const mesh = new Mesh(new PlaneGeometry(2, 2), m);
      mesh.renderOrder = 100; mesh.frustumCulled = false;
      // centred on NDC (x * 0.5, 0): half the view's half-width to that side, 50 m ahead
      const d = 50, V = s.camera.position.constructor, dir = s.camera.getWorldDirection(new V());
      const right = new V(1, 0, 0).applyQuaternion(s.camera.quaternion);
      const halfH = d * Math.tan((s.camera.fov * Math.PI) / 360), halfW = halfH * s.camera.aspect;
      mesh.position.copy(s.camera.position).addScaledVector(dir, d).addScaledVector(right, x * 0.5 * halfW);
      mesh.quaternion.copy(s.camera.quaternion);
      mesh.scale.setScalar(halfH * 0.3);
      s.scene.add(mesh);
      return mesh;
    };
    const a = quad(4321, -1), b = quad(123.4, 1);
    const left = await s.probe(-0.5, 0), right = await s.probe(0.5, 0);
    s.scene.remove(a, b);
    // a stage at `overlay`: the frame turns red; removed, it is the scene again
    const remove = s.pipeline.addStage({ id: 'test', at: 'overlay', node: () => vec4(1, 0, 0, 1) });
    const red = await s.capture();
    remove();
    const back = await s.capture();
    const mean = async (blob) => {
      const bmp = await createImageBitmap(blob), c = new OffscreenCanvas(32, 20), g = c.getContext('2d');
      g.drawImage(bmp, 0, 0, 32, 20);
      const px = g.getImageData(0, 0, 32, 20).data; let rr = 0, gg = 0;
      for (let i = 0; i < px.length; i += 4) { rr += px[i]; gg += px[i + 1]; }
      return [rr / 640, gg / 640];
    };
    return { left: left.luminanceCdM2, right: right.luminanceCdM2, red: await mean(red), back: await mean(back), exposure: s.env.nodes.exposure.value };
  });
  console.log(JSON.stringify(r));
  expect(Math.abs(r.left / 4321 - 1)).toBeLessThanOrEqual(0.02);
  expect(Math.abs(r.right / 123.4 - 1)).toBeLessThanOrEqual(0.02);
  expect(r.red[0]).toBeGreaterThan(250);
  expect(r.red[1]).toBeLessThan(5);
  expect(r.back[1]).toBeGreaterThan(20);
});

test('T2.5: a sunlit white roof at noon and a lit window at night', async ({ page }) => {
  await boot(page, 'lv', 'backend=webgl');
  // a flat-topped extruded tower, grey (highlight off), seen from straight above at solstice noon
  const roof = await page.evaluate(async () => {
    const s = window.__skyline;
    s.setSetting('highlight', false);
    s.attractions.freeze(47);
    s.env.enterClock();
    s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 12, minute: 45 });
    // a compact extruded tower (a ring-shaped block would show the ground in its courtyard)
    const size = (e) => { e.mesh.geometry.computeBoundingBox(); const bb = e.mesh.geometry.boundingBox; return Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z); };
    const t = s.tall.filter((e) => e.mesh.material.userData.buildingVariant === 'extruded' && size(e) < 50).sort((x, y) => x.data.h - y.data.h)[0];
    const b = t.mesh.geometry.boundingBox, c = b.getCenter(new s.camera.position.constructor());
    Object.assign(s.controls, { minDistance: 1, maxDistance: 1e7, enableDamping: false, maxPolarAngle: Math.PI });
    s.camera.position.set(c.x + 0.01, b.max.y + 80, c.z);
    s.controls.target.set(c.x, b.max.y, c.z);
    s.controls.update();
    s.renderer.shadowMap.needsUpdate = true;
    s.invalidate();
    return { id: t.data.id, h: t.data.h };
  });
  await frames(page, 6);
  // the roof is the brightest thing near the middle of the frame (the photo around it is darker)
  const noon = await page.evaluate(async () => {
    const s = window.__skyline, v = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) v.push((await s.probe(i * 0.03, j * 0.03)).luminanceCdM2);
    v.sort((a, b) => a - b);
    return v[v.length - 3]; // the third brightest, so one edge pixel cannot decide it
  });
  // a tall extruded tower at the reference night, framed from 250 m: probe a grid on its facade (where screen()
  // puts it); the brightest samples are lit panes
  const night = await page.evaluate(async () => {
    const s = window.__skyline, raf = () => new Promise((d) => requestAnimationFrame(d));
    s.clock.set(Date.UTC(2026, 2, 19, 5, 0));
    // the tallest extruded block with a 30 to 80 m footprint (the tallest of all can be a thin mast)
    const size = (e) => { e.mesh.geometry.computeBoundingBox(); const bb = e.mesh.geometry.boundingBox; return Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z); };
    const t = s.tall.filter((e) => e.mesh.material.userData.buildingVariant === 'extruded' && size(e) > 30 && size(e) < 80).sort((x, y) => y.data.h - x.data.h)[0];
    const b = t.mesh.geometry.boundingBox, c = b.getCenter(new s.camera.position.constructor());
    s.camera.position.set(c.x + 250, c.y, c.z + 60);
    s.controls.target.set(c.x, c.y, c.z);
    s.controls.update();
    s.invalidate();
    for (let i = 0; i < 6; i++) await raf();
    const p = s.screen(t.data.id);
    // screen() aims near the top; come down to the middle of the facade
    const cx = (p.x / innerWidth) * 2 - 1, cy = 0;
    const v = [];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) v.push((await s.probe(cx + i * 0.01, cy + j * 0.02)).luminanceCdM2);
    return v.sort((x, y) => x - y);
  });
  const lit = night.filter((v) => v > 20);
  const litMedian = lit.length ? lit[lit.length >> 1] : null;
  console.log(JSON.stringify({ roof, noon, night, litMedian }));
  expect(noon).toBeGreaterThanOrEqual(20000);
  expect(noon).toBeLessThanOrEqual(35000);
  expect(lit.length, 'some samples fall on lit windows').toBeGreaterThan(0);
  expect(litMedian).toBeGreaterThanOrEqual(30);
  expect(litMedian).toBeLessThanOrEqual(90);
});

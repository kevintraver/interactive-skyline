// The drive on a logarithmic depth buffer (plan 02, third stretch, decisions 3 and 7; the path to the pull request,
// step 2). Plan 01's renderer asks for reversed depth; on WebGL2 without EXT_clip_control three refuses it and
// src/render/renderer.js falls back to a logarithmic buffer. Neither SwiftShader nor this machine's GPU lacks the
// extension, so the case is forced here: an init script hides EXT_clip_control from WebGL2 before the app starts.
//
// The same places are drawn on the WebGL2 backend twice, with reversed depth and with the logarithmic buffer, and
// compared: depth decides only what is in front, so wherever the two differ the logarithmic buffer resolved a surface
// differently (the road against the ground at distance, sprites' depth test against the road, decks over roads). The
// cabin, drawn in the scene pass on one camera with a 0.1 m near plane, is checked as drive-cabin.spec.js checks it:
// the world must not show through it, and it must draw the same at a near plane of 0.1 m and of 0.01 m (a part of it
// clipped by the near plane, or fighting itself, differs).
import { test, expect } from '@playwright/test';
import { openAt, watchConsole, backendOf, definePixels, DRIVE_TIMEOUT } from '../helpers/drive.js';

test.describe.configure({ timeout: DRIVE_TIMEOUT * 2 });

/** Hide EXT_clip_control from WebGL2 (three then refuses reversed depth, and the app takes a logarithmic buffer). */
const HIDE_CLIP_CONTROL = () => {
  const P = WebGL2RenderingContext.prototype, list = P.getSupportedExtensions, get = P.getExtension;
  P.getSupportedExtensions = function () { return (list.call(this) || []).filter((n) => n !== 'EXT_clip_control'); };
  P.getExtension = function (name) { return name === 'EXT_clip_control' ? null : get.call(this, name); };
};
/** three's own warning when it refuses reversed depth: expected on the forced page, and only there. */
const REFUSED = /Unable to use reversed depth buffer/;

const run = (page, fn, arg) => page.evaluate(fn, arg);
/** The places: a straight by day far down the road, the reveal at night (sprites, lamps, screens), the cabin by day. */
const SHOTS = [
  { name: 'day, km 30, down the road', s: 30000, t: '2026-11-21T20:30:00Z', view: 'clean', look: { yaw: 0, pitch: -1, lens: 85 } },
  { name: 'night, the reveal', s: 44200, t: '2026-11-22T04:30:00Z', view: 'clean', look: { yaw: 0, pitch: 0, lens: 50 } },
  { name: 'night, km 62, the city', s: 62000, t: '2026-11-22T04:30:00Z', view: 'clean', look: { yaw: 0, pitch: 0, lens: 50 } },
  { name: 'day, the cabin', s: 45000, t: '2026-11-21T20:30:00Z', view: 'cabin', look: { yaw: 0, pitch: 0, lens: 28 } },
];

/** In the page: go to a shot, settle, and return its pixels (as a plain array: it crosses to Node). */
const shoot = (page, shot) => run(page, async ({ s, t, view, look }) => {
  const d = window.__skyline.drive;
  d.setView(view);
  d.seek({ s, t: Date.parse(t) });
  d.look(look);
  await d.whenSettled();
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
  return Array.from(await window.__pixels());
}, shot);

/** The share of pixels whose largest channel differs by more than `tol`, over all and over the top and bottom halves. */
function differ(a, b, W, tol = 24) {
  let all = 0, top = 0, n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const m = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (m > tol) { all++; if (i / 4 < n / 2) top++; }
  }
  return { all: all / n, top: top / (n / 2), bottom: (all - top) / (n / 2), width: W };
}

/** In the page: the cabin drawn at near 0.1 m against 0.01 m, the car alone; and the world through the cabin. */
const cabinChecks = (page) => run(page, async () => {
  const s = window.__skyline, d = s.drive, r = s.renderer, cam = s.camera, cabin = d.cabin(), car = cabin.car;
  const bloom = s.pipeline.settings.bloom;
  s.pipeline.configure({ bloom: 0 });
  const faces = Object.values(cabin.mirrors).map((m) => [m.mesh, m.mesh.visible]);
  for (const [m] of faces) m.visible = false;
  const frame = await window.__pixels();
  const chain = new Set();
  for (let o = car; o; o = o.parent) chain.add(o);
  const hidden = [];
  for (const o of chain) for (const c of o.parent ? o.parent.children : []) if (!chain.has(c) && !c.isLight && c.visible) { hidden.push(c); c.visible = false; }
  const clear = r.getClearColor(s.scene.children.find((o) => o.isLight).color.clone()), clearAlpha = r.getClearAlpha();
  r.setClearColor(0xff00ff, 1);
  const alone = await window.__pixels();
  cam.near = 0.01; cam.updateProjectionMatrix();
  const closer = await window.__pixels();
  cam.near = 0.1; cam.updateProjectionMatrix();
  r.setClearColor(0x00ff00, 1);
  const other = await window.__pixels();
  r.setClearColor(clear, clearAlpha);
  for (const c of hidden) c.visible = true;
  for (const [m, v] of faces) m.visible = v;
  s.pipeline.configure({ bloom });
  s.invalidate();
  const W = r.domElement.width, H = r.domElement.height;
  const same = (i) => alone[i] === other[i] && alone[i + 1] === other[i + 1] && alone[i + 2] === other[i + 2];
  const off = (x, y, i, k) => Math.abs(x[i] - y[i]) > k || Math.abs(x[i + 1] - y[i + 1]) > k || Math.abs(x[i + 2] - y[i + 2]) > k;
  let inside = 0, leaks = 0, clipped = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if (off(alone, closer, i, 8)) clipped++;
      if (!same(i) || !same(i - 4) || !same(i + 4) || !same(i - W * 4) || !same(i + W * 4)) continue;
      inside++;
      if (off(frame, alone, i, 3)) leaks++;
    }
  }
  return { inside: inside / ((W - 2) * (H - 2)), leaks: inside ? leaks / inside : 0, clipped: clipped / (W * H) };
});

test('lv drive on a logarithmic depth buffer: the same frames as reversed depth, and the cabin holds', async ({ browser }) => {
  const open = async (forced) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    if (forced) await page.addInitScript(HIDE_CLIP_CONTROL);
    const problems = watchConsole(page);
    await openAt(page, 'city=lv&backend=webgl&q=high&nobench=1');
    await definePixels(page);
    await run(page, async () => {
      const d = window.__skyline.drive;
      await d.start('i15n', { s: 30000, t: Date.parse('2026-11-21T20:30:00Z'), view: 'clean' });
      d.pause();
      while (!d.cabin()) await new Promise((r) => setTimeout(r, 100));
    });
    return { context, page, problems };
  };
  const ref = await open(false), log = await open(true);

  await test.step('the forced page has a logarithmic buffer, the reference reversed depth, both on WebGL2', async () => {
    const [a, b] = [await backendOf(ref.page), await backendOf(log.page)];
    test.info().annotations.push({ type: 'backends', description: JSON.stringify({ reference: a, forced: b }) });
    expect(a).toMatchObject({ backend: 'webgl2', depth: 'reversed' });
    expect(b).toMatchObject({ backend: 'webgl2', depth: 'logarithmic' });
  });

  const W = await run(ref.page, () => window.__skyline.renderer.domElement.width);
  for (const shot of SHOTS) {
    await test.step(`${shot.name}: within 0.5 % of reversed depth`, async () => {
      const a = await shoot(ref.page, shot), b = await shoot(log.page, shot);
      const d = differ(a, b, W);
      test.info().annotations.push({ type: shot.name, description: JSON.stringify(d) });
      expect.soft(d.all, `${shot.name}: share of the frame that differs`).toBeLessThan(0.005);
      expect.soft(d.top, `${shot.name}: share of the upper half (the distance) that differs`).toBeLessThan(0.005);
    });
  }

  await test.step('the cabin: no world through it, and nothing of it clipped at a 0.1 m near plane', async () => {
    for (const yaw of [0, -100, 100]) {
      await run(log.page, async (y) => { const d = window.__skyline.drive; d.look({ yaw: y, pitch: y === 0 ? -10 : 0, lens: 28 }); await d.whenSettled(); }, yaw);
      const r = await cabinChecks(log.page);
      test.info().annotations.push({ type: `cabin yaw ${yaw}`, description: JSON.stringify(r) });
      expect.soft(r.inside, `cabin on screen at yaw ${yaw}`).toBeGreaterThan(0.02);
      expect.soft(r.leaks, `world through the cabin at yaw ${yaw}`).toBeLessThan(0.001);
      expect.soft(r.clipped, `cabin drawn differently at near 0.1 and 0.01 m, yaw ${yaw}`).toBeLessThan(0.0005);
    }
  });

  expect(ref.problems).toEqual([]);
  expect(log.problems.filter((p) => !REFUSED.test(p))).toEqual([]);
  await ref.context.close();
  await log.context.close();
});

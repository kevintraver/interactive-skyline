// The cabin on real data (route i15n; plan 02, D4.2, D4.5, D4.6): no depth artefacts between cabin and world over a
// look sweep of +/-150 degrees, a constant eye offset with Reduce motion on, the instruments' drawn values, the
// cabin/clean toggle leaving the pose and the time alone, every input of section 4.4 by mouse, touch and keyboard,
// and the view in the address. Asserted on state and on pixel agreement within one frame, never on goldens.
import { test, expect } from '@playwright/test';
import { openCity, openAt, watchConsole, DRIVE_TIMEOUT } from '../helpers/drive.js';

test.describe.configure({ timeout: DRIVE_TIMEOUT });

const run = (page, fn, arg) => page.evaluate(fn, arg);
const pose = (page) => run(page, () => window.__skyline.drive.pose());
const settled = (page) => run(page, async () => { await window.__skyline.drive.whenSettled(); return window.__skyline.drive.pose(); });
const params = (page) => run(page, () => Object.fromEntries(new URLSearchParams(location.search)));
/** Everything pose() reports that the view may not change (the view itself, its lens and the eye it puts the camera at may). */
const carOf = (p) => { const { view, lens, eye, ...rest } = p; return rest; };

/**
 * In the page: the share of cabin pixels that the world shows through. The frame on the canvas is compared with the
 * cabin drawn alone over magenta, with the same camera; inside the cabin's silhouette (shrunk by a pixel, so the
 * antialiased rim does not count) the two must agree. A depth artefact (the world poking through the dashboard,
 * pillars or mirrors) makes them differ.
 */
const cabinLeak = (page) => run(page, async () => {
  const s = window.__skyline, d = s.drive, r = s.renderer, cabin = d.cabin();
  await d.whenSettled();
  for (let i = 0; i < 2; i++) await new Promise((res) => requestAnimationFrame(res));
  const canvas = document.getElementById('scene');
  const grab = () => {
    const c = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
    const g = c.getContext('2d');
    g.drawImage(canvas, 0, 0);
    return g.getImageData(0, 0, c.width, c.height).data;
  };
  const frame = grab();
  // a THREE.Color to keep the clear colour in, without importing three here: any light's colour is one
  const old = { color: r.getClearColor(cabin.cabinScene.children.find((o) => o.isLight).color.clone()), alpha: r.getClearAlpha() };
  r.setClearColor(0xff00ff, 1);
  r.clear();
  const auto = r.autoClear;
  r.autoClear = false;
  r.render(cabin.cabinScene, cabin.cabinCamera);
  r.autoClear = auto;
  const alone = grab();
  r.setClearColor(old.color, old.alpha);
  s.invalidate();
  const W = canvas.width, H = canvas.height;
  const magenta = (i) => alone[i] > 240 && alone[i + 1] < 15 && alone[i + 2] > 240;
  let inside = 0, leaks = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if (magenta(i) || magenta(i - 4) || magenta(i + 4) || magenta(i - W * 4) || magenta(i + W * 4)) continue;
      inside++;
      if (Math.abs(frame[i] - alone[i]) > 3 || Math.abs(frame[i + 1] - alone[i + 1]) > 3 || Math.abs(frame[i + 2] - alone[i + 2]) > 3) leaks++;
    }
  }
  return { inside: inside / ((W - 2) * (H - 2)), leaks: inside ? leaks / inside : 0, model: cabin.model };
});

test('lv drive cabin: depth, motion, instruments, toggle, inputs', async ({ page }) => {
  const problems = watchConsole(page);
  await openCity(page, 'lv');
  await run(page, async () => {
    const d = window.__skyline.drive;
    await d.start('i15n', { s: 44200 });
    d.pause();
    await d.whenSettled();
  });

  await test.step('the cabin is the default view, in the address too', async () => {
    const p = await pose(page);
    expect(p.view).toBe('cabin');
    expect(p.lens).toBe(28);
    expect((await params(page)).view).toBe('cabin');
    const cabin = await run(page, () => {
      const c = window.__skyline.drive.cabin();
      const pt = (v) => [v.x, v.y, v.z];
      return {
        model: c.model, mirrors: Object.keys(c.mirrors), kinds: Object.values(c.mirrors).map((m) => m.kind),
        meshes: Object.values(c.mirrors).every((m) => m.mesh && m.mesh.isMesh), corner: pt(c.windshield.corners.topLeft),
        near: c.cabinCamera.near, far: c.cabinCamera.far,
      };
    });
    expect(['low', 'high']).toContain(cabin.model);
    expect(cabin.mirrors).toEqual(['left', 'right', 'center']);
    expect(cabin.kinds).toEqual(['flat', 'convex', 'flat']);
    expect(cabin.meshes).toBe(true);
    expect(cabin.corner).toEqual([-0.4025, 1.44, -0.68]);
    expect([cabin.near, cabin.far]).toEqual([0.05, 6]);
  });

  await test.step('no depth artefacts between cabin and world over a look sweep of +/-150 degrees', async () => {
    for (const yaw of [0, -150, -100, -50, 50, 100, 150]) {
      await run(page, (y) => window.__skyline.drive.look({ yaw: y, pitch: y === 0 ? -10 : 0 }), yaw);
      const r = await cabinLeak(page);
      expect(r.inside, `cabin on screen at yaw ${yaw}`).toBeGreaterThan(0.02);
      expect(r.leaks, `world through the cabin at yaw ${yaw}`).toBeLessThan(0.001);
    }
    await run(page, () => window.__skyline.drive.look({ yaw: 0, pitch: 0 }));
  });

  await test.step('the instruments draw the pose\'s speed in the chosen units and the city\'s local time', async () => {
    const read = (units) => run(page, async (u) => {
      const s = window.__skyline, d = s.drive;
      s.setSetting('units', u);
      d.seek({ s: d.pose().s + 1 }); // a jump: the displays redraw at once
      await d.whenSettled();
      const p = d.pose();
      const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).format(p.t);
      return { r: d.cabin().readout, mph: p.mph, kmh: p.speed * 3.6, clock };
    }, units);
    const ft = await read('ft');
    expect(ft.r.unit).toBe('mph');
    expect(Math.abs(+ft.r.speed - ft.mph)).toBeLessThanOrEqual(1);
    expect(ft.r.clock).toBe(ft.clock);
    expect(ft.r.temp).toBe(null); // the environment has no temperature today
    expect(ft.r.next).toMatch(/^Exit /);
    const m = await read('m');
    expect(m.r.unit).toBe('km/h');
    expect(Math.abs(+m.r.speed - m.kmh)).toBeLessThanOrEqual(1);
    await read('ft');
  });

  await test.step('cabin and clean change neither the pose nor the simulation time', async () => {
    const a = await pose(page);
    await run(page, () => window.__skyline.drive.setView('clean'));
    const b = await pose(page);
    expect(b.view).toBe('clean');
    expect(b.lens).toBe(50);
    expect(carOf(b)).toEqual(carOf(a));
    await page.keyboard.press('c');
    const c = await pose(page);
    expect(c.view).toBe('cabin');
    expect(carOf(c)).toEqual(carOf(a));
    expect((await params(page)).view).toBe('cabin');
  });

  await test.step('with Reduce motion on, the camera\'s offset from the path is constant', async () => {
    const offsets = (on) => run(page, async (flag) => {
      const d = window.__skyline.drive;
      d.setReduceMotion(flag);
      const out = [];
      for (const s of [20000, 30120, 44200, 52345, 60000]) { d.seek({ s }); out.push(d.eyeOffset()); }
      return out;
    }, on);
    const still = await offsets(true);
    for (const o of still) {
      expect(o.right).toBeCloseTo(still[0].right, 6);
      expect(o.up).toBeCloseTo(still[0].up, 6);
      expect(o.forward).toBeCloseTo(still[0].forward, 6);
    }
    expect((await pose(page)).reduceMotion).toBe(true);
    const moving = await offsets(false);
    expect(moving.some((o) => Math.abs(o.up - moving[0].up) > 1e-5 || Math.abs(o.right - moving[0].right) > 1e-5)).toBe(true);
    await run(page, async () => { window.__skyline.drive.seek({ s: 44200 }); await window.__skyline.drive.whenSettled(); });
  });

  // points in the sky above the road: a tap there picks no building
  const box = await page.locator('#scene').boundingBox();
  const sky = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.22 };

  await test.step('keyboard: look, zoom, look ahead, glances and the view', async () => {
    await run(page, () => { document.activeElement?.blur(); window.__skyline.drive.look({ yaw: 0, pitch: 0, lens: 28 }); });
    await page.keyboard.press('a');
    await page.keyboard.press('w');
    let p = await pose(page);
    expect([p.yaw, p.pitch]).toEqual([5, 5]);
    await page.keyboard.press('d');
    await page.keyboard.press('s');
    await page.keyboard.press('+');
    p = await pose(page);
    expect([p.yaw, p.pitch]).toEqual([0, 0]);
    expect(p.lens).toBeCloseTo(35, 6);
    await page.keyboard.press('-');
    await page.keyboard.press('a');
    await page.keyboard.press('r');
    p = await pose(page);
    expect([p.yaw, p.pitch, p.lens]).toEqual([0, 0, 28]);
    for (const [key, name] of [['2', 'left'], ['3', 'right'], ['4', 'center'], ['1', 'ahead']]) {
      await page.keyboard.press(key);
      expect((await pose(page)).glance, `key ${key}`).toBe(name);
    }
    // a glance eases back by itself, and the head is where it was
    await run(page, () => new Promise((res) => setTimeout(res, 2000)));
    p = await pose(page);
    expect(p.glance).toBe(null);
    expect([p.yaw, p.pitch]).toEqual([0, 0]);
    await page.keyboard.press('c');
    expect((await pose(page)).view).toBe('clean');
    await page.keyboard.press('c');
    expect((await pose(page)).view).toBe('cabin');
  });

  await test.step('mouse: drag to look, wheel to zoom, double-click to look ahead, the view popover', async () => {
    await page.mouse.move(sky.x, sky.y);
    await page.mouse.down();
    await page.mouse.move(sky.x + 60, sky.y + 30, { steps: 4 });
    await page.mouse.up();
    let p = await pose(page);
    expect(p.yaw).toBeGreaterThan(3);
    expect(p.pitch).toBeGreaterThan(1);
    await page.mouse.wheel(0, -300);
    expect((await pose(page)).lens).toBeGreaterThan(28);
    await page.mouse.dblclick(sky.x, sky.y);
    p = await pose(page);
    expect([p.yaw, p.pitch]).toEqual([0, 0]);
    await run(page, () => window.__skyline.drive.look({ lens: 28 }));

    const button = page.locator('#drivebar .view');
    await button.click();
    await expect(page.locator('#drive-view')).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#drive-view .glances [data-glance="left"]').click();
    expect((await pose(page)).glance).toBe('left');
    await page.locator('#drive-view label', { hasText: 'Clean' }).click();
    expect((await pose(page)).view).toBe('clean');
    await expect(page.locator('#drive-view .glances')).toBeHidden(); // no mirrors without a car
    await page.locator('#drive-view label', { hasText: 'Cabin' }).click();
    expect((await pose(page)).view).toBe('cabin');
    await page.locator('#drive-view label', { hasText: 'Reduce motion' }).click();
    expect((await pose(page)).reduceMotion).toBe(true);
    await page.locator('#drive-view label', { hasText: 'Reduce motion' }).click();
    expect((await pose(page)).reduceMotion).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#drive-view')).toBeHidden();
  });

  await test.step('touch: one finger looks, two pinch the lens, a double-tap looks ahead', async () => {
    const touch = (events) => run(page, (list) => {
      const c = document.getElementById('scene');
      for (const [type, id, x, y] of list) {
        c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
      }
    }, events);
    const { x, y } = sky;
    await touch([['pointerdown', 11, x, y], ['pointermove', 11, x + 20, y], ['pointermove', 11, x + 50, y + 10], ['pointerup', 11, x + 50, y + 10]]);
    let p = await pose(page);
    expect(p.yaw).toBeGreaterThan(2);
    const lens = p.lens;
    await touch([['pointerdown', 11, x - 40, y], ['pointerdown', 12, x + 40, y], ['pointermove', 11, x - 80, y], ['pointermove', 12, x + 80, y], ['pointerup', 11, x - 80, y], ['pointerup', 12, x + 80, y]]);
    p = await pose(page);
    expect(p.lens).toBeGreaterThan(lens * 1.5);
    await touch([['pointerdown', 11, x, y], ['pointerup', 11, x, y], ['pointerdown', 11, x + 3, y + 2], ['pointerup', 11, x + 3, y + 2]]);
    p = await pose(page);
    expect([p.yaw, p.pitch]).toEqual([0, 0]);
  });

  expect(problems).toEqual([]);
});

test('lv drive cabin: view=clean in a link opens the clean camera', async ({ page }) => {
  const problems = watchConsole(page);
  await openAt(page, 'city=lv&mode=drive&route=i15n&s=44200&t=2026-11-21T20:30:00Z&view=clean');
  await run(page, async () => {
    const d = window.__skyline.drive;
    while (!d.active() || !d.pose() || document.getElementById('drivebar').classList.contains('busy')) await new Promise((r) => requestAnimationFrame(r));
  });
  const p = await settled(page);
  expect(p.view).toBe('clean');
  expect(p.lens).toBe(50);
  expect((await params(page)).view).toBe('clean');
  await run(page, () => window.__skyline.drive.setView('cabin'));
  expect((await params(page)).view).toBe('cabin');
  expect(problems).toEqual([]);
});

// The mirrors and the windshield (plan 02, D4.3 and D4.4). A magenta box 30 m behind the car in the next lane must
// show in the correct mirror on the correct side, read back from the mirrors' own render targets; a settled frame's
// mirrors are all current; the windshield layer is drawn in the cabin pass only.
test('lv drive cabin: mirrors show the road behind on the correct side; settled mirrors are current', async ({ page }) => {
  const problems = watchConsole(page);
  await openCity(page, 'lv');
  await run(page, async () => {
    const d = window.__skyline.drive;
    await d.start('i15n', { s: 44200, t: Date.parse('2026-11-20T23:30:00Z') }); // a Friday afternoon, traffic behind
    d.pause();
    while (!d.cabin()) await new Promise((r) => setTimeout(r, 100));
    await d.whenSettled();
  });

  /** Put the marker `lateral` metres to the car's right, 30 m behind, and find it in each mirror. */
  const markerIn = (lateral) => run(page, async (lat) => {
    const s = window.__skyline, d = s.drive, g = d.cabin().glass.mirrors;
    const p = d.pose(), f = p.forward, u = p.up;
    const r = { x: f.y * u.z - f.z * u.y, y: f.z * u.x - f.x * u.z, z: f.x * u.y - f.y * u.x }; // forward x up = right
    const at = (k) => p.position[k] - f[k] * 30 + r[k] * lat + u[k] * 1.0;
    g.marker({ x: at('x'), y: at('y'), z: at('z') }, 1.6);
    s.invalidate();
    await d.whenSettled();
    const found = {};
    for (const name of ['left', 'right', 'center']) {
      const img = g.read(name);
      let n = 0, sx = 0;
      for (let i = 0; i < img.width * img.height; i++) {
        const R = img.data[4 * i], G = img.data[4 * i + 1], B = img.data[4 * i + 2];
        if (R > 0.5 && B > 0.5 && G < 0.2 * Math.min(R, B)) { n++; sx += i % img.width; }
      }
      // as the driver sees the face: u to the right (the image is flipped in u on the face)
      found[name] = { share: n / (img.width * img.height), u: n ? 1 - sx / n / img.width : null };
    }
    g.marker(null);
    return found;
  }, lateral);

  await test.step('a vehicle 30 m behind in the lane to the left: in the left mirror, left of the interior mirror\'s middle', async () => {
    const m = await markerIn(-3.7);
    expect(m.left.share, 'left mirror').toBeGreaterThan(0.01);
    expect(m.right.share, 'right mirror').toBe(0);
    expect(m.center.share, 'interior mirror').toBeGreaterThan(0.005);
    expect(m.center.u).toBeLessThan(0.5);
  });

  await test.step('a vehicle 30 m behind in the lane to the right: in the right mirror, right of the interior mirror\'s middle', async () => {
    const m = await markerIn(3.7);
    expect(m.right.share, 'right mirror').toBeGreaterThan(0.002);
    expect(m.left.share, 'left mirror').toBe(0);
    expect(m.center.share, 'interior mirror').toBeGreaterThan(0.005);
    expect(m.center.u).toBeGreaterThan(0.5);
  });

  await test.step('farther out in the left mirror is farther left on its face', async () => {
    const near = await markerIn(-3.0), far = await markerIn(-5.5);
    expect(near.left.share).toBeGreaterThan(0);
    expect(far.left.share).toBeGreaterThan(0);
    expect(far.left.u).toBeLessThan(near.left.u);
  });

  await test.step('a settled frame\'s mirrors are all current: drawn on the last frame, at its simulation time', async () => {
    for (const at of [{ s: 44800 }, { s: 60000, t: Date.parse('2026-11-21T01:30:00Z') }]) {
      const r = await run(page, async (a) => {
        const d = window.__skyline.drive, g = d.cabin().glass.mirrors;
        // played a little first, so the rotation has left the mirrors at different frames
        d.play();
        for (let i = 0; i < 5; i++) await new Promise((res) => requestAnimationFrame(res));
        d.pause();
        d.seek(a);
        await d.whenSettled();
        return { t: d.pose().t, frame: g.frame, stamps: g.stamps(), playing: d.pose().playing };
      }, at);
      expect(r.playing).toBe(false);
      for (const name of ['left', 'right', 'center']) {
        expect(r.stamps[name].simMs, name).toBe(r.t);
        expect(r.stamps[name].frame, name).toBe(r.frame);
      }
    }
  });

  await test.step('the windshield is a layer of the cabin pass; the clean camera draws neither glass nor mirrors', async () => {
    const r = await run(page, async () => {
      const d = window.__skyline.drive, c = d.cabin(), g = c.glass;
      const inCabin = g.windshield.mesh.parent === c.cabinScene;
      const before = g.mirrors.frame;
      d.setView('clean');
      d.seek({ s: d.pose().s + 5 });
      await d.whenSettled();
      const after = g.mirrors.frame;
      d.setView('cabin');
      await d.whenSettled();
      return { inCabin, before, after, w: c.stats().windshield, model: c.model, presets: Object.keys(g.options) };
    });
    expect(r.inCabin).toBe(true);
    expect(r.after).toBe(r.before);
    expect(r.w.enabled).toBe(true);
    expect(r.presets).toEqual(['mirrors', 'windshield', 'rain']);
  });

  expect(problems).toEqual([]);
});

// Rain on the windshield (plan 02, D8.2): drops, film and wipers are a pure function of simulation time, so the same
// time gives the same pixels over the glass after seeking away and back; dry, the rain layer draws nothing.
test('lv drive cabin: rain on the glass is the same at the same time; dry leaves the glass as it was', async ({ page }) => {
  const problems = watchConsole(page);
  await openCity(page, 'lv');
  const NIGHT = Date.parse('2026-11-22T02:30:00Z');
  await run(page, async (t) => {
    const d = window.__skyline.drive;
    await d.start('i15n', { s: 44200, t });
    d.pause();
    while (!d.cabin()) await new Promise((r) => setTimeout(r, 100));
    await d.whenSettled();
  }, NIGHT);

  /** In the page: set the rain, go to (s, t), settle, and read the canvas over the windshield opening. */
  const glassPixels = (at) => run(page, async ({ s, t, rain, glass }) => {
    const sk = window.__skyline, d = sk.drive, c = d.cabin();
    let weather = null;
    sk.scene.traverse((o) => { if (o.userData?.weatherPart) weather = o.userData.weatherPart; });
    weather.setRain(rain);
    c.glass.rain.setEnabled(glass !== false);
    d.seek({ s, t });
    await d.whenSettled();
    sk.invalidate();
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    const canvas = document.getElementById('scene');
    // the opening's box on the canvas, through the cabin camera
    const cam = c.cabinCamera, xs = [], ys = [];
    for (const k of ['bottomLeft', 'bottomRight', 'topRight', 'topLeft']) {
      const q = c.windshield.corners[k].clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
      xs.push(((q.x + 1) / 2) * canvas.width); ys.push(((1 - q.y) / 2) * canvas.height);
    }
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const x1 = Math.min(canvas.width, Math.ceil(Math.max(...xs))), y1 = Math.min(canvas.height, Math.ceil(Math.max(...ys)));
    const tmp = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
    const g = tmp.getContext('2d');
    g.drawImage(canvas, 0, 0);
    const data = Array.from(g.getImageData(x0, y0, x1 - x0, y1 - y0).data);
    const st = c.glass.rain.state();
    return { data, box: [x0, y0, x1, y1], mode: st.mode, angle: st.angle, dropCount: st.dropCount, visible: c.glass.rain.meshes.map((m) => m.visible) };
  }, at);
  /** Share of pixels that differ by more than `tol` in any channel. */
  const differ = (a, b, tol = 2) => {
    expect(a.box).toEqual(b.box);
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.abs(a.data[i] - b.data[i]) > tol || Math.abs(a.data[i + 1] - b.data[i + 1]) > tol || Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) n++;
    }
    return n / (a.data.length / 4);
  };

  const here = { s: 44200, t: NIGHT + 7300, rain: 12 };
  await test.step('in heavy rain the same time gives the same glass after seeking away and back, forward and backward', async () => {
    const a = await glassPixels(here);
    expect(a.mode).toBe('high');
    expect(a.dropCount).toBeGreaterThan(100);
    expect(a.visible).toEqual([true, true, true]);
    await glassPixels({ ...here, s: 47000, t: here.t + 600000 }); // away, forward
    const b = await glassPixels(here);
    expect(b.angle).toBe(a.angle);
    expect(b.dropCount).toBe(a.dropCount);
    expect(differ(a, b), 'after a seek forward and back').toBeLessThan(0.002);
    await glassPixels({ ...here, s: 41000, t: here.t - 900000 }); // away, backward
    const c = await glassPixels(here);
    expect(differ(a, c), 'after a seek backward and back').toBeLessThan(0.002);
    // and the glass does show something: without the rain layer the same frame differs over much of the opening
    const bare = await glassPixels({ ...here, glass: false });
    expect(differ(a, bare, 8)).toBeGreaterThan(0.02);
  });

  await test.step('dry: wipers off, no drops, and the rain layer leaves the glass\'s pixels as they were', async () => {
    const dry = await glassPixels({ ...here, rain: 0 });
    expect(dry.mode).toBe('off');
    expect(dry.dropCount).toBe(0);
    expect(dry.visible).toEqual([false, false, false]);
    const without = await glassPixels({ ...here, rain: 0, glass: false });
    expect(differ(dry, without, 0)).toBe(0);
    await glassPixels({ ...here, rain: 0, glass: true });
  });

  expect(problems).toEqual([]);
});

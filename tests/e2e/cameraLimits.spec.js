// The explore camera's limits (src/interaction/cameraLimits.js) by real mouse and wheel input: the pivot stays
// over the terrain, rides it, the camera stays above the ground, the motion settles, and nothing that moves the
// camera itself (a journey, setView, focusOn, a tower drag) is changed.
//
// Every controls.update() is recorded (an outer wrapper around the limited update, so it sees what each update
// left, including the ones the controls make inside their own pointer handlers), not only the end of a gesture.
import { test, expect } from '@playwright/test';
import { CITIES, views, frames } from '../helpers/app.js';

// a small window: SwiftShader's frame time grows with the pixels, and nothing here depends on the picture
const W = 640, H = 400, CX = W / 2, CY = H / 2 - 20;
test.use({ viewport: { width: W, height: H } });

async function boot(page, city, query = '') {
  await page.goto(`/?city=${city}${query}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 90_000 });
  await page.evaluate(() => window.__skyline.attractions.ready);
  // the hint card and the toast would sit under some drags
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#hint, #toast')) el.style.pointerEvents = 'none';
    window.__skyline.attractions.freeze(47);
  });
}

/** Start recording the state after every controls.update(). */
const record = (page) => page.evaluate(() => {
  const s = window.__skyline, L = s.cameraLimits, c = s.camera.position, t = s.controls.target;
  const inner = s.controls.update;
  window.__rec = [];
  s.controls.update = function (dt) {
    const r = inner.call(this, dt);
    window.__rec.push([t.x, t.y, t.z, c.x, c.y, c.z, L.groundAt(t.x, t.z), L.groundAt(c.x, c.z)]);
    return r;
  };
});
/** Samples since the last call, as objects. */
const take = (page) => page.evaluate(() => {
  const out = window.__rec.map(([tx, ty, tz, cx, cy, cz, gt, gc]) => ({ tx, ty, tz, cx, cy, cz, gt, gc, d: Math.hypot(cx - tx, cy - ty, cz - tz) }));
  window.__rec = [];
  return out;
});
const clearance = (d) => Math.max(10, 0.01 * d);

/** A left-button (map) or right-button (turn and tilt) drag from the middle by (dx, dy) pixels. */
async function drag(page, dx, dy, button = 'left', steps = 4) {
  await page.mouse.move(CX, CY);
  await page.mouse.down({ button });
  await page.mouse.move(CX + dx, CY + dy, { steps });
  await page.mouse.up({ button });
}

/** Put the pivot on the ground at map (x, north), the camera `dist` away at `elevDeg` above the horizon. */
const place = (page, x, y, dist, elevDeg = 40, agl = 0, bearingDeg = 180) => page.evaluate(({ x, y, dist, elevDeg, agl, bearingDeg }) => {
  const s = window.__skyline, L = s.cameraLimits, e = elevDeg * Math.PI / 180, b = bearingDeg * Math.PI / 180;
  const ty = L.groundAt(x, -y) + agl;
  s.controls.target.set(x, ty, -y);
  s.camera.position.set(x + Math.sin(b) * Math.cos(e) * dist, ty + Math.sin(e) * dist, -y - Math.cos(b) * Math.cos(e) * dist);
  s.controls.update();
  s.invalidate();
}, { x, y, dist, elevDeg, agl, bearingDeg });

/** The highest ground in a box of map coordinates (inside the bounds): a mountain to stand on. */
const summitIn = (page, x0, x1, y0, y1) => page.evaluate(({ x0, x1, y0, y1 }) => {
  const L = window.__skyline.cameraLimits;
  let best = { h: -Infinity };
  for (let x = x0; x <= x1; x += 250) for (let y = y0; y <= y1; y += 250) {
    const h = L.groundAt(x, -y);
    if (h > best.h) best = { x, y, h };
  }
  return best;
}, { x0, x1, y0, y1 });
// the Spring Mountains west of Las Vegas, the Wasatch east of Salt Lake City
const MOUNTAINS = { lv: [-40000, -15000, -10000, 25000], slc: [4000, 20000, -30000, 8000] };

/**
 * Wait until the controls' damping has run out and the loop has nothing to draw, then count the frames drawn over
 * `n` animation frames (animation frames, not wall time: a SwiftShader frame under load takes seconds).
 */
async function idleFrames(page, n = 30) {
  await page.waitForFunction(() => {
    const c = window.__skyline.controls;
    return c._panOffset.length() < 1e-4 && Math.abs(c._sphericalDelta.theta) + Math.abs(c._sphericalDelta.phi) < 1e-7;
  }, null, { timeout: 600_000, polling: 100 });
  await page.evaluate(() => window.__skyline.loop.settle());
  const f0 = await page.evaluate(() => window.__skyline.perf.frames());
  await frames(page, n);
  return (await page.evaluate(() => window.__skyline.perf.frames())) - f0;
}

/**
 * Make frames cheap: a quarter of the pixels and, unless `keep` (the tests that pick towers), nothing drawn. The
 * limits read the height field, not the meshes, so what these tests check does not depend on the picture.
 */
const lighten = (page, keep = false) => page.evaluate((keep) => {
  const s = window.__skyline;
  s.renderer.setPixelRatio(0.25);
  if (!keep) for (const c of s.scene.children) c.visible = false;
  s.invalidate();
}, keep);

for (const city of CITIES) {
  test.describe(`camera limits, ${city}`, () => {
    test.describe.configure({ timeout: 900_000 });
    test.beforeEach(async ({ page }, info) => {
      await boot(page, city);
      await lighten(page, /tower/.test(info.title));
    });

    test('a hundred drags each way: the pivot stays over real terrain, the camera above it', async ({ page }) => {
      const { bounds, terrain } = await page.evaluate(() => ({ bounds: window.__skyline.cameraLimits.bounds, terrain: window.__skyline.cameraLimits.terrain }));
      await record(page);
      const reached = {};
      for (const [name, dx, dy] of [['left', -150, 0], ['right', 150, 0], ['up', 0, -120], ['down', 0, 120]]) {
        await page.evaluate(() => window.__skyline.setView('aerial'));
        await place(page, 0, 0, 12000, 35); // far enough out that a hundred drags cross the whole map
        await take(page);
        for (let i = 0; i < 100; i++) await drag(page, dx, dy, 'left', 3);
        await frames(page, 30);
        const rec = await take(page);
        expect(rec.length, name).toBeGreaterThan(100);
        let edge = Infinity;
        for (const r of rec) {
          expect(r.tx, `${name}: pivot x`).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
          expect(r.tx, `${name}: pivot x`).toBeLessThanOrEqual(bounds.maxX + 1e-6);
          expect(r.tz, `${name}: pivot z`).toBeGreaterThanOrEqual(bounds.minZ - 1e-6);
          expect(r.tz, `${name}: pivot z`).toBeLessThanOrEqual(bounds.maxZ + 1e-6);
          expect(r.tx > terrain.minX && r.tx < terrain.maxX && r.tz > terrain.minZ && r.tz < terrain.maxZ, `${name}: over the terrain grid`).toBe(true);
          expect(r.cy - r.gc, `${name}: camera above the ground`).toBeGreaterThanOrEqual(clearance(r.d) - 0.01);
          edge = Math.min(edge, r.tx - bounds.minX, bounds.maxX - r.tx, r.tz - bounds.minZ, bounds.maxZ - r.tz);
        }
        reached[name] = edge;
        // and it holds still at the edge: no bounce, no creep
        expect(await idleFrames(page), `${name}: idle at the edge`).toBe(0);
      }
      // each direction really ran into a bound
      for (const [name, edge] of Object.entries(reached)) expect(edge, name).toBeLessThan(1);
    });

    for (const where of ['city', 'mountain']) {
      test(`tilting to the limit, ${where}: never below ground plus clearance, at 300 m, 3 km and 30 km`, async ({ page }) => {
        const spot = where === 'city' ? { x: 0, y: 0 } : await summitIn(page, ...MOUNTAINS[city]);
        // on the mountain, a point on its flank, 600 m from the top towards the city
        const at = where === 'city' ? spot : { x: spot.x + Math.sign(-spot.x) * 600, y: spot.y };
        await record(page);
        for (const dist of [300, 3000, 30000]) {
          for (const bearing of [0, 90, 180, 270]) {
            await place(page, at.x, at.y, dist, 35, 0, bearing);
            await take(page);
            const elev = [];
            for (let i = 0; i < 3; i++) {
              await drag(page, 0, -110, 'right', 5); // drag up: towards the horizon and past it
              await frames(page, 20);
              elev.push(await page.evaluate(() => {
                const s = window.__skyline, c = s.camera.position, t = s.controls.target;
                return Math.asin((c.y - t.y) / c.distanceTo(t)) * 180 / Math.PI;
              }));
            }
            const rec = await take(page);
            expect(rec.length).toBeGreaterThan(5);
            for (const r of rec) expect(r.cy - r.gc, `${dist} m, bearing ${bearing}`).toBeGreaterThanOrEqual(clearance(r.d) - 0.01);
            // it tilted, and the last drag found it at a limit (its clearance, a ridge in the way, or 93.6 degrees)
            expect(elev[2], `${dist} m, bearing ${bearing}: tilted`).toBeLessThan(30);
            expect(Math.abs(elev[2] - elev[1]), `${dist} m, bearing ${bearing}: at a limit`).toBeLessThan(0.05);
          }
          expect(await idleFrames(page), `${dist} m: idle`).toBe(0);
        }
      });
    }

    test('dragging across mountains close up: the pivot keeps its height above the ground, no jumps', async ({ page }) => {
      const top = await summitIn(page, ...MOUNTAINS[city]);
      await record(page);
      for (const [agl, dir] of [[0, 1], [60, -1]]) {
        // start on the far side of the top, and drag across it, then on along the range
        await place(page, top.x - dir * 1500, top.y, 400, 40, agl, 180);
        await take(page);
        for (let i = 0; i < 40; i++) await drag(page, -dir * 90, 0, 'left', 6);
        await frames(page, 30);
        const rec = await take(page);
        const start = rec[0].ty - rec[0].gt;
        let climbed = 0, worstOff = 0, worstStep = 0;
        for (let i = 1; i < rec.length; i++) {
          const a = rec[i - 1], b = rec[i];
          const across = Math.hypot(b.tx - a.tx, b.tz - a.tz), up = Math.abs(b.cy - a.cy);
          climbed += Math.abs(b.gt - a.gt);
          worstOff = Math.max(worstOff, Math.abs(b.ty - b.gt - start));
          worstStep = Math.max(worstStep, up - 1.5 * across);
          expect(b.cy - b.gc, 'camera above the ground').toBeGreaterThanOrEqual(clearance(b.d) - 0.01);
        }
        expect(Math.abs(start - agl), 'started where placed').toBeLessThan(1e-6 + 0.5);
        expect(climbed, 'the drag went over real relief').toBeGreaterThan(150);
        expect(worstOff, 'pivot height above the ground').toBeLessThan(25);
        // the camera's vertical step stays within a steep slope of the horizontal one: no spike
        expect(worstStep, 'vertical step beyond 1.5 x the horizontal').toBeLessThan(2);
        expect(await idleFrames(page)).toBe(0);
      }
    });

    test('zoom to the cursor on a mountainside and out at a corner of the bounds', async ({ page }) => {
      const top = await summitIn(page, ...MOUNTAINS[city]);
      await record(page);
      // looking at the flank from low down, the pivot on the slope in the middle of the view: zoom in on it
      const side = Math.sign(-top.x); // the city's side of the range
      await place(page, top.x + side * 600, top.y, 4000, 8, 0, side > 0 ? 90 : 270);
      await take(page);
      await page.mouse.move(W / 2, H / 2 - 30); // just above the pivot: the slope above it
      for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -120);
      await frames(page, 10);
      let rec = await take(page);
      for (const r of rec) expect(r.cy - r.gc, 'zooming in').toBeGreaterThanOrEqual(clearance(r.d) - 0.01);
      expect(await idleFrames(page)).toBe(0);
      // fully out at a corner of the bounds
      const b = await page.evaluate(() => window.__skyline.cameraLimits.bounds);
      await place(page, b.maxX, -b.maxZ, 3000, 30, 0, 225);
      await page.mouse.move(CX, CY);
      for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 200);
      await frames(page, 10);
      rec = await take(page);
      for (const r of rec) {
        expect(r.cy - r.gc, 'zooming out').toBeGreaterThanOrEqual(clearance(r.d) - 0.01);
        expect(r.tx).toBeLessThanOrEqual(b.maxX + 1e-6);
        expect(r.tz).toBeLessThanOrEqual(b.maxZ + 1e-6);
      }
      expect(await idleFrames(page)).toBe(0);
    });

    test('after a gesture the camera settles within a second of frames and the loop goes idle', async ({ page }) => {
      await page.evaluate(() => window.__skyline.setView('aerial'));
      const watch = () => page.evaluate(() => {
        const s = window.__skyline;
        window.__moves = [];
        const last = s.camera.position.clone();
        window.__unwatch = s.loop.add({ update() {
          window.__moves.push([last.distanceTo(s.camera.position), s.camera.position.distanceTo(s.controls.target)]);
          last.copy(s.camera.position);
        } }, 99);
      });
      const moves = () => page.evaluate(() => { window.__unwatch(); return window.__moves; });
      for (const [what, act] of [
        ['map drag', () => drag(page, 120, 60)],
        ['tilt', () => drag(page, 0, -200, 'right', 6)],
        ['turn', () => drag(page, 200, 0, 'right', 6)],
        ['wheel', async () => { await page.mouse.move(CX, CY); for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -150); }],
      ]) {
        await watch();
        await act();
        expect(await idleFrames(page), `${what}: idle`).toBe(0);
        const m = await moves();
        // a second at 60 Hz after the input: whatever damping is left moves the camera by less than a pixel a frame,
        // and only ever less (no oscillation, no creep)
        const tail = m.slice(60);
        for (const [step, d] of tail) expect(step, `${what}: still after 60 frames`).toBeLessThan(d * 1e-3);
        const creep = tail.reduce((sum, [step]) => sum + step, 0);
        expect(creep, `${what}: no creep`).toBeLessThan((m.at(-1)?.[1] || 1) * 0.01);
      }
    });

    test('setView, focusOn and the hooks are left exactly as they were', async ({ page }) => {
      const state = () => page.evaluate(() => {
        const s = window.__skyline;
        return { c: s.camera.position.toArray(), t: s.controls.target.toArray(), armed: s.cameraLimits.armed };
      });
      // the named views, before and after the limits have acted on a gesture
      const before = {};
      for (const v of views(city)) { await page.evaluate((v) => window.__skyline.setView(v), v); before[v] = await state(); }
      for (const v of views(city)) {
        await page.evaluate(() => window.__skyline.setView('aerial'));
        for (let i = 0; i < 4; i++) await drag(page, -150, 90);
        // straight after the drag, while its damping is still running: the view drops what is left of it
        expect((await state()).armed).toBe(true);
        await page.evaluate((v) => window.__skyline.setView(v), v);
        await frames(page, 30);
        const after = await state();
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(after.c[i] - before[v].c[i]), `${v}: camera`).toBeLessThan(1e-3);
          expect(Math.abs(after.t[i] - before[v].t[i]), `${v}: target`).toBeLessThan(1e-3);
        }
        expect(after.armed).toBe(false);
      }

      // focusOn lands where its own maths says, started while the gesture's damping is still running
      await drag(page, 40, 20);
      const focus = await page.evaluate(async () => {
        const s = window.__skyline, e = s.tall[0], b = e.data;
        s.focusOn(e);
        await new Promise((done) => { const f = () => (s.flying() ? requestAnimationFrame(f) : done()); requestAnimationFrame(f); });
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const base = s.camera.position.clone().sub(s.controls.target);
        return {
          q: [b.c[0] + e.offset.x, e.offset.y + b.h * 0.5, -b.c[1] + e.offset.z], t: s.controls.target.toArray(),
          dist: base.length(), want: Math.min(Math.max(b.h * 7 + 550, 800), 1700), armed: s.cameraLimits.armed,
        };
      });
      expect(focus.armed).toBe(false);
      expect(focus.t[0]).toBeCloseTo(focus.q[0], 6);
      expect(focus.t[2]).toBeCloseTo(focus.q[2], 6);
      expect(focus.dist).toBeCloseTo(focus.want, 3);

      // the hooks: a camera set directly stays where it was put, even under the ground
      await drag(page, 30, 0);
      expect(await idleFrames(page)).toBe(0); // (an update with damping off applies what is left of it, as always)
      const set = await page.evaluate(async () => {
        const s = window.__skyline;
        s.controls.enableDamping = false;
        s.camera.position.set(500, -400, 500);
        s.controls.target.set(60000, 0, 0); // outside the bounds as well
        s.controls.update();
        s.invalidate();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        s.controls.enableDamping = true;
        return { t: s.controls.target.x, armed: s.cameraLimits.armed };
      });
      expect(set.armed).toBe(false);
      expect(Math.abs(set.t - 60000)).toBeLessThan(1e-3); // not pulled back inside the bounds
    });

    test('dragging a tower does not move the camera', async ({ page }) => {
      const state = () => page.evaluate(() => {
        const s = window.__skyline;
        return { c: s.camera.position.toArray(), t: s.controls.target.toArray(), armed: s.cameraLimits.armed };
      });
      // a wheel tick arms the limits (a wheel zoom has no damping, so nothing is left moving the camera; a drag's
      // damping takes minutes to run out on SwiftShader in Las Vegas)
      const arm = async () => {
        await page.evaluate(() => window.__skyline.setView('aerial'));
        await page.mouse.move(CX, CY);
        await page.mouse.wheel(0, 1);
        await frames(page, 3);
        expect((await state()).armed).toBe(true);
      };
      await arm();
      const candidates = await page.evaluate(() => {
        const s = window.__skyline;
        return s.tall.map((e) => ({ id: e.data.id, ...s.screen(e.data.id) })).filter((p) => p.x > 120 && p.x < 520 && p.y > 60 && p.y < 300).slice(0, 12);
      });
      let draggedOne = false;
      for (const tower of candidates) {
        await page.evaluate((id) => window.__skyline.select(id), tower.id);
        await frames(page, 2);
        const cam0 = await state();
        await page.mouse.move(tower.x, tower.y);
        await page.mouse.down();
        await page.mouse.move(tower.x + 40, tower.y + 15, { steps: 6 });
        await page.mouse.up();
        await frames(page, 10);
        if (!(await page.evaluate((id) => window.__skyline.movedIds().includes(id), tower.id))) {
          await arm(); // a missed grab panned the map: back to the view (setView discards the spin) and try the next
          continue;
        }
        const cam1 = await state();
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(cam1.c[i] - cam0.c[i]), 'camera').toBeLessThan(1e-6);
          expect(Math.abs(cam1.t[i] - cam0.t[i]), 'target').toBeLessThan(1e-6);
        }
        draggedOne = true;
        break;
      }
      expect(draggedOne, 'a tower was dragged').toBe(true);

    });

    test('the limits can be switched off for other modes', async ({ page }) => {
      const r = await page.evaluate(() => {
        const L = window.__skyline.cameraLimits;
        return { enabled: L.enabled, keys: ['minX', 'maxX', 'minZ', 'maxZ'].every((k) => Number.isFinite(L.bounds[k])) };
      });
      expect(r).toEqual({ enabled: true, keys: true });
      await page.evaluate(() => { window.__skyline.cameraLimits.enabled = false; window.__skyline.setView('aerial'); });
      await place(page, 0, 0, 12000, 35);
      for (let i = 0; i < 60; i++) await drag(page, 0, 120, 'left', 2);
      await frames(page, 10);
      const out = await page.evaluate(() => {
        const s = window.__skyline, L = s.cameraLimits, t = s.controls.target;
        return t.x < L.bounds.minX || t.x > L.bounds.maxX || t.z < L.bounds.minZ || t.z > L.bounds.maxZ;
      });
      expect(out).toBe(true);
    });
  });
}

test('?journey=test moves the camera exactly as before, whatever the visitor did', async ({ page }) => {
  test.setTimeout(900_000);
  await boot(page, 'slc', '&journey=test');
  await lighten(page);
  const at = (s) => page.evaluate(async (s) => {
    const k = window.__skyline;
    k.timeline.active.seek(s);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))));
    const c = k.camera.position, t = k.controls.target, L = k.cameraLimits;
    return { c: c.toArray(), t: t.toArray(), agl: c.y - L.groundAt(c.x, c.z), armed: L.armed };
  }, s);
  const a = await at(50);
  expect(a.agl).toBeCloseTo(450, 6);
  for (let i = 0; i < 6; i++) await drag(page, -150, 80);
  await idleFrames(page); // the controls' own damping dies away (it moves a journey's camera as it always has)
  const b = await at(50);
  for (let i = 0; i < 3; i++) {
    expect(b.c[i]).toBeCloseTo(a.c[i], 4);
    expect(b.t[i]).toBeCloseTo(a.t[i], 4);
  }
  expect(b.armed).toBe(false);
});

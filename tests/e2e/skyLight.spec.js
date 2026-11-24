// T1.3, T1.4 and T1.6: the legacy sky driven by the clock (plan 01, phase 1).
import { test, expect } from '@playwright/test';
import { CITIES, boot, frames, views, SHOW_TIME } from '../helpers/app.js';

/** The instant each city's Sun stands where the pinned day has always put it (azimuth 245, altitude 32). */
const CLASSIC = {
  lv: Date.UTC(2026, 2, 23, 23, 8), // 245.00, 32.05 (plan 01, section 5.6)
  slc: Date.UTC(2026, 2, 31, 22, 53, 20), // 245.15, 32.13: the closest that spring
};

/** Put the app into the clock state at `timeMs` on `view`, with the show clocks held, everything redrawn. */
async function stageClock(page, { view, timeMs }) {
  await page.evaluate(({ view, timeMs, show }) => {
    const s = window.__skyline;
    s.attractions.freeze(show);
    s.setView(view);
    s.env.enterClock();
    s.clock.set(timeMs);
    s.renderer.shadowMap.needsUpdate = true;
    s.invalidate();
  }, { view, timeMs, show: SHOW_TIME });
  await frames(page, 4);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')).opacity === '0');
  await page.evaluate(() => { window.__skyline.renderer.shadowMap.needsUpdate = true; window.__skyline.invalidate(); });
  await frames(page, 3);
  // phase 2: the automatic exposure has metered the scene and stopped adapting
  await page.waitForFunction(() => { const l = window.__skyline.look; return !l || l.exposure.state.settled; }, null, { timeout: 600_000 });
  await frames(page, 2);
}

for (const city of CITIES) {
  test.describe(`sky light ${city}`, () => {
    // software rendering redraws the 4096-pixel shadow map slowly, and these tests draw many frames
    test.describe.configure({ timeout: 900_000 });
    test.beforeEach(async ({ page }) => { await boot(page, city); });

    test('T1.3: the key light points at the Sun of the ephemeris, within 0.01 deg, at two times', async ({ page }) => {
      for (const hour of [9.5, 15.25]) {
        const t = await page.evaluate((hour) => {
          const s = window.__skyline;
          s.env.enterClock();
          s.clock.setLocal({ year: 2026, month: 7, day: 14, hour: Math.floor(hour), minute: (hour % 1) * 60 });
          return s.clock.timeMs;
        }, hour);
        await frames(page, 3);
        const err = await page.evaluate((t) => {
          const s = window.__skyline, d = s.sun.position.clone().sub(s.sun.target.position).normalize();
          const angle = (Math.acos(Math.min(1, d.dot(s.env.ephemeris.at(t).sun.dir))) * 180) / Math.PI;
          return { angle, body: s.env.state.key.body, intensity: s.sun.intensity };
        }, t);
        expect(err.body).toBe('sun');
        expect(err.angle).toBeLessThan(0.01);
        expect(err.intensity).toBeGreaterThan(0);
      }
    });

    test('T1.3: no key light between sunset and the Sun 6 deg down; the Moon after that when it is up', async ({ page }) => {
      await page.evaluate(() => {
        const s = window.__skyline;
        s.env.enterClock();
        s.clock.set(s.env.ephemeris.timeOfSunAltitude(-3, Date.UTC(2026, 6, 14, 12), 'setting'));
      });
      await frames(page, 3);
      const r = await page.evaluate(() => ({ body: window.__skyline.env.state.key.body, intensity: window.__skyline.sun.intensity }));
      expect(r).toEqual({ body: 'none', intensity: 0 });
      // 29 July 2026 is a full Moon: at 11:30 pm the Sun is far down and the Moon well up
      await page.evaluate(() => window.__skyline.clock.setLocal({ year: 2026, month: 7, day: 29, hour: 23, minute: 30 }));
      await frames(page, 3);
      const m = await page.evaluate(() => {
        const s = window.__skyline, d = s.sun.position.clone().sub(s.sun.target.position).normalize();
        return { body: s.env.state.key.body, moonUp: s.env.state.moon.altDeg > 2, angle: (Math.acos(Math.min(1, d.dot(s.env.state.moon.dir))) * 180) / Math.PI,
          intensity: s.sun.intensity };
      });
      expect(m.moonUp).toBe(true);
      expect(m.body).toBe('moon');
      expect(m.angle).toBeLessThan(0.01);
      expect(m.intensity).toBeGreaterThan(0);
    });

    test('T1.3: a scrub re-renders the shadow map at most once per 0.1 deg of solar motion', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 200 });
      const r = await page.evaluate(async () => {
        const s = window.__skyline, raf = () => new Promise((done) => requestAnimationFrame(done));
        s.env.enterClock();
        s.clock.setLocal({ year: 2026, month: 7, day: 14, hour: 10, minute: 0 });
        for (let i = 0; i < 5; i++) await raf();
        const t0 = s.clock.timeMs, n = 48, step = 12000; // 9.6 minutes in 48 frames: about 0.05 deg a frame
        const shadows0 = s.perf.shadowRenders(), frames0 = s.perf.frames();
        let motion = 0, prev = s.env.ephemeris.at(t0).sun.dir;
        for (let i = 1; i <= n; i++) {
          s.clock.set(t0 + i * step);
          await raf();
          const d = s.env.ephemeris.at(t0 + i * step).sun.dir;
          motion += (Math.acos(Math.min(1, d.dot(prev))) * 180) / Math.PI;
          prev = d;
        }
        await raf(); await raf();
        return { shadows: s.perf.shadowRenders() - shadows0, frames: s.perf.frames() - frames0, motion };
      });
      test.info().annotations.push({ type: 'scrub', description: JSON.stringify(r) });
      expect(r.frames).toBeGreaterThanOrEqual(44); // the scrub did render (about one frame per step)
      expect(r.shadows).toBeGreaterThan(0);
      expect(r.shadows).toBeLessThanOrEqual(Math.ceil(r.motion / 0.1) + 1);
      expect(r.shadows).toBeLessThan(r.frames * 0.75);
    });

    test('T1.4: a 400-frame dusk scrub has no step: mean luminance moves less than 3 % a frame', async ({ page }) => {
      // one city is enough for the look (it is the same code); a software frame of Las Vegas takes seconds
      test.skip(city !== 'slc', 'run in Salt Lake City');
      test.setTimeout(2_400_000);
      await page.setViewportSize({ width: 320, height: 200 }); // the same scene, read back faster
      await page.evaluate((view) => { window.__skyline.attractions.freeze(47); window.__skyline.setView(view); }, views(city)[0]);
      await frames(page, 3);
      const r = await page.evaluate(async () => {
        const s = window.__skyline, gl = s.renderer.getContext(), raf = () => new Promise((done) => requestAnimationFrame(done));
        const day = Date.UTC(2026, 6, 14, 12);
        const from = s.env.ephemeris.timeOfSunAltitude(10, day, 'setting'), to = s.env.ephemeris.timeOfSunAltitude(-18, day, 'setting');
        s.env.enterClock();
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
        const mean = () => {
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let sum = 0;
          for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          return sum / (w * h);
        };
        const lum = [], missed = [];
        for (let i = 0; i <= 400; i++) {
          // (a 400-frame scrub, as T1.4 asks)
          const f0 = s.perf.frames();
          s.clock.set(from + ((to - from) * i) / 400);
          await raf();
          if (s.perf.frames() === f0) await raf();
          if (s.perf.frames() === f0) missed.push(i);
          lum.push(mean());
        }
        let worst = 0, at = 0;
        for (let i = 1; i < lum.length; i++) {
          const step = Math.abs(lum[i] - lum[i - 1]) / Math.max(lum[i - 1], 1);
          if (step > worst) { worst = step; at = i; }
        }
        return { worst, at, first: lum[0], last: lum[400], missed: missed.length };
      });
      test.info().annotations.push({ type: 'dusk', description: JSON.stringify(r) });
      expect(r.missed).toBe(0);
      expect(r.last).toBeLessThan(r.first * 0.6); // it did get dark
      expect(r.worst, `largest step at frame ${r.at}`).toBeLessThan(0.03);
    });

    test('T1.6: the Moon\'s lit fraction on screen matches phaseFraction within 0.05 at four phases', async ({ page }) => {
      await page.evaluate(() => window.__skyline.setView('aerial'));
      const results = [];
      for (const date of [[2026, 7, 18], [2026, 7, 21], [2026, 7, 25], [2026, 7, 29]]) {
        await page.evaluate(([y, m, d]) => {
          const s = window.__skyline;
          s.env.enterClock();
          // the moment that day the Moon stands highest with the Sun down (or simply highest)
          s.clock.setLocal({ year: y, month: m, day: d, hour: 0, minute: 0 });
          const start = s.clock.timeMs;
          let best = null;
          for (let k = 0; k < 24 * 4; k++) {
            const t = start + k * 900000, c = s.env.ephemeris.at(t);
            const score = c.moon.altDeg + (c.sun.altDeg < -6 ? 90 : 0);
            if (!best || score > best.score) best = { t, score };
          }
          s.clock.set(best.t);
        }, date);
        await frames(page, 3);
        const r = await page.evaluate(() => {
          const s = window.__skyline, gl = s.renderer.getContext(), cam = s.camera, moon = s.scene.getObjectByName('moon disc');
          const st = s.env.state, saved = { fov: cam.fov, q: cam.quaternion.clone() };
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          cam.fov = 1.6;
          cam.updateProjectionMatrix();
          cam.lookAt(cam.position.clone().add(st.moon.dir));
          const read = () => { s.renderer.render(s.scene, cam); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
          const lit = read();
          const light = moon.material.uniforms.lightDir.value.clone();
          moon.material.uniforms.lightDir.value.copy(st.moon.dir).negate(); // lit from the eye: the whole disc
          const full = read();
          moon.material.uniforms.lightDir.value.copy(light);
          moon.visible = false;
          const none = read();
          moon.visible = true;
          let nLit = 0, nFull = 0;
          for (let i = 0; i < none.length; i += 4) {
            const d = (a) => Math.max(a[i] - none[i], a[i + 1] - none[i + 1], a[i + 2] - none[i + 2]);
            if (d(lit) > 20) nLit++;
            if (d(full) > 20) nFull++;
          }
          cam.fov = saved.fov;
          cam.quaternion.copy(saved.q);
          cam.updateProjectionMatrix();
          s.invalidate();
          return { measured: nLit / nFull, expected: st.moon.phaseFraction, discPx: nFull, alt: st.moon.altDeg };
        });
        results.push(r);
      }
      test.info().annotations.push({ type: 'moon', description: JSON.stringify(results) });
      for (const r of results) {
        expect(r.alt).toBeGreaterThan(5);
        expect(r.discPx).toBeGreaterThan(5000);
        expect(Math.abs(r.measured - r.expected)).toBeLessThan(0.05);
      }
      // the four cover a crescent to a full Moon
      expect(results[0].expected).toBeLessThan(0.4);
      expect(results[3].expected).toBeGreaterThan(0.95);
    });

    for (const view of views(city)) {
      test(`T1.4: the reference night in the clock state matches the ${view} night golden within 2 %`, async ({ page }) => {
        await stageClock(page, { view, timeMs: Date.UTC(2026, 2, 19, 5, 0) });
        await expect(page).toHaveScreenshot(`${city}-${view}-night.png`, { maxDiffPixelRatio: 0.02 });
      });
    }

    for (const view of views(city)) {
      test(`T1.3: the classic afternoon in the clock state matches the ${view} day golden within 1 %`, async ({ page }) => {
        await stageClock(page, { view, timeMs: CLASSIC[city] });
        await expect(page).toHaveScreenshot(`${city}-${view}-day.png`, { maxDiffPixelRatio: 0.01 });
      });
    }
  });
}

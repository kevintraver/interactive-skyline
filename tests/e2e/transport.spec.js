// T1.8: the transport bar and the built-in test journey (plan 01, sections 4.3 and 11.3).
import { test, expect } from '@playwright/test';
import { frames } from '../helpers/app.js';

const CITY = 'slc';
async function bootJourney(page, extra = '') {
  await page.goto(`/?city=${CITY}&journey=test${extra}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 90_000 });
  await page.evaluate(() => window.__skyline.attractions.ready);
}
const read = (page) => page.evaluate(() => {
  const s = window.__skyline, h = s.timeline.active;
  return { t: s.clock.timeMs, progress: h && h.progressS, start: h && h.startMs, sunAz: s.env.state.sun.azDeg, sunAlt: s.env.state.sun.altDeg,
    cam: s.camera.position.toArray(), mode: s.env.mode };
});

test.describe('transport and the test journey', () => {
  test.describe.configure({ timeout: 300_000 });

  test('hidden outside journeys; shown, last in the dock, during one', async ({ page }) => {
    await page.goto(`/?city=${CITY}`);
    await page.waitForFunction(() => window.__skyline && window.__skyline.attractions);
    await expect(page.locator('#transport')).toBeHidden();
    await bootJourney(page);
    await expect(page.locator('#transport')).toBeVisible();
    await expect(page.locator('#transport .label')).toHaveText('Test journey');
    expect(await page.evaluate(() => document.getElementById('dock').lastElementChild.id)).toBe('transport');
    await expect(page.locator('#transport-slot')).toBeHidden();
    await page.evaluate(() => window.__skyline.transport.slotAbove.append(document.createElement('div')));
    await expect(page.locator('#transport-slot')).toBeAttached();
    expect(await page.evaluate(() => document.getElementById('transport-slot').hidden)).toBe(false);
  });

  test('scrubbing the journey moves the clock and the Sun (and the camera)', async ({ page }) => {
    await bootJourney(page);
    await page.evaluate(() => window.__skyline.timeline.active.setTimeOfDay(10, 0));
    await frames(page, 3);
    const a = await read(page);
    const box = await page.locator('#transport .scrub').boundingBox();
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    await frames(page, 3);
    const b = await read(page);
    expect(b.mode).toBe('clock');
    expect(b.progress - a.progress).toBeGreaterThan(60);
    expect(b.t - a.t).toBeCloseTo((b.progress - a.progress) * 1000, -1);
    expect(b.start).toBe(a.start);
    expect(b.sunAz).not.toBe(a.sunAz);
    expect(Math.hypot(b.cam[0] - a.cam[0], b.cam[2] - a.cam[2])).toBeGreaterThan(1000);
  });

  test('"Depart at" moves the Sun and not the camera', async ({ page }) => {
    await bootJourney(page);
    await page.evaluate(() => window.__skyline.timeline.active.seek(40));
    await frames(page, 3);
    const a = await read(page);
    const local = await page.evaluate(() => window.__skyline.clock.local());
    const pad = (n) => String(n).padStart(2, '0');
    await page.locator('#transport .depart input').fill(`${local.year}-${pad(local.month)}-${pad(local.day)}T06:30`);
    await page.locator('#transport .depart input').dispatchEvent('change');
    await frames(page, 3);
    const b = await read(page);
    expect(b.progress).toBeCloseTo(a.progress, 6);
    expect(b.start).not.toBe(a.start);
    expect(Math.abs(b.sunAlt - a.sunAlt) + Math.abs(b.sunAz - a.sunAz)).toBeGreaterThan(1);
    expect(b.cam.map((v, i) => Math.abs(v - a.cam[i])).every((d) => d < 0.01)).toBe(true);
  });

  test('frozen-sky holds the clock while the journey runs', async ({ page }) => {
    await bootJourney(page);
    const r = await page.evaluate(async () => {
      const s = window.__skyline, raf = () => new Promise((d) => requestAnimationFrame(d));
      const j = s.timeline.active.journey;
      s.clock.play();
      const h = s.timeline.begin(j, { coupling: 'frozen-sky' });
      // wait for rendered frames, not wall time: a software frame under load can take more than a second
      await raf(); await raf();
      const t0 = s.clock.timeMs, p0 = h.progressS, f0 = s.perf.frames(), w0 = performance.now();
      while (s.perf.frames() - f0 < 6) await raf();
      return { dt: s.clock.timeMs - t0, dp: h.progressS - p0, wall: (performance.now() - w0) / 1000, playing: s.clock.playing };
    });
    expect(r.dt).toBe(0);
    expect(r.playing).toBe(false);
    // progress runs on wall time: about the time those frames took (each frame's step is capped at a second)
    expect(r.dp).toBeGreaterThan(Math.min(r.wall, 5) * 0.5);
    expect(r.dp).toBeLessThanOrEqual(r.wall + 0.1);
  });

  test('play, speed and Now', async ({ page }) => {
    await bootJourney(page);
    await page.locator('#transport .speed').selectOption('4');
    await page.locator('#transport .play').click();
    let r = await page.evaluate(() => ({ playing: window.__skyline.clock.playing, rate: window.__skyline.clock.rate }));
    expect(r).toEqual({ playing: true, rate: 4 });
    await page.locator('#transport .play').click();
    await page.evaluate(() => window.__skyline.timeline.active.seek(30));
    await page.locator('#transport .now').click();
    r = await page.evaluate(() => {
      const s = window.__skyline, h = s.timeline.active;
      return { live: s.clock.live, drift: Math.abs(h.startMs + h.progressS * 1000 - Date.now()), progress: h.progressS };
    });
    expect(r.live).toBe(true);
    expect(r.progress).toBeGreaterThanOrEqual(30);
    expect(r.drift).toBeLessThan(30000);
  });
});

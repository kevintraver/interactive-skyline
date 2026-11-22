// T1.7: the two states of decision 3 (plan 01, sections 4.2 and 5.6). Pinned is today's app; the clock state
// derives settings.night from the Sun without saving it; #night returns to the opposite pinned look.
import { test, expect } from '@playwright/test';
import { CITIES, boot, frames } from '../helpers/app.js';

const STORE = 'slc-skyline-settings';
const saved = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').night, STORE);

for (const city of CITIES) {
  test.describe(`sky state ${city}`, () => {
    test.beforeEach(async ({ page }) => { await boot(page, city); });

    test('opens pinned on today\'s day look, with the clock paused', async ({ page }) => {
      const r = await page.evaluate(() => {
        const s = window.__skyline;
        return { mode: s.env.mode, playing: s.clock.playing, night: s.settings.night, theme: document.documentElement.dataset.theme,
          sun: s.sun.intensity, t: new URL(location.href).searchParams.get('t') };
      });
      expect(r).toEqual({ mode: 'pinned', playing: false, night: false, theme: 'light', sun: 2.7, t: null });
    });

    test('clock state: settings.night follows the Sun and is not saved; #night pins the opposite look', async ({ page }) => {
      // a pinned night first, so the saved value is true
      await page.locator('#night').click();
      expect(await saved(page)).toBe(true);
      const midnight = await page.evaluate(() => {
        const s = window.__skyline;
        s.env.enterClock();
        // local noon on 21 June
        s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 12, minute: 0 });
        return null;
      });
      await frames(page, 3);
      let r = await page.evaluate(() => ({ mode: window.__skyline.env.mode, night: window.__skyline.settings.night, theme: document.documentElement.dataset.theme,
        pressed: document.getElementById('night').getAttribute('aria-pressed') }));
      expect(r).toEqual({ mode: 'clock', night: false, theme: 'light', pressed: 'false' });
      expect(await saved(page)).toBe(true); // the derived value is not written over the pinned one
      // change another setting while in the clock state: the saved night is still the pinned one
      await page.evaluate(() => window.__skyline.setSetting('highlight', false));
      expect(await saved(page)).toBe(true);
      await page.evaluate(() => window.__skyline.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 23, minute: 30 }));
      await frames(page, 3);
      r = await page.evaluate(() => ({ night: window.__skyline.settings.night, theme: document.documentElement.dataset.theme }));
      expect(r.night).toBe(true);
      expect(r.theme).toBe('dark');
      // paused: the instant reaches the address bar once the clock settles
      await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get('t'))).toMatch(/^2026-06-21T23:30[-+]\d\d:\d\d$/);
      // #night from a clock night returns to the pinned day
      await page.locator('#night').click();
      r = await page.evaluate(() => ({ mode: window.__skyline.env.mode, night: window.__skyline.settings.night, theme: document.documentElement.dataset.theme,
        sun: window.__skyline.sun.intensity, t: new URL(location.href).searchParams.get('t'), midnight: null }));
      expect(r).toEqual({ mode: 'pinned', night: false, theme: 'light', sun: 2.7, t: null, midnight });
      expect(await saved(page)).toBe(false);
    });

    test('from a clock day, #night pins the night; setSetting always pins and pauses', async ({ page }) => {
      await page.evaluate(() => {
        const s = window.__skyline;
        s.env.enterClock();
        s.clock.setLocal({ year: 2026, month: 3, day: 23, hour: 12, minute: 0 });
        s.clock.play();
      });
      await frames(page, 3);
      await page.locator('#night').click();
      let r = await page.evaluate(() => ({ mode: window.__skyline.env.mode, night: window.__skyline.settings.night, playing: window.__skyline.clock.playing }));
      expect(r).toEqual({ mode: 'pinned', night: true, playing: false });
      // setSetting('night', same value as the derived one) still pins
      r = await page.evaluate(() => {
        const s = window.__skyline;
        s.env.enterClock();
        s.clock.setLocal({ year: 2026, month: 3, day: 23, hour: 12, minute: 0 });
        s.env.update();
        s.setSetting('night', false);
        return { mode: s.env.mode, night: s.settings.night, sun: s.sun.intensity };
      });
      expect(r).toEqual({ mode: 'pinned', night: false, sun: 2.7 });
    });

    test('a ?t= link opens in the clock state at that instant', async ({ page }) => {
      test.setTimeout(300_000); // three page loads, the last with the live clock running (software frames take seconds)
      await page.goto(`/?city=${city}&t=2026-06-21T23:30:00Z`);
      await page.waitForFunction(() => window.__skyline && window.__skyline.attractions);
      const r = await page.evaluate(() => ({ mode: window.__skyline.env.mode, t: window.__skyline.clock.timeMs, playing: window.__skyline.clock.playing }));
      expect(r).toEqual({ mode: 'clock', t: Date.UTC(2026, 5, 21, 23, 30), playing: false });
      await page.goto(`/?city=${city}&t=now`);
      await page.waitForFunction(() => window.__skyline && window.__skyline.attractions);
      const live = await page.evaluate(() => ({ mode: window.__skyline.env.mode, live: window.__skyline.clock.live, drift: Math.abs(window.__skyline.clock.timeMs - Date.now()) }));
      expect(live.mode).toBe('clock');
      expect(live.live).toBe(true);
      // the clock reads the wall clock on each rendered frame (twice a second; a software-rendered frame can take seconds)
      expect(live.drift).toBeLessThan(30000);
      const t0 = await page.evaluate(() => window.__skyline.clock.timeMs);
      await expect.poll(() => page.evaluate(() => window.__skyline.clock.timeMs), { timeout: 30000 }).toBeGreaterThan(t0);
    });
  });
}

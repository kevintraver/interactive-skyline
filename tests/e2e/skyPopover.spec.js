// T1.5: #sky-toggle and the #sky popover (plan 01, sections 4.2 and 4.5), driven by real pointer and keyboard input.
import { test, expect } from '@playwright/test';
import { boot, frames } from '../helpers/app.js';

const CITY = 'slc'; // the lighter city: a software-rendered frame of Las Vegas takes seconds
const state = (page) => page.evaluate(() => ({ mode: window.__skyline.env.mode, live: window.__skyline.clock.live,
  playing: window.__skyline.clock.playing, rate: window.__skyline.clock.rate, t: window.__skyline.clock.timeMs }));
/** The local day the clock is in, and its events. */
const today = (page) => page.evaluate(() => {
  const s = window.__skyline, p = s.clock.local();
  const start = s.clock.timeMs - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (s.clock.timeMs % 1000);
  return { start, ev: s.env.ephemeris.events(start) };
});

test.describe('the #sky popover', () => {
  test.describe.configure({ timeout: 300_000 });
  test.beforeEach(async ({ page }) => { await boot(page, CITY); });

  test('drag the scrubber to the sunset tick: the clock lands within a minute of sunset', async ({ page }) => {
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky')).toBeVisible();
    // start from a known morning, then drag by hand
    await page.evaluate(() => { const s = window.__skyline; s.env.enterClock(); s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: 9, minute: 0 }); });
    await frames(page, 2);
    const scrub = await page.locator('#sky-scrub').boundingBox();
    const tick = await page.locator('.sky-track .tick[data-event="sunset"]').boundingBox();
    const value = await page.locator('#sky-scrub').evaluate((el) => Number(el.value) / Number(el.max));
    const thumbX = scrub.x + 8 + (scrub.width - 16) * value;
    await page.mouse.move(thumbX, scrub.y + scrub.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(thumbX + ((tick.x + tick.width / 2 - thumbX) * i) / 12, scrub.y + scrub.height / 2);
    await page.mouse.up();
    const { ev } = await today(page);
    const s = await state(page);
    expect(s.mode).toBe('clock');
    expect(Math.abs(s.t - ev.sunset) / 1000).toBeLessThan(60);
  });

  test('quick jumps, play, speed and the date', async ({ page }) => {
    await page.locator('#sky-toggle').click();
    await page.locator('#sky .seg label', { hasText: 'Sunset' }).click();
    const { ev } = await today(page);
    expect(Math.abs((await state(page)).t - ev.sunset)).toBeLessThan(1000);
    await page.locator('#sky .seg label', { hasText: 'Noon' }).click();
    expect(Math.abs((await state(page)).t - ev.noon)).toBeLessThan(1000);
    await page.locator('#sky-play').click();
    expect(await state(page)).toMatchObject({ playing: true, rate: 1 });
    await page.locator('#sky-speed').selectOption('600');
    expect(await state(page)).toMatchObject({ playing: true, rate: 600 });
    await page.locator('#sky-play').click();
    expect((await state(page)).playing).toBe(false);
    await page.locator('#sky-date').fill('2026-12-21');
    await page.locator('#sky-date').dispatchEvent('change');
    const local = await page.evaluate(() => window.__skyline.clock.local());
    expect([local.year, local.month, local.day]).toEqual([2026, 12, 21]);
  });

  test('keys: N goes live, T toggles #sky, Space plays, comma and period step, brackets change speed', async ({ page }) => {
    await page.locator('#scene').click({ position: { x: 640, y: 120 } }); // focus the page, not a field
    await page.keyboard.press('n');
    expect(await state(page)).toMatchObject({ mode: 'clock', live: true });
    await page.keyboard.press('t');
    await expect(page.locator('#sky')).toBeVisible();
    await page.keyboard.press('t');
    await expect(page.locator('#sky')).toBeHidden();
    await page.keyboard.press('Space'); // pause
    const t0 = (await state(page)).t;
    expect((await state(page)).playing).toBe(false);
    await page.keyboard.press('.');
    expect((await state(page)).t - t0).toBe(600000);
    await page.keyboard.press('Shift+Comma');
    expect((await state(page)).t - t0).toBe(600000 - 3600000);
    await page.keyboard.press('Alt+Period');
    expect((await state(page)).t - t0).toBe(600000 - 3600000 + 86400000);
    await page.keyboard.press(']');
    expect(await state(page)).toMatchObject({ playing: true, rate: 1 });
    await page.keyboard.press(']');
    expect((await state(page)).rate).toBe(60);
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    expect((await state(page)).playing).toBe(false);
  });

  test('typing in the search box does not trigger the time keys', async ({ page }) => {
    await page.locator('#search').click();
    await page.keyboard.type('nt,.[] ');
    expect(await state(page)).toMatchObject({ mode: 'pinned', live: false, playing: false });
    await expect(page.locator('#sky')).toBeHidden();
    await expect(page.locator('#search')).toHaveValue('nt,.[] ');
  });

  test('only one of #settings, #sky and #city-menu is open at a time, however each is opened', async ({ page }) => {
    await page.locator('#options-toggle').click();
    await expect(page.locator('#settings')).toBeVisible();
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
    await page.locator('#options-toggle').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#sky')).toBeHidden();
    // by keyboard: T opens #sky and closes #settings; Enter on the options button closes #sky
    await page.locator('#scene').click({ position: { x: 640, y: 120 } });
    await page.locator('#options-toggle').click();
    await page.keyboard.press('t');
    await expect(page.locator('#sky')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
    await page.locator('#options-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#sky')).toBeHidden();
    await page.locator('#city').click();
    await expect(page.locator('#city-menu')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#city-menu')).toBeHidden();
  });

  test('keyboard-operable with visible focus; Escape closes', async ({ page }) => {
    await page.locator('#scene').click({ position: { x: 640, y: 120 } });
    await page.keyboard.press('t');
    await expect(page.locator('#sky')).toBeVisible();
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const f = await page.evaluate(() => {
        const el = document.activeElement;
        return { id: el.id || el.name || el.textContent.trim(), inside: !!el.closest('#sky'), visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle };
      });
      seen.push(f);
      await page.keyboard.press('Tab');
    }
    for (const f of seen.filter((x) => x.inside)) expect(f.visible && f.outline !== 'none', JSON.stringify(f)).toBe(true);
    expect(seen.filter((x) => x.inside).length).toBeGreaterThanOrEqual(4);
    await page.keyboard.press('Escape');
    await expect(page.locator('#sky')).toBeHidden();
  });
});

test.describe('the #sky popover elsewhere', () => {
  test.describe.configure({ timeout: 300_000 });
  test.use({ timezoneId: 'Asia/Tokyo' });

  test('shows the city\'s local time and zone, not the visitor\'s', async ({ page }) => {
    await boot(page, CITY);
    await page.evaluate(() => { const s = window.__skyline; s.env.enterClock(); s.clock.set(Date.UTC(2026, 0, 15, 19, 5)); });
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky-time')).toHaveText('12:05 PM MST · Thu 15 Jan');
    await page.evaluate(() => window.__skyline.clock.set(Date.UTC(2026, 6, 15, 19, 5)));
    await expect(page.locator('#sky-time')).toHaveText('1:05 PM MDT · Wed 15 Jul');
  });

  test('works at 700 px wide: inside the window and clear of the tools', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await boot(page, CITY);
    await page.locator('#sky-toggle').click();
    const pop = await page.locator('#sky').boundingBox(), tools = await page.locator('#tools').boundingBox();
    expect(pop.x).toBeGreaterThanOrEqual(0);
    expect(pop.y).toBeGreaterThanOrEqual(0);
    expect(pop.x + pop.width).toBeLessThanOrEqual(700);
    expect(pop.y + pop.height).toBeLessThanOrEqual(800);
    expect(pop.x + pop.width).toBeLessThanOrEqual(tools.x); // beside the tools column, not over it
    await page.locator('#sky .seg label', { hasText: 'Night' }).click();
    expect((await state(page)).mode).toBe('clock');
  });
});

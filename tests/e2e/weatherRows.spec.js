// T5.5: the weather rows of #sky (plan 01, section 4.2) by real input, with every weather request answered from the
// recorded fixtures: a historical day loaded from the date field says which sources answered; each preset; each
// slider leaves and returns to "follow data"; the popover fits at 1280 x 800 and at 700 px wide, in both themes.
import { test, expect } from '@playwright/test';
import { boot } from '../helpers/app.js';
import { routeWeather } from '../helpers/weatherRoutes.js';
import { loadFixture } from '../helpers/weatherFixtures.js';

const CITY = 'slc';
const LABELS = ['Clear', 'Hazy', 'Dusty', 'Fair-weather cumulus', 'High cirrus', 'Overcast', 'Rain', 'Monsoon storm', 'Haboob', 'Virga at sunset'];
const SLIDERS = ['lowCloud', 'highCloud', 'cloudBase', 'haze', 'dust', 'humidity', 'windSpeed', 'windDir', 'rain', 'lightning'];
const text = (page, id) => page.locator(`#${id}`).evaluate((el) => el.value ?? el.textContent);

test.describe('the weather rows of #sky', () => {
  test.describe.configure({ timeout: 300_000 });

  test('14 July 1975 from the date field: that day\'s reanalysis and reports, and which sources answered', async ({ page }) => {
    const requested = await routeWeather(page, { fixtures: loadFixture(CITY, '1975-07-14') });
    await boot(page, CITY, { weather: false });
    await page.locator('#sky-toggle').click();
    await page.locator('#sky-date').fill('1975-07-14');
    await page.locator('#sky-date').dispatchEvent('change');
    await page.locator('#sky .seg label', { hasText: 'Noon' }).click(); // 12:00 MDT, inside the recorded day
    await expect(page.locator('#sky-source')).toHaveText(/^History · Mon 14 Jul 1975 · KSLC report \d+:\d\d (AM|PM) · reanalysis · aerosols: climatology · Weather data by Open-Meteo\.com$/);
    expect(requested.filter((u) => u.includes('/api/weather?city=slc&month='))).toEqual([expect.stringMatching(/month=1975-07$/)]);
    await expect(page.locator('#sky-weather')).toHaveText(/ · \d+ mi · \d+ °F · /);
    // the reports' 30SM survives into the state the app reads
    const w = await page.evaluate(() => { const s = window.__skyline; s.env.update(); return s.env.state.weather; });
    expect(w.source).toEqual({ surface: 'metar', clouds: 'metar', aerosol: 'climatology' });
    expect(w.visibilityM).toBeGreaterThan(40000);
    expect(await page.locator('#sky-source a').getAttribute('href')).toBe('https://open-meteo.com/');
  });

  test('each preset, then Back to real', async ({ page }) => {
    await routeWeather(page, { fixtures: loadFixture(CITY, '2023-02-22') });
    await boot(page, CITY, { weather: false });
    await page.locator('#sky-toggle').click();
    await page.locator('#sky .seg label', { hasText: 'Noon' }).click(); // the clock state
    await page.locator('#sky .sky-weather .seg label', { hasText: 'Preset' }).click();
    await expect(page.locator('#sky-preset-row')).toBeVisible();
    expect(await page.locator('#sky-preset option').allTextContents()).toEqual(LABELS);
    for (const label of LABELS) {
      await page.locator('#sky-preset').selectOption({ label });
      await expect(page.locator('#sky-source')).toHaveText(`Preset: ${label}`);
      await expect(page.locator('#sky-real')).toBeVisible();
      const src = await page.evaluate(() => { const s = window.__skyline; s.env.update(); return s.env.state.weather.source.surface; });
      expect(src).toBe('preset');
    }
    expect(await page.evaluate(() => window.__skyline.env.state.weather.dustWall)).toBe(null); // virga: no wall
    await page.locator('#sky-preset').selectOption({ label: 'Haboob' });
    expect(await page.evaluate(() => { const s = window.__skyline; s.env.update(); return s.env.state.weather.dustWall.active; })).toBe(true);
    await page.locator('#sky-real').click();
    await expect(page.locator('#sky-real')).toBeHidden();
    await expect(page.locator('#sky .sky-weather .seg input[value="live"]')).toBeChecked();
  });

  test('this date in history: a year field, and the weather of that year on the clock\'s day', async ({ page }) => {
    const requested = await routeWeather(page, { fixtures: loadFixture(CITY, '1975-07-14') });
    await boot(page, CITY, { weather: false });
    await page.evaluate(() => { const s = window.__skyline; s.env.enterClock(); s.clock.set(Date.UTC(2026, 6, 14, 18)); });
    await page.locator('#sky-toggle').click();
    await page.locator('#sky .sky-weather .seg label', { hasText: 'History' }).click();
    await expect(page.locator('#sky-year')).toBeVisible();
    await page.locator('#sky-year').fill('1975');
    await page.locator('#sky-year').dispatchEvent('change');
    await expect(page.locator('#sky-source')).toHaveText(/^This date in 1975 · KSLC report /);
    expect(requested.some((u) => u.endsWith('/api/weather?city=slc&month=1975-07'))).toBe(true);
  });

  test('every slider leaves "follow data" when moved, says so on the chip, and returns on Follow data', async ({ page }) => {
    await routeWeather(page, { fixtures: loadFixture(CITY, '2023-02-22') });
    await boot(page, CITY, { weather: false });
    await page.evaluate(() => { const s = window.__skyline; s.env.enterClock(); s.clock.set(Date.parse('2023-02-22T19:00:00Z')); });
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky')).toHaveAttribute('data-weather', 'live');
    await page.locator('#sky-adjust').check();
    await expect(page.locator('#sky-sliders')).toBeVisible();
    for (const key of SLIDERS) {
      const row = page.locator(`.sky-slider[data-key="${key}"]`);
      await expect(row).toHaveAttribute('data-state', 'data');
      await expect(row.locator('output')).toHaveText(/^data: /);
      await row.locator('input').focus();
      // one end, then the other: whichever end the data sits at, the slider moves at least once
      await page.keyboard.press('End');
      await page.keyboard.press('Home');
      await expect(row).toHaveAttribute('data-state', 'set');
      await expect(row.locator('.follow')).toBeVisible();
      await expect(page.locator('#sky-source')).toHaveText(/^Adjusted: /);
      await expect(page.locator('#sky-real')).toBeVisible();
      const over = await page.evaluate((k) => window.__skyline.weather.overrides[k], key);
      expect(over, key).toBeDefined();
      await row.locator('.follow').click();
      await expect(row).toHaveAttribute('data-state', 'data');
      await expect(row.locator('.follow')).toBeHidden();
      expect(await page.evaluate(() => Object.keys(window.__skyline.weather.overrides))).toEqual([]);
    }
    // an override reaches the state the app reads, and leaves it again
    await page.locator('.sky-slider[data-key="lightning"] input').focus();
    await page.keyboard.press('End');
    expect(await page.evaluate(() => { const s = window.__skyline; s.env.update(); return s.env.state.weather.storm; })).toMatchObject({ thunder: true, flashRatePerMin: 30 });
    await page.locator('#sky-real').click();
    expect(await page.evaluate(() => { const s = window.__skyline; s.env.update(); return s.env.state.weather.storm.flashRatePerMin; })).toBe(0);
    await expect(page.locator('#sky-source')).toHaveText(/^History · /);
  });

  for (const [width, height] of [[1280, 800], [700, 800], [700, 600]]) {
    for (const theme of ['light', 'dark']) {
      test(`#sky with every weather row fits at ${width} x ${height}, ${theme}, and scrolls inside itself`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await routeWeather(page, { fixtures: loadFixture(CITY, '2023-02-22') });
        await boot(page, CITY, { weather: false });
        if (theme === 'dark') await page.evaluate(() => window.__skyline.setSetting('night', true));
        await page.locator('#sky-toggle').click();
        await page.locator('#sky-adjust').check();
        const box = await page.locator('#sky').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scroll: el.scrollHeight > el.clientHeight, overflow: getComputedStyle(el).overflowY,
            theme: document.documentElement.dataset.theme };
        });
        expect(box.theme).toBe(theme);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.bottom).toBeLessThanOrEqual(height);
        expect(box.right).toBeLessThanOrEqual(width);
        expect(box.overflow).toBe('auto');
        // the last slider can be scrolled to and used
        await page.locator('.sky-slider[data-key="lightning"] input').scrollIntoViewIfNeeded();
        await expect(page.locator('.sky-slider[data-key="lightning"] input')).toBeInViewport();
      });
    }
  }
});

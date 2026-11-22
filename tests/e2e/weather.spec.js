// T5.3: the client weather service in the app (plan 01, sections 5.4 and 6.3), with every weather request intercepted.
// Nothing weather-related loads at boot; each link of the fallback chain (function, Open-Meteo direct, preset); with the
// network blocked the app starts and shows the preset within two seconds; scrubbing across midnight UTC and into the
// next month loads ahead and never jumps.
import { test, expect } from '@playwright/test';
import { boot, WEATHER_URLS } from '../helpers/app.js';
import { routeWeather, syntheticUpstream } from '../helpers/weatherRoutes.js';
import { loadFixture } from '../helpers/weatherFixtures.js';

const CITY = 'slc'; // the lighter city
const AT = '2023-02-22T12:00:00Z'; // snow in freezing fog at KSLC (tests/fixtures/weather/slc-2023-02-22.*)

/** Enter the clock state at an instant without waiting for a frame, and rebuild the state. */
const setClock = (page, iso) => page.evaluate((t) => { const s = window.__skyline; s.env.enterClock(); s.clock.set(Date.parse(t)); s.env.update(); }, iso);
const chip = (page) => page.evaluate(() => ({ chip: document.getElementById('sky-weather').value, source: document.getElementById('sky-source').textContent,
  state: document.getElementById('sky').dataset.weather }));

test.describe('weather', () => {
  test.describe.configure({ timeout: 300_000 });

  test('the pinned app fetches no weather and loads no weather code at boot', async ({ page }) => {
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await boot(page, CITY);
    await page.waitForTimeout(1000);
    expect(requests.filter((u) => WEATHER_URLS.test(u))).toEqual([]);
    expect(requests.filter((u) => /aerosol\.json|\/client[-.]/.test(u))).toEqual([]);
    expect(await page.evaluate(() => ({ weather: 'weather' in window.__skyline, mode: window.__skyline.env.mode,
      source: window.__skyline.env.state.weather.source.surface }))).toEqual({ weather: false, mode: 'pinned', source: 'preset' });
  });

  test('network blocked: opening #sky shows the clear preset within two seconds, and the app runs on it', async ({ page }) => {
    await boot(page, CITY); // boot() blocks every weather request
    // timed in the page, from the click to the fallback on screen (Playwright's own click waits for stable frames,
    // which take seconds each on a software rasterizer)
    await page.evaluate(() => {
      const sky = document.getElementById('sky');
      window.__fallback = new Promise((done) => {
        document.getElementById('sky-toggle').addEventListener('click', () => {
          const t0 = performance.now();
          const check = () => (sky.dataset.weather === 'unavailable' ? done(performance.now() - t0) : setTimeout(check, 5));
          check();
        }, { once: true });
      });
    });
    await page.locator('#sky-toggle').click();
    const elapsed = await page.evaluate(() => window.__fallback);
    test.info().annotations.push({ type: 'fallback ms', description: String(Math.round(elapsed)) });
    expect(elapsed).toBeLessThan(2000);
    const c = await chip(page);
    expect(c.chip).toMatch(/^Clear · /);
    expect(c.source).toBe('Weather unavailable · showing Clear');
    await setClock(page, AT);
    expect(await page.evaluate(() => window.__skyline.env.state.weather.source.surface)).toBe('preset');
  });

  test('network hanging: #sky says it is loading at once, and the state is the preset meanwhile', async ({ page }) => {
    await routeWeather(page, { api: 'hang', direct: 'hang' });
    const t0 = Date.now();
    await boot(page, CITY, { weather: false });
    test.info().annotations.push({ type: 'ready ms', description: String(Date.now() - t0) });
    // opened in the page, and read at once (the client gives up on a silent request after six seconds)
    const state = await page.evaluate(async () => {
      document.getElementById('sky-toggle').click();
      const sky = document.getElementById('sky');
      await new Promise((r) => { const w = () => (sky.dataset.weather ? r() : setTimeout(w, 5)); w(); });
      const s = window.__skyline;
      s.env.enterClock();
      s.env.update();
      return { weather: sky.dataset.weather, source: document.getElementById('sky-source').textContent, state: s.env.state.weather.source.surface };
    });
    expect(state).toEqual({ weather: 'loading', source: 'Loading the weather…', state: 'preset' });
  });

  test('the chain, link 1: the function answers with the archive and the reports', async ({ page }) => {
    const requested = await routeWeather(page, { fixtures: loadFixture(CITY, '2023-02-22') });
    await boot(page, CITY, { weather: false });
    await setClock(page, AT);
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky')).toHaveAttribute('data-weather', 'live');
    const c = await chip(page);
    expect(c.chip).toMatch(/^(Snow|Heavy snow|Fog) · 0\.\d+ mi · \d+ °F · /);
    expect(c.source).toMatch(/^History · Wed 22 Feb 2023 · KSLC report \d+:\d\d (AM|PM) · reanalysis · Weather data by Open-Meteo\.com$/);
    expect(requested.filter((u) => u.includes('/api/weather'))[0]).toMatch(/\/api\/weather\?city=slc&month=2023-02$/);
    expect(requested.some((u) => /open-meteo\.com/.test(u))).toBe(false); // the browser asked only the function
    await page.evaluate(() => window.__skyline.env.update());
    expect(await page.evaluate(() => window.__skyline.env.state.weather.precip.kind)).toBe('snow');
  });

  test('the chain, link 2: no function (as under vite preview): Open-Meteo from the browser, no reports', async ({ page }) => {
    const requested = await routeWeather(page, { fixtures: loadFixture(CITY, '2023-02-22'), api: 404, direct: 'ok' });
    await boot(page, CITY, { weather: false });
    await setClock(page, AT);
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky')).toHaveAttribute('data-weather', 'live');
    expect((await chip(page)).source).toMatch(/^History · Wed 22 Feb 2023 · reanalysis · reports unavailable · Weather data by Open-Meteo\.com$/);
    expect(requested.some((u) => u.startsWith('https://archive-api.open-meteo.com/v1/archive?'))).toBe(true);
    expect(await page.evaluate(() => window.__skyline.weather.status(window.__skyline.clock.timeMs).via)).toBe('open-meteo');
  });

  test('the chain, link 3: function and Open-Meteo both down: the preset', async ({ page }) => {
    await routeWeather(page, { api: 503, direct: 'abort' });
    await boot(page, CITY, { weather: false });
    await setClock(page, AT);
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky')).toHaveAttribute('data-weather', 'unavailable');
    expect((await chip(page)).chip).toMatch(/^Clear · /);
  });

  test('scrubbing across midnight UTC, and across a month\'s end, loads ahead and never jumps', async ({ page }) => {
    const requested = await routeWeather(page, { upstream: syntheticUpstream() });
    await boot(page, CITY, { weather: false });
    await page.evaluate(() => window.__skyline.loadWeather());
    await page.waitForFunction(() => window.__skyline.weather);
    // a minute at a time from 22:00 UTC on 30 July 2025 to 02:00 on 1 August, through the state the app reads
    const run = await page.evaluate(async () => {
      const s = window.__skyline;
      s.env.enterClock();
      const out = [];
      const start = Date.UTC(2025, 6, 30, 22), end = Date.UTC(2025, 7, 1, 2);
      s.clock.set(start);
      s.env.update();
      await new Promise((r) => { const wait = () => (s.weather.status(s.clock.timeMs).loading ? setTimeout(wait, 20) : r()); wait(); });
      for (let t = start; t <= end; t += 60000) {
        s.clock.set(t);
        s.env.update();
        const w = s.env.state.weather;
        out.push([t, w.tempC, w.source.surface]);
        await new Promise((r) => setTimeout(r, 0)); // let a fetch ahead start and land, as frames would
      }
      return out;
    });
    expect(run.length).toBe(28 * 60 + 1);
    expect(run.filter(([, , src]) => src !== 'model')).toEqual([]); // never the preset: no wait at midnight or 1 August
    let worst = 0;
    for (let i = 1; i < run.length; i++) worst = Math.max(worst, Math.abs(run[i][1] - run[i - 1][1]));
    expect(worst).toBeLessThan(0.05); // an 8-degree daily swing changes under 0.04 degrees a minute
    // (entering the clock state first asked for the live window at the clock's own time)
    const months = requested.filter((u) => u.includes('/api/weather') && u.includes('month=')).map((u) => new URL(u).searchParams.get('month'));
    expect(months).toEqual(['2025-07', '2025-08']);
  });
});

// Plan 03, section 4.10 and F1.4: a link opens Fly on its moment, seat and look, paused, and reproduces the same
// picture after a reload; the address the mode writes is such a link.
import { test, expect } from '@playwright/test';
import { openFlight, diffShots, frames, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const settledShot = async (page) => {
  await page.evaluate(() => window.__skyline.flight.whenSettled());
  await frames(page, 3);
  return page.screenshot();
};

test('a link opens on its moment and look, paused, and the picture is the same after a reload', async ({ page }) => {
  const link = 'city=lv&mode=flight&flight=synthetic-19&at=420&seat=22F&yaw=-10&pitch=-8&lens=35';
  await openFlight(page, link);
  await page.waitForFunction(() => window.__skyline.flight.active(), null, { timeout: 180_000 });
  const s = await page.evaluate(async () => { await window.__skyline.flight.whenSettled(); return window.__skyline.flight.state(); });
  expect(s.id).toBe('synthetic-19');
  expect(s.t).toBeCloseTo(420, 1);
  expect(s.playing).toBe(false);
  expect(s.seat).toBe('22F');
  expect(s.look).toMatchObject({ yaw: -10, pitch: -8, lens: 35 });
  const a = await settledShot(page);
  const written = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
  expect(written).toMatchObject({ city: 'lv', mode: 'flight', flight: 'synthetic-19', at: '420', seat: '22F', yaw: '-10', pitch: '-8', lens: '35' });

  await page.reload();
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && window.__skyline.flight.active(), null, { timeout: 180_000 });
  await page.evaluate(async () => { const s = window.__skyline; await s.attractions.ready; s.attractions.freeze(47); });
  const b = await settledShot(page);
  const d = await diffShots(page, a, b);
  await test.info().attach('link-first.png', { body: a, contentType: 'image/png' });
  await test.info().attach('link-reloaded.png', { body: b, contentType: 'image/png' });
  console.log('link reload', JSON.stringify(d));
  expect(d.share, 'share of pixels that changed after a reload').toBeLessThan(0.01);
});

test('the address written while flying is a link to the same view', async ({ page, browser }) => {
  await openFlight(page, 'city=lv');
  await page.evaluate(async () => {
    const f = window.__skyline.flight;
    await f.start('synthetic-19', { at: 250 });
    f.pause();
    f.look({ yaw: 25, pitch: -15, lens: 50 });
    await f.seek({ at: 333.3 });
  });
  await page.waitForFunction(() => new URLSearchParams(location.search).get('at') === '333.3', null, { timeout: 10_000 });
  const query = await page.evaluate(() => location.search.slice(1));
  const p = Object.fromEntries(new URLSearchParams(query));
  expect(p).toMatchObject({ mode: 'flight', flight: 'synthetic-19', at: '333.3', yaw: '25', pitch: '-15', lens: '50' });
  const there = await page.evaluate(() => window.__skyline.flight.state());

  const other = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await openFlight(other, query);
  await other.waitForFunction(() => window.__skyline.flight.active(), null, { timeout: 180_000 });
  const again = await other.evaluate(async () => { await window.__skyline.flight.whenSettled(); return window.__skyline.flight.state(); });
  for (const k of ['t', 'x', 'y', 'z']) expect(again[k]).toBeCloseTo(there[k], 3);
  expect(again.look).toMatchObject({ yaw: 25, pitch: -15, lens: 50 });
  await other.close();

  // leaving takes the flight's keys out of the address
  await page.evaluate(() => window.__skyline.flight.exit());
  const left = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
  for (const k of ['mode', 'flight', 'at', 'seat', 'yaw', 'pitch', 'lens']) expect(left[k]).toBeUndefined();
});

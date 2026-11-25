// Plan 03, section 4.3 and F3.6: the seat map from the flight's bar. Choose a seat ahead of, over and behind the wing on
// each side, and a seat whose window place is a blank wall; each time the view changes, the address carries the seat,
// and a reload of that address comes back to the same seat.
import { test, expect } from '@playwright/test';
import { openFlight, diffShots, frames, watchConsole, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

/** On the synthetic arrival's downwind, wings level, the Strip off the right side. */
const AT = 300;

const seatOf = (page) => page.evaluate(() => window.__skyline.flight.state().seat);
const addressSeat = (page) => page.evaluate(() => new URLSearchParams(location.search).get('seat'));
const settled = (page) => page.evaluate(() => window.__skyline.flight.whenSettled());

test('the seat map changes the seat: ahead of, over and behind the wing on both sides, and a blank wall', async ({ page }) => {
  const problems = watchConsole(page);
  await openFlight(page, 'city=lv');
  await page.evaluate(async (at) => { const f = window.__skyline.flight; await f.start('synthetic-19', { at, play: false }); }, AT);
  expect(await seatOf(page)).toBe('23F'); // the default (lopa.js defaultSeat: behind the wing on the Strip's side)

  const seatButton = page.locator('#flightbar .seat');
  await expect(seatButton).toContainText('23F');
  await seatButton.click();
  const map = page.locator('#seatmap');
  await expect(map).toBeVisible();
  await expect(seatButton).toHaveAttribute('aria-expanded', 'true');

  let before = await page.screenshot();
  const pick = async (how, want) => {
    if (how.startsWith('go:')) await map.locator(`[data-go="${how.slice(3)}"]`).click();
    else await map.locator(`[data-seat="${how}"]`).click();
    await settled(page);
    await frames(page, 4);
    expect(await seatOf(page)).toBe(want);
    expect(await addressSeat(page)).toBe(want);
    await expect(seatButton).toContainText(want);
    // the view out of the window, with the map out of the way for the picture
    await page.evaluate(() => { document.getElementById('seatmap').style.visibility = 'hidden'; });
    await frames(page, 2);
    const shot = await page.screenshot();
    await page.evaluate(() => { document.getElementById('seatmap').style.visibility = ''; });
    const d = await diffShots(page, before, shot);
    console.log(want, 'changed', JSON.stringify(d));
    await test.info().attach(`seat-${want}.png`, { body: shot, contentType: 'image/png' });
    expect(d.share, `the view from ${want} differs from the seat before`).toBeGreaterThan(0.05);
    before = shot;
  };
  // the shortcuts are on the Strip's side (the right on this flight); the left side by its seats
  await pick('go:ahead', '9F');
  await pick('go:over', '16F');
  await pick('go:behind', '23F');
  await pick('9A', '9A');
  await pick('16A', '16A');
  await pick('23A', '23A');
  await pick('11F', '11F'); // a window seat at a blank wall panel: the nearest windows are ahead and behind
  const blank = await page.evaluate(() => window.__skyline.flight.state());
  expect(blank.seat).toBe('11F');

  // Escape closes the map and leaves the seat
  await map.locator('[data-seat="11F"]').focus();
  await page.keyboard.press('Escape');
  await expect(map).toBeHidden();
  await expect(seatButton).toHaveAttribute('aria-expanded', 'false');
  expect(await seatOf(page)).toBe('11F');
  expect(await page.evaluate(() => window.__skyline.flight.active())).toBe(true);

  // the address is a link to that seat: a reload comes back to it
  await page.evaluate(() => window.__skyline.flight.pause());
  const link = await page.evaluate(() => location.search.slice(1));
  expect(new URLSearchParams(link).get('seat')).toBe('11F');
  await page.reload();
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && window.__skyline.flight.active() && window.__skyline.flight.state(), null, { timeout: 180_000 });
  await settled(page);
  expect(await seatOf(page)).toBe('11F');
  expect(problems).toEqual([]);
});

test('the setSeat hook changes the seat, and the shade hook closes the window\'s shade', async ({ page }) => {
  await openFlight(page, 'city=lv');
  await page.evaluate(async (at) => { await window.__skyline.flight.start('synthetic-19', { at, play: false }); }, AT);
  expect(await page.evaluate(() => window.__skyline.flight.setSeat('16A'))).toBe('16A');
  expect(await addressSeat(page)).toBe('16A');
  await expect(page.locator('#flightbar .seat')).toContainText('16A');
  // the shade slides while the clock plays; asked for, the target is set at once
  const shade = await page.evaluate(async () => {
    const f = window.__skyline.flight;
    f.shade(0.5);
    f.play();
    await new Promise((r) => setTimeout(r, 1500));
    f.pause();
    return f.stats().shade;
  });
  expect(shade).toBeCloseTo(0.5, 2);
});

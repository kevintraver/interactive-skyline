// Plan 03, F1.4 (section 4.1): Fly is a mode of the running app. Enter, play, scrub both ways, pause, leave: the map
// is exactly as it was, by the camera's matrices and the map's state, and by a screenshot taken before and after in
// the same run. Run on both backends of the new renderer.
import { test, expect } from '@playwright/test';
import { openFlight, mapAtRest, mapState, stateDiff, diffShots, frames, watchConsole, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

for (const backend of ['webgpu', 'webgl2']) {
  test(`${backend}: enter, play, scrub both ways, pause, leave, and the map is as it was`, async ({ page }) => {
    const problems = watchConsole(page);
    await openFlight(page, `city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`); // the address says webgl
    expect(await page.evaluate(() => window.__skyline.perf.gpu().backend)).toBe(backend);
    await page.evaluate(() => window.__skyline.setView('aerial'));
    await mapAtRest(page);

    // Fly is offered, beside Map and Drive, and the hooks list the flight
    await expect(page.locator('#modes button[data-mode="flight"]')).toBeVisible();
    const list = await page.evaluate(() => window.__skyline.flight.list());
    expect(list.map((f) => f.id)).toEqual(['synthetic-19']);

    const before = await mapState(page);
    const shotBefore = await page.screenshot();

    // enter by the button: the picker shows under #top; then play its first way (the condensed pace)
    await page.locator('#modes button[data-mode="flight"]').click();
    await expect(page.locator('#modes button[data-mode="flight"]')).toHaveAttribute('aria-pressed', 'true');
    const card = page.locator('.flight-card[data-flight="synthetic-19"]'); // the Orbit entry is first in the list
    await expect(card).toBeVisible();
    await expect(card).toContainText('Runway 19R, from the east');
    await card.locator('button[data-play="pace"]').click();
    await page.waitForFunction(() => window.__skyline.flight.active() && window.__skyline.flight.state()?.playing, null, { timeout: 180_000 });
    await expect(page.locator('#transport')).toBeVisible();
    await expect(page.locator('#transport .marks span')).toHaveCount(4);
    await expect(page.locator('#flightbar .status')).toContainText(/to landing/);

    // the condensed pace runs the clock fast early in the flight
    const early = await page.evaluate(() => window.__skyline.flight.state());
    expect(early.pace).toBe(true);
    expect(early.rate).toBeGreaterThan(4);
    await frames(page, 30);
    const later = await page.evaluate(() => window.__skyline.flight.state());
    expect(later.t).toBeGreaterThan(early.t);

    // scrub forward and back on the transport: the aircraft is a function of the position, both ways
    const at = async (t) => page.evaluate(async (s) => { await window.__skyline.flight.seek({ at: s }); return window.__skyline.flight.state(); }, t);
    await page.evaluate(() => window.__skyline.flight.pause());
    const a1 = await at(500);
    const a2 = await at(120);
    const a3 = await at(500);
    expect(a1.t).toBeCloseTo(500, 3);
    expect(a2.t).toBeCloseTo(120, 3);
    expect(a3.x).toBeCloseTo(a1.x, 6);
    expect(a3.y).toBeCloseTo(a1.y, 6);
    expect(a3.z).toBeCloseTo(a1.z, 6);
    expect(a2.altMsl).toBeGreaterThan(a1.altMsl);
    expect(a1.playing).toBe(false);

    // a camera through the window, not the map's
    const flying = await page.evaluate(() => [...window.__skyline.camera.matrixWorld.elements]);
    expect(flying).not.toEqual(before.world);

    // leave by the Map button
    await page.locator('#modes button[data-mode="map"]').click();
    await page.waitForFunction(() => !window.__skyline.flight.active(), null, { timeout: 30_000 });
    await mapAtRest(page);
    const after = await mapState(page);
    // the camera's matrices and everything else, to 1e-9 of their size (the map's damping still settles in the last bit)
    expect(stateDiff(after, before)).toEqual([]);
    const shotAfter = await page.screenshot();
    const d = await diffShots(page, shotBefore, shotAfter);
    await test.info().attach(`${backend}-map-before.png`, { body: shotBefore, contentType: 'image/png' });
    await test.info().attach(`${backend}-map-after.png`, { body: shotAfter, contentType: 'image/png' });
    console.log(backend, 'map before and after Fly', JSON.stringify(d));
    expect(d.share, 'share of pixels that changed').toBeLessThan(0.001);
    expect(problems).toEqual([]);
  });
}

test('the first-visit hint speaks of Fly while flying, and of the map again after', async ({ page }) => {
  await openFlight(page, 'city=lv');
  await page.evaluate(() => { document.getElementById('hint').hidden = false; });
  const bold = page.locator('#hint b'), line = page.locator('#hint span');
  await expect(bold).toBeVisible();
  const mapLine = await line.textContent();
  await page.evaluate(() => window.__skyline.flight.start('synthetic-19', { at: 300, play: false }));
  await expect(bold).toBeHidden();
  await expect(line).toContainText('Click a building through the window');
  await page.evaluate(() => window.__skyline.flight.exit());
  await expect(bold).toBeVisible();
  await expect(line).toHaveText(mapLine);
});

test('mode exclusivity: Map, Drive and Fly are one switch, and Esc never leaves the mode', async ({ page }) => {
  await openFlight(page, 'city=lv');
  await page.evaluate(() => window.__skyline.flight.start('synthetic-19', { at: 300 }));
  expect(await page.evaluate(() => window.__skyline.flight.active())).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__skyline.flight.active())).toBe(true);
  const pressed = () => page.evaluate(() => [...document.querySelectorAll('#modes button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.mode));
  expect(await pressed()).toEqual(['flight']);
  await page.evaluate(() => window.__skyline.flight.exit());
  expect(await pressed()).toEqual(['map']);
  expect(await page.evaluate(() => window.__skyline.flight.active())).toBe(false);
});

// Plan 03, F1.6 (section 4.8): what-if from the air. Hide the Sphere on the map, fly, and pass a Strip without it;
// undo works in flight; a building is selected through the window (a click, not a look-drag: the 5-pixel rule) and
// hidden with Delete; dragging a selected building moves it and holds the clock for the drag; the card's "Zoom to"
// is "Look at"; what was hidden and moved stays so across entering and leaving.
import { test, expect } from '@playwright/test';
import { openFlight, frames, diffShots, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const SPHERE = 'w976405284';
/** Just past abeam the Sphere on the synthetic final (about 2 km before the 19R threshold, 1.5 km to the right). At
 * 504 s, abeam, the wing hides it from the default seat 22F; from 507 to 516 s it is clear of the wing, behind the window. */
const ABEAM = 510;

const hidden = (page) => page.evaluate(() => window.__skyline.hiddenIds());

test('hide the Sphere on the map, fly past the Strip without it, and undo it from the air', async ({ page }) => {
  await openFlight(page, 'city=lv');
  // hidden on the map, with the card
  await page.evaluate((id) => window.__skyline.select(id), SPHERE);
  await page.locator('#card [data-act="hide"]').click();
  expect(await hidden(page)).toContain(SPHERE);

  await page.evaluate(async (at) => { const f = window.__skyline.flight; await f.start('synthetic-19', { at }); f.pause(); }, ABEAM);
  expect(await hidden(page)).toContain(SPHERE);
  // turn to where it stood: the head can see that side
  const look = await page.evaluate((id) => window.__skyline.flight.lookAtBuilding(id), SPHERE);
  expect(look.inView).toBe(true);
  await page.evaluate(() => window.__skyline.flight.whenSettled());
  expect(await page.evaluate((id) => window.__skyline.flight.visible(id), SPHERE)).toBe(false);
  // the picture only: the dock (the toast of the last edit, the "1 hidden" pill) is not part of it
  const quiet = () => page.evaluate(() => { document.getElementById('dock').style.visibility = 'hidden'; });
  await quiet();
  const without = await page.screenshot();

  // undo (Ctrl+Z) from the air brings it back where the window shows it
  await page.keyboard.press('Control+z');
  expect(await hidden(page)).not.toContain(SPHERE);
  expect(await page.evaluate((id) => window.__skyline.flight.visible(id), SPHERE)).toBe(true);
  await page.evaluate(() => window.__skyline.flight.whenSettled());
  await quiet();
  const withIt = await page.screenshot();
  await test.info().attach('sphere-hidden.png', { body: without, contentType: 'image/png' });
  await test.info().attach('sphere-shown.png', { body: withIt, contentType: 'image/png' });
  await page.evaluate(() => { document.getElementById('dock').style.visibility = ''; });
  const at = await page.evaluate((id) => window.__skyline.screen(id), SPHERE);
  // the two pictures differ where the Sphere stands, and only around it
  const near = { x: Math.round(at.x) - 80, y: Math.round(at.y) - 80, width: 160, height: 160 };
  const dAll = await diffShots(page, without, withIt);
  expect(dAll.share, 'something changed where the Sphere stands').toBeGreaterThan(0.0005);
  const farAway = await page.evaluate(async ({ a, b, r }) => {
    const load = async (s) => { const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type: 'image/png' })); const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, bmp.width, bmp.height); };
    const [A, B] = await Promise.all([load(a), load(b)]);
    let inside = 0, outside = 0;
    for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      if (d <= 8) continue;
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) inside++; else outside++;
    }
    return { inside, outside };
  }, { a: without.toString('base64'), b: withIt.toString('base64'), r: near });
  console.log('Sphere hidden and shown', JSON.stringify({ at, dAll, farAway }));
  expect(farAway.inside).toBeGreaterThan(20);
  expect(farAway.outside).toBeLessThan(farAway.inside);
});

test('select through the window with a click, not a look-drag; Delete hides it; Look at on the card', async ({ page }) => {
  await openFlight(page, 'city=lv');
  await page.evaluate(async (at) => { const f = window.__skyline.flight; await f.start('synthetic-19', { at }); f.pause(); f.lookAtBuilding('w976405284'); await f.whenSettled(); }, ABEAM);
  const at = await page.evaluate((id) => window.__skyline.screen(id), SPHERE);
  expect(at.x).toBeGreaterThan(0);
  expect(at.x).toBeLessThan(1280);

  // a drag of 40 px turns the head and selects nothing
  const lookBefore = await page.evaluate(() => window.__skyline.flight.state().look);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 20, at.y, { steps: 4 });
  await page.mouse.move(at.x + 40, at.y, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.__skyline.selectedId())).toBeFalsy();
  const lookAfter = await page.evaluate(() => window.__skyline.flight.state().look);
  expect(lookAfter.yaw).not.toBeCloseTo(lookBefore.yaw, 1);

  // back to the building, and a click (3 px of wobble) selects it
  await page.evaluate(async () => { const f = window.__skyline.flight; f.lookAtBuilding('w976405284'); await f.whenSettled(); });
  const at2 = await page.evaluate((id) => window.__skyline.screen(id), SPHERE);
  await page.mouse.move(at2.x, at2.y);
  await page.mouse.down();
  await page.mouse.move(at2.x + 3, at2.y + 1);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__skyline.selectedId())).toBe(SPHERE);
  await expect(page.locator('#card')).toBeVisible();
  await expect(page.locator('#card [data-act="center"]')).toHaveText('Look at');

  // Look at on the card turns the head to it
  await page.evaluate(() => window.__skyline.flight.look({ yaw: -40 }));
  await page.locator('#card [data-act="center"]').click();
  const turned = await page.evaluate(() => window.__skyline.flight.state().look);
  expect(turned.yaw).toBeGreaterThan(-30);

  // Delete hides it, from the air
  await page.keyboard.press('Delete');
  expect(await hidden(page)).toContain(SPHERE);

  // and it stays hidden on leaving; the card's button is the map's again
  await page.evaluate(() => window.__skyline.flight.exit());
  expect(await hidden(page)).toContain(SPHERE);
  await page.evaluate((id) => window.__skyline.select(id), 'w205501268');
  await expect(page.locator('#card [data-act="center"]')).toHaveText('Zoom to');
});

test('dragging a selected building moves it and holds the clock for the length of the drag', async ({ page }) => {
  await openFlight(page, 'city=lv');
  await page.evaluate(async (at) => {
    const f = window.__skyline.flight;
    await f.start('synthetic-19', { at, pace: false, rate: 1 });
    f.pause();
    f.lookAtBuilding('w976405284');
    await f.whenSettled();
    window.__skyline.select('w976405284');
  }, ABEAM - 2);
  // the clock plays from here: read where the Sphere is in the same call, so the press lands on it
  const at = await page.evaluate((id) => { window.__skyline.flight.play(); return window.__skyline.screen(id); }, SPHERE);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  expect(await page.evaluate(() => document.getElementById('scene').classList.contains('grabbing')), 'the press grabbed the Sphere').toBe(true);
  await page.mouse.move(at.x + 10, at.y + 4, { steps: 3 });
  const during = await page.evaluate(() => window.__skyline.flight.state());
  expect(during.playing).toBe(false);
  await frames(page, 10);
  const still = await page.evaluate(() => window.__skyline.flight.state());
  expect(still.t).toBe(during.t);
  await page.mouse.move(at.x + 30, at.y + 10, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__skyline.flight.state());
  expect(after.playing).toBe(true);
  expect(await page.evaluate(() => window.__skyline.movedIds())).toContain(SPHERE);

  // moved stays moved on leaving, and the next flight starts with it moved
  await page.evaluate(() => window.__skyline.flight.exit());
  expect(await page.evaluate(() => window.__skyline.movedIds())).toContain(SPHERE);
  await page.evaluate(() => window.__skyline.flight.start('synthetic-19', { at: 400 }));
  expect(await page.evaluate(() => window.__skyline.movedIds())).toContain(SPHERE);
});

// Real pointer and keyboard input on the interface. The golden screenshots and the hooks contract go through
// window.__skyline, so they cannot see a listener that was lost or wired to the wrong element; this spec can.
// Written to check the phase 0 split of main.js, and kept for every later phase that touches the interface.
import { test, expect } from '@playwright/test';
import { boot } from '../helpers/app.js';

const CITY = 'slc'; // the lighter city: a software-rendered frame of Las Vegas takes seconds
const hiddenIds = (page) => page.evaluate(() => window.__skyline.hiddenIds());
const movedIds = (page) => page.evaluate(() => window.__skyline.movedIds());
const selectedId = (page) => page.evaluate(() => window.__skyline.selectedId());
const settled = (page) => page.waitForFunction(() => !window.__skyline.flying());

/**
 * A tower that a click really lands on: its screen point is clear of the controls and nothing stands in front.
 * Leaves it selected and returns { id, name, x, y }.
 */
async function clickableTower(page) {
  const candidates = await page.evaluate(() => {
    const s = window.__skyline;
    return s.tall.map((e) => ({ id: e.data.id, name: e.data.name || 'Unnamed building', ...s.screen(e.data.id) }))
      .filter((c) => c.x > 420 && c.x < 1160 && c.y > 90 && c.y < 660);
  });
  for (const c of candidates.slice(0, 20)) {
    await page.evaluate(() => window.__skyline.select(null));
    await page.mouse.click(c.x, c.y);
    if (await selectedId(page) === c.id) return c;
  }
  throw new Error(`no tower could be selected by a click (tried ${Math.min(candidates.length, 20)} of ${candidates.length})`);
}

test.describe('the interface answers real input', () => {
  // software rendering: a frame takes a second or more, and most steps here wait for one
  test.describe.configure({ timeout: 300_000 });
  test.beforeEach(async ({ page }) => { await boot(page, CITY); });

  test('search, the card, hide and the undo toast', async ({ page }) => {
    const first = await page.evaluate(() => {
      const e = window.__skyline.tall[0];
      return { id: e.data.id, name: e.data.name || 'Unnamed building', count: window.__skyline.tall.length };
    });
    await page.locator('#search').click();
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#list li')).toHaveCount(first.count);

    await page.locator('#search').fill(first.name);
    const shown = page.locator('#list li:not([hidden])');
    expect(await shown.count()).toBeGreaterThan(0);
    for (const name of await shown.locator('.name').allTextContents()) expect(name.toLowerCase()).toContain(first.name.toLowerCase());

    await page.locator('#search').fill('no building is called this');
    await expect(page.locator('#empty')).toBeVisible();

    await page.locator('#search').fill(first.name);
    await page.locator('#search').press('Enter');
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.locator('#card h2')).toHaveText(first.name);
    expect(await selectedId(page)).toBe(first.id);
    await settled(page);

    await page.locator('#card [data-act="hide"]').click();
    expect(await hiddenIds(page)).toEqual([first.id]);
    await expect(page.locator('#card')).toBeHidden();
    await expect(page.locator('#toast span')).toHaveText(/^Hidden: /);
    await expect(page.locator('#changes span')).toHaveText('1 hidden');

    await page.locator('#toast button').click();
    expect(await hiddenIds(page)).toEqual([]);
    await expect(page.locator('#changes')).toBeHidden();
  });

  test('the list hides and shows towers, and Reset puts everything back', async ({ page }) => {
    const count = await page.evaluate(() => window.__skyline.tall.length);
    await page.locator('#search').click();
    await page.locator('#list li .act').first().click();
    expect(await hiddenIds(page)).toHaveLength(1);
    await expect(page.locator('#list li').first()).toHaveClass(/off/);

    await page.locator('#toggle-all').click(); // "Show all" while one is hidden
    expect(await hiddenIds(page)).toHaveLength(0);
    await page.locator('#toggle-all').click(); // then "Hide all"
    expect(await hiddenIds(page)).toHaveLength(count);
    await expect(page.locator('#changes span')).toHaveText(`${count} hidden`);

    await page.locator('#reset-all').click();
    expect(await hiddenIds(page)).toHaveLength(0);
    await expect(page.locator('#changes')).toBeHidden();
  });

  test('keyboard: Delete, undo, Escape and the search shortcut', async ({ page }) => {
    const id = await page.evaluate(() => {
      const s = window.__skyline, target = s.tall[0].data.id;
      s.select(target);
      return target;
    });
    await page.keyboard.press('Delete');
    expect(await hiddenIds(page)).toEqual([id]);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await hiddenIds(page)).toEqual([]);

    await page.evaluate((target) => window.__skyline.select(target), id);
    await page.keyboard.press('Escape');
    expect(await selectedId(page)).toBeNull();

    await page.keyboard.press('/');
    await expect(page.locator('#search')).toBeFocused();
    await expect(page.locator('#results')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#results')).toBeHidden();
  });

  test('on the map: click selects, right-click opens the menu, a drag moves the tower', async ({ page }) => {
    const tower = await clickableTower(page);
    await expect(page.locator('#card h2')).toHaveText(tower.name);

    // away and back to the same point: a neighbour can be a couple of pixels off
    await page.mouse.move(tower.x + 60, tower.y + 60);
    await page.mouse.move(tower.x, tower.y);
    await expect(page.locator('#tip')).toBeVisible();
    await expect(page.locator('#tip b')).toHaveText(tower.name);

    await page.mouse.click(tower.x, tower.y, { button: 'right' });
    await expect(page.locator('#menu')).toBeVisible();
    await expect(page.locator('#menu .head b')).toHaveText(tower.name);
    await expect(page.locator('#menu button').first()).toHaveText('Hide');
    await expect(page.locator('#menu button', { hasText: 'Zoom to' })).toBeVisible();
    await page.locator('#menu button').first().click();
    await expect(page.locator('#menu')).toBeHidden();
    expect(await hiddenIds(page)).toEqual([tower.id]);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await hiddenIds(page)).toEqual([]);

    // select it again with a click, then drag it across the ground
    await page.mouse.click(tower.x, tower.y);
    expect(await selectedId(page)).toBe(tower.id);
    await page.mouse.move(tower.x, tower.y);
    await page.mouse.down();
    await page.mouse.move(tower.x + 70, tower.y + 24, { steps: 8 });
    await page.mouse.up();
    expect(await movedIds(page)).toEqual([tower.id]);
    await expect(page.locator('#toast span')).toHaveText(/^Moved: /);
    await expect(page.locator('#changes span')).toHaveText('1 moved');
    await expect(page.locator('#card .how')).toHaveText('Moved from where it really stands.');

    await page.locator('#card [data-act="back"]').click();
    expect(await movedIds(page)).toEqual([]);
  });

  const setting = (page, key) => page.evaluate((k) => window.__skyline.settings[k], key);

  test('the tools: day and night', async ({ page }) => {
    await page.locator('#night').click();
    expect(await setting(page, 'night')).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#night')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#night').click();
    expect(await setting(page, 'night')).toBe(false);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('the tools: map options', async ({ page }) => {
    await page.locator('#options-toggle').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#options-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#settings input[name="highlight"]').uncheck();
    expect(await setting(page, 'highlight')).toBe(false);
    await page.locator('#settings .seg label', { hasText: 'Meters' }).click();
    expect(await setting(page, 'units')).toBe('m');
    await expect(page.locator('#cutoff-out')).toHaveText(/^35 m · /);
    await page.locator('#settings-reset').click();
    expect(await setting(page, 'units')).toBe('ft');
    expect(await setting(page, 'highlight')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings')).toBeHidden();
  });

  test('the tools: time of day (phase 1): #sky-toggle, the scrubber, a quick jump, T, N, Escape, one popover at a time', async ({ page }) => {
    const clock = () => page.evaluate(() => ({ mode: window.__skyline.env.mode, live: window.__skyline.clock.live, t: window.__skyline.clock.timeMs }));
    await page.locator('#sky-toggle').click();
    await expect(page.locator('#sky')).toBeVisible();
    await expect(page.locator('#sky-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect((await clock()).mode).toBe('pinned'); // opening it changes nothing
    // the scrubber, by keyboard: one step is one minute, and it enters the clock state
    await page.locator('#sky-scrub').focus();
    const t0 = (await clock()).t;
    await page.keyboard.press('ArrowRight');
    const c1 = await clock();
    expect(c1.mode).toBe('clock');
    expect(Math.abs(c1.t - t0 - 60000)).toBeLessThan(60000);
    // and by pointer: a click near the left end is shortly after midnight
    const box = await page.locator('#sky-scrub').boundingBox();
    await page.mouse.click(box.x + 9, box.y + box.height / 2);
    expect(await page.evaluate(() => window.__skyline.clock.local().hour)).toBe(0);
    // a quick jump
    await page.locator('#sky .seg label', { hasText: 'Sunrise' }).click();
    const rise = await page.evaluate(() => { const s = window.__skyline; return Math.abs(s.clock.timeMs - s.env.ephemeris.events(s.clock.timeMs - s.clock.local().hour * 3600000 - s.clock.local().minute * 60000 - s.clock.local().second * 1000 - (s.clock.timeMs % 1000)).sunrise); });
    expect(rise).toBeLessThan(1000);
    // one popover at a time
    await page.locator('#options-toggle').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#sky')).toBeHidden();
    // T opens #sky (closing #settings), Escape closes it
    await page.locator('#scene').click({ position: { x: 640, y: 120 } });
    await page.locator('#options-toggle').click();
    await page.keyboard.press('t');
    await expect(page.locator('#sky')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#sky')).toBeHidden();
    // N: the live sky
    await page.keyboard.press('n');
    expect(await clock()).toMatchObject({ mode: 'clock', live: true });
    // and #night returns to a pinned look
    await page.locator('#night').click();
    expect((await clock()).mode).toBe('pinned');
  });

  test('the tools: the city menu, viewpoints and zoom', async ({ page }) => {
    await page.locator('#city').click();
    await expect(page.locator('#city-menu')).toBeVisible();
    await expect(page.locator('#city-menu a')).toHaveCount(2);
    await expect(page.locator('#city-menu a[aria-current="page"]')).toHaveAttribute('href', `?city=${CITY}`);
    await expect(page.locator('#city-menu a[href="?city=lv"]')).toBeVisible();
    await page.mouse.click(640, 400); // a press outside closes it
    await expect(page.locator('#city-menu')).toBeHidden();

    const buttons = page.locator('.views button');
    await expect(buttons.first()).toHaveClass(/active/);
    await buttons.nth(1).click();
    await expect(buttons.nth(1)).toHaveClass(/active/);
    await expect(buttons.first()).not.toHaveClass(/active/);

    const distance = () => page.evaluate(() => {
      const s = window.__skyline;
      return s.camera.position.distanceTo(s.controls.target);
    });
    const before = await distance();
    await page.locator('#zoom-in').click();
    await settled(page);
    expect(await distance()).toBeCloseTo(Math.max(before * 0.6, await page.evaluate(() => window.__skyline.controls.minDistance)), 0);
  });
});

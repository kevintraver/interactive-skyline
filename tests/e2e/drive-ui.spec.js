// Drive mode's controls on real data (route i15n): the route card's start chips, the route bar's thumb,
// rate and keys, the hold-position lock with the time-of-day popover, the address round trip, Map and
// back, and the phone layout. One test and two page loads, because a SwiftShader load takes over half a
// minute (the city has several routes; the steps use i15n's card, the current one); everything is asserted on state (the pose, the DOM, the address), never on pixels.
import { test, expect } from '@playwright/test';
import { openCity, watchConsole, DRIVE_TIMEOUT } from '../helpers/drive.js';

test.describe.configure({ timeout: DRIVE_TIMEOUT });

const run = (page, fn, arg) => page.evaluate(fn, arg);
const pose = (page) => run(page, () => window.__skyline.drive.pose());
/** Wait until the road for the current pose is in and drawn, then return the pose. */
const settled = (page) => run(page, async () => { await window.__skyline.drive.whenSettled(); return window.__skyline.drive.pose(); });
/** Wait for the clock to start (entering and the start chips play once the road is in), then pause. */
const untilPlayingThenPause = (page) => run(page, async () => {
  const d = window.__skyline.drive;
  while (!d.active() || !d.pose() || !d.pose().playing) await new Promise((r) => requestAnimationFrame(r));
  d.pause();
  return d.pose();
});
const params = (page) => run(page, () => Object.fromEntries(new URLSearchParams(location.search)));
const blur = (page) => run(page, () => document.activeElement && document.activeElement.blur());

test('lv drive controls: starts, route bar, rate, lock, time of day, address, phone', async ({ page }) => {
  const problems = watchConsole(page);
  await openCity(page, 'lv');
  await page.getByRole('button', { name: 'Drive', exact: true }).click();
  await untilPlayingThenPause(page);
  const route = await run(page, () => window.__skyline.drive.route());

  await test.step('the hint says how to drive, and the card shows the route', async () => {
    expect(await page.locator('#hint span').textContent()).toBe('Drag to look around. Scroll to zoom. Space to pause.');
    const card = page.locator('.route-card.current');
    await expect(card).toBeVisible();
    await expect(card.locator('.facts')).toHaveText('42.5 mi · 38 min at the limits');
    await expect(card.locator('.map path.line')).toHaveCount(1);
    await expect(page.locator('.views')).toBeHidden();
  });

  await test.step('each start chip puts the car at its start', async () => {
    for (const [key, name] of [['start', 'From the start'], ['city', 'Through the city'], ['reveal', 'Before the view opens']]) {
      await page.getByRole('button', { name, exact: true }).click();
      const p = await untilPlayingThenPause(page);
      expect(p.s, key).toBeGreaterThanOrEqual(route.starts[key] - 0.5);
      expect(p.s, key).toBeLessThan(route.starts[key] + 300);
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
  });

  await test.step('dragging the thumb moves the car, and the clock with it', async () => {
    const before = await pose(page);
    const box = await page.locator('#drivebar .track').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.25, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, y, { steps: 3 });
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 3 });
    await page.mouse.up();
    const p = await settled(page);
    expect(Math.abs(p.s - route.s1 * 0.5)).toBeLessThan(route.s1 * 0.02);
    expect(p.t).toBeLessThan(before.t); // back along the road is earlier on the journey
    expect(Math.abs(Number((await params(page)).s) - p.s)).toBeLessThan(1);
  });

  await test.step('arrow keys on the focused thumb move the car; Space does not play there', async () => {
    const thumb = page.getByRole('slider', { name: 'Place on the route' });
    await thumb.focus();
    const a = await pose(page);
    await page.keyboard.press('ArrowRight');
    const b = await pose(page);
    expect(b.s - a.s).toBeCloseTo(1000, 3);
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await pose(page)).s - b.s).toBeCloseTo(-5000, 3);
    await page.keyboard.press(' ');
    expect((await pose(page)).playing).toBe(false);
    await expect(thumb).toHaveAttribute('aria-valuetext', /^\d+\.\d of 42\.5 mi, /);
    await blur(page);
  });

  await test.step('the rate steps through 0.25x to 16x by button and by key', async () => {
    const faster = page.getByRole('button', { name: 'Faster' }), slower = page.getByRole('button', { name: 'Slower' });
    await faster.click();
    await faster.click();
    expect((await pose(page)).rate).toBe(4);
    await blur(page);
    await page.keyboard.press(',');
    expect((await pose(page)).rate).toBe(2);
    await page.keyboard.press('.');
    await page.keyboard.press('.');
    await page.keyboard.press('.');
    await page.keyboard.press('.');
    expect((await pose(page)).rate).toBe(16);
    await expect(faster).toBeDisabled();
    await expect(page.locator('#drivebar .rate output')).toHaveText('16×');
    for (let i = 0; i < 6; i++) await slower.click();
    expect((await pose(page)).rate).toBe(0.25);
    await expect(slower).toBeDisabled();
    await faster.click();
    await faster.click();
    expect((await pose(page)).rate).toBe(1);
    await blur(page);
  });

  await test.step('unlocked, changing the time drives the car along', async () => {
    await run(page, () => window.__skyline.drive.seek({ s: 10000 }));
    const a = await pose(page);
    await page.keyboard.press('ArrowRight');
    const b = await pose(page);
    expect(b.t - a.t).toBe(10_000);
    expect(b.s - a.s).toBeGreaterThan(300); // 70 mph for 10 s is 313 m
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await pose(page)).t - b.t).toBe(-60_000);
    // the popover's slider, unlocked: half an hour later is some 50 km further along
    await page.locator('#drivebar .time').click();
    await expect(page.locator('#drive-time')).toBeVisible();
    const c = await pose(page);
    await run(page, () => {
      const r = document.querySelector('#drive-time input[type=range]');
      r.value = String(Math.min(1439, Number(r.value) + 30));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect((await pose(page)).s).toBeGreaterThan(c.s + 10000);
    await page.keyboard.press('Escape');
    await expect(page.locator('#drive-time')).toBeHidden();
    await expect(page.locator('#drivebar .time')).toHaveAttribute('aria-expanded', 'false');
  });

  await test.step('locked, the time of day changes around the car: noon is day, 3 a.m. is night', async () => {
    await run(page, () => window.__skyline.drive.seek({ s: 30000 }));
    const lock = page.getByRole('button', { name: 'Hold position' });
    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#drivebar .time').click();
    const a = await pose(page);
    await page.getByRole('button', { name: 'Noon', exact: true }).click();
    const noon = await settled(page);
    expect(noon.s).toBeCloseTo(a.s, 3);
    expect(noon.night).toBe(false);
    expect(await run(page, () => document.documentElement.dataset.theme)).toBe('light');
    await page.getByRole('button', { name: 'Night', exact: true }).click();
    const night = await settled(page);
    expect(night.s).toBeCloseTo(a.s, 3);
    expect(night.night).toBe(true);
    expect(await run(page, () => document.documentElement.dataset.theme)).toBe('dark');
    // the slider obeys the lock
    await run(page, () => {
      const r = document.querySelector('#drive-time input[type=range]');
      r.value = String(Number(r.value) + 120);
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const later = await pose(page);
    expect(later.t - night.t).toBeCloseTo(120 * 60_000, -4);
    expect(later.s).toBeCloseTo(a.s, 3);
    await page.getByRole('button', { name: 'Dusk', exact: true }).click();
    expect((await pose(page)).s).toBeCloseTo(a.s, 3);
    // a press outside closes the popover (on the card's text: a press on the scene might pick a building)
    await page.locator('.route-card.current .what b').click();
    await expect(page.locator('#drive-time')).toBeHidden();
    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'false');
  });

  let address;
  const moment = { s: 33333, t: Date.parse('2026-11-22T03:04:05Z'), yaw: 21.5, pitch: 4.5, lens: 85 };
  await test.step('the address carries place, time and look; Map and back resumes there', async () => {
    await run(page, (m) => {
      const d = window.__skyline.drive;
      d.seek({ s: m.s, t: m.t });
      d.look({ yaw: m.yaw, pitch: m.pitch, lens: m.lens });
      d.pause();
    }, moment);
    await settled(page);
    const q = await params(page);
    expect(q).toMatchObject({ city: 'lv', mode: 'drive', route: 'i15n', s: '33333', t: '2026-11-22T03:04:05Z', view: 'clean', yaw: '21.5', pitch: '4.5', lens: '85' });
    address = await run(page, () => location.href);

    await page.getByRole('button', { name: 'Map', exact: true }).click();
    expect(await params(page)).toEqual({ city: 'lv' });
    await expect(page.locator('.route-card.current')).toBeHidden();
    expect(await page.locator('#hint span').textContent()).toBe('Drag to move the map. Scroll to zoom. Right-drag to rotate.');
    await page.getByRole('button', { name: 'Drive', exact: true }).click();
    await run(page, async () => {
      const d = window.__skyline.drive;
      while (!d.active() || document.getElementById('drivebar').classList.contains('busy')) await new Promise((r) => requestAnimationFrame(r));
    });
    const back = await settled(page);
    expect(back.playing).toBe(false);
    expect(back.s).toBeCloseTo(moment.s, 3);
    expect(back.t).toBe(moment.t);
    expect([back.yaw, back.pitch, back.lens]).toEqual([moment.yaw, moment.pitch, moment.lens]);
  });

  await test.step('at 390 x 844 everything fits, nothing overlaps, targets are 40 px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await run(page, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.locator('.route-card.current .more').click();
    const layout = await run(page, () => {
      const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const rect = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
      const all = [...document.querySelectorAll('#top > *, .route-card, .route-card button, #tools > *, #drivebar, #drivebar button, #drivebar .thumb, #credit, #hint')].filter(vis);
      const outside = all.filter((e) => { const r = rect(e); return r.l < 0 || r.t < 0 || r.r > innerWidth || r.b > innerHeight; }).map((e) => e.outerHTML.slice(0, 80));
      const small = [...document.querySelectorAll('#drivebar button, .route-card button')].filter(vis)
        .filter((e) => { const r = rect(e); return r.w < 40 || r.h < 40; }).map((e) => e.outerHTML.slice(0, 80));
      const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
      const bar = rect(document.getElementById('drivebar'));
      const overlaps = ['#tools', '#credit', '.routes'].filter((sel) => hit(bar, rect(document.querySelector(sel))));
      const card = rect(document.querySelector('.routes'));
      if (hit(card, rect(document.getElementById('tools')))) overlaps.push('card/tools');
      return { outside, small, overlaps, scroll: document.scrollingElement.scrollWidth, width: innerWidth };
    });
    expect(layout.outside).toEqual([]);
    expect(layout.small).toEqual([]);
    expect(layout.overlaps).toEqual([]);
    expect(layout.scroll).toBeLessThanOrEqual(layout.width);
    await page.locator('.route-card.current .more').click();
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await test.step('a link opens on the same place, time, look and lens, paused', async () => {
    await page.goto(address);
    await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 120_000 });
    await run(page, async () => {
      const d = window.__skyline.drive;
      while (!d.active() || !d.pose() || document.getElementById('drivebar').classList.contains('busy')) await new Promise((r) => requestAnimationFrame(r));
    });
    const p = await settled(page);
    expect(p.playing).toBe(false);
    expect(p.s).toBeCloseTo(moment.s, 0);
    expect(p.t).toBe(moment.t);
    expect([p.yaw, p.pitch, p.lens]).toEqual([moment.yaw, moment.pitch, moment.lens]);
    expect(await params(page)).toMatchObject({ s: '33333', t: '2026-11-22T03:04:05Z', yaw: '21.5', pitch: '4.5', lens: '85' });
  });

  expect(problems).toEqual([]);
});

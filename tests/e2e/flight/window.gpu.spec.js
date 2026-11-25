// Plan 03, F3.9 and Phase 5 in the app, on this machine's GPU: the cabin is drawn by its own stage after the world
// (src/flight/view/cabinStage.js), not by the scene pass; the clean view draws no cabin; the window's glass with every
// effect off is the plain view; and the window panel (F5.7) works from the keyboard, with F pulling focus.
import { test, expect } from '@playwright/test';
import { openFlight, diffShots, frames, watchConsole, pictureCheck, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

/** On the synthetic arrival's downwind, wings level, the Strip off the right side. */
const AT = 300;
const settled = (page) => page.evaluate(() => window.__skyline.flight.whenSettled());

test('the cabin is composed by its own stage: not in the scene, covering the wall, gone in the clean view and on leaving', async ({ page }) => {
  const problems = watchConsole(page);
  await openFlight(page, 'city=lv');
  await page.evaluate(async (at) => { await window.__skyline.flight.start('synthetic-19', { at, play: false }); }, AT);
  await settled(page);
  const r = await page.evaluate(async () => {
    const s = window.__skyline, f = s.flight;
    let cabinInScene = false;
    s.scene.traverse((o) => { if (o.name === 'cabin' || o.name === 'cabin-model') cabinInScene = true; });
    const wall = await f.luminance({ x: -0.9, y: 0 });
    const stats = f.stats();
    return { cabinInScene, cameraCabinLayer: s.camera.layers.isEnabled(11), wall, stage: stats.cabinStage };
  });
  expect(r.cabinInScene).toBe(false);
  expect(r.cameraCabinLayer).toBe(false);
  expect(r.stage.staged).toBe(true);
  expect(r.stage.shown).toBe(true);
  expect(r.wall.cabinAlpha).toBeGreaterThan(0.99); // the wall beside the window is the cabin's
  expect((await pictureCheck(page)).blank).toBe(false);

  // the clean view (frame off): no cabin anywhere
  const clean = await page.evaluate(async () => {
    const f = window.__skyline.flight;
    f.options({ frame: false });
    await f.whenSettled();
    return { wall: await f.luminance({ x: -0.9, y: 0 }), stage: f.stats().cabinStage };
  });
  expect(clean.stage.shown).toBe(false);
  expect(clean.wall.cabinAlpha).toBe(0);

  // leaving: the stage is removed
  await page.evaluate(async () => { const f = window.__skyline.flight; f.options({ frame: true }); await f.exit(); });
  const after = await page.evaluate(() => window.__skyline.flight.stats());
  expect(after.cabinStage.staged).toBe(false);
  expect(problems).toEqual([]);
});

test('every effect off, the glass is the plain view within one grey level', async ({ page }) => {
  await openFlight(page, 'city=lv');
  await page.evaluate(async (at) => {
    const f = window.__skyline.flight;
    await f.start('synthetic-19', { at, play: false });
    f.options({ hud: false });
    await f.whenSettled();
    const canvas = document.querySelector('canvas');
    for (const el of document.body.children) if (!el.contains(canvas)) el.style.visibility = 'hidden';
  }, AT);
  const shot = async (o) => {
    await page.evaluate(async (o) => { const f = window.__skyline.flight; f.window(o); await f.whenSettled(); }, o);
    await frames(page, 3);
    return page.screenshot();
  };
  const plain = await shot({ glass: false });
  const off = await shot({ glass: true, frost: false, rain: false, scratches: false, reflections: false, effects: { transmission: false }, override: { frost: 0, fog: 0, wet: 0, mist: 0 } });
  const on = await shot({ glass: true, frost: true, rain: true, scratches: true, reflections: true, effects: { transmission: true }, override: null });
  const d = await diffShots(page, off, plain, { tol: 1 });
  console.log('every effect off against no glass', JSON.stringify(d));
  expect(d.share).toBe(0);
  // and the glass does something when on (transmission alone darkens the view)
  expect((await diffShots(page, on, plain, { tol: 1 })).share).toBeGreaterThan(0.05);
});

test('the window panel: opened from the bar, switches by keyboard, Escape gives focus back; F pulls focus', async ({ page }) => {
  const problems = watchConsole(page);
  await openFlight(page, 'city=lv');
  await page.evaluate(async (at) => { await window.__skyline.flight.start('synthetic-19', { at, play: false }); }, AT);
  await settled(page);
  const button = page.locator('#flightbar .window');
  await button.click();
  const panel = page.locator('#flightwindow');
  await expect(panel).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  // the first switch (Glass) has focus; Tab to Frost and mist, Space turns it off
  await expect(panel.locator('input[data-switch="glass"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.locator('input[data-switch="frost"]')).toBeFocused();
  await page.keyboard.press('Space');
  let st = await page.evaluate(() => window.__skyline.flight.window({}));
  expect(st.frost).toBe(false);
  expect(st.pane.effects.frost).toBe(false);
  expect(st.pane.effects.condensation).toBe(false);
  // Glass off disables the others
  await panel.locator('input[data-switch="glass"]').check();
  await panel.locator('input[data-switch="glass"]').uncheck();
  await expect(panel.locator('input[data-switch="rain"]')).toBeDisabled();
  st = await page.evaluate(() => window.__skyline.flight.window({}));
  expect(st.pane.enabled).toBe(false);
  await panel.locator('input[data-switch="glass"]').check();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  // F: focus on the glass, again: far; it moves while paused
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__skyline.flight.window({}).pane.focus === 'pane');
  await settled(page);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__skyline.flight.window({}).pane.focus === 'far');
  expect(problems).toEqual([]);
});

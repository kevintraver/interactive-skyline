// Plan 03, section 4.2 and F2.6: "About this flight" in the running app, on the baked flights. Opened from a card in
// the picker and from the flight's bar; the dusk flight's waived gate shows as waived with its reason; the 737-900's
// card says it is not the 737-800 that is drawn; Escape closes it and gives focus back to what opened it; Tab stays
// inside it; it fits a phone's width. The corner label names the flight tracks' licence while flying and its dialog
// credits every source. Nothing that identifies an aircraft or its operator (callsign, registration, ICAO address,
// operator), as the raw extracts record them, appears in the panel or in any served flight file (assumption A2).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openFlight, realFlights, watchConsole, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVED = path.join(ROOT, 'public/data/lv/flights');
const RAW = path.join(ROOT, 'data/flights/lv/raw');

/** What identifies each recorded aircraft, from the raw extracts (kept in the repository, never served). */
function identifiers() {
  const out = new Set();
  for (const name of fs.readdirSync(RAW).filter((n) => n.endsWith('.trace.json.gz'))) {
    const docs = [JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, name))).toString('utf8'))].flat();
    for (const d of docs) {
      for (const k of ['icao', 'r', 'ownOp']) if (d[k]) out.add(String(d[k]).trim());
      for (const p of d.trace || []) {
        const flight = p?.[8]?.flight?.trim();
        if (flight) out.add(flight);
      }
    }
  }
  return [...out].filter((s) => s.length >= 4);
}

const hasFlights = () => realFlights().some((f) => f.id === 'lv-19-dusk') && realFlights().some((f) => f.id === 'lv-19-day');
const inPanel = (page) => page.evaluate(() => !!document.activeElement?.closest('#flightabout'));

test('nothing that identifies an aircraft or its operator is in any served flight file', () => {
  test.skip(!fs.existsSync(RAW), 'no raw extracts');
  const ids = identifiers();
  expect(ids.length).toBeGreaterThanOrEqual(6 * 3); // an address, a registration and a callsign for each flight
  for (const name of fs.readdirSync(SERVED)) {
    const text = fs.readFileSync(path.join(SERVED, name)).toString('latin1').toLowerCase();
    for (const id of ids) expect(text.includes(id.toLowerCase()), `${name} contains ${id}`).toBe(false);
  }
});

test('About this flight: from a card and from the bar, the waived gate, the type note, Escape, focus, a phone, the credits', async ({ page }) => {
  test.skip(!hasFlights(), 'the baked flights are not there');
  const problems = watchConsole(page);
  await openFlight(page, 'city=lv', { real: true });
  const ids = identifiers();
  const panel = page.locator('#flightabout');

  // into Fly by its button: the picker opens with a card per flight
  await page.locator('#modes button[data-mode="flight"]').click();
  const dusk = page.locator('.flight-card[data-flight="lv-19-dusk"]');
  await expect(dusk).toBeVisible();

  // from the dusk flight's card: the panel, focus inside it, the waived gate shown as waived with its reason
  const duskAbout = dusk.locator('button[data-about]');
  await duskAbout.click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'dialog');
  await expect(panel.locator('.sub')).toHaveText('Runway 19R, from the east');
  await expect(panel.locator('tr[data-gate]')).toHaveCount(15);
  const waived = panel.locator('tr[data-gate="heightRmsLast60sM"]');
  await expect(waived).toHaveClass(/waived/);
  await expect(waived).toContainText('Waived');
  await expect(waived).toContainText('3.62 m');
  await expect(waived).toContainText('at most 3 m');
  await expect(panel.locator('tr.reason')).toContainText('noise floor of altitudes reported in 25 ft steps');
  await expect(panel.locator('.qa-summary')).toHaveText('14 of 15 checks passed; 1 waived.');
  await expect(panel).toContainText('This flight was a 737 MAX 8. The aircraft drawn is a 737-800');
  await expect(panel).toContainText('RNAV (RNP) Z RWY 19R');
  await expect(panel.locator('a[href="https://www.adsb.lol/"]').first()).toBeVisible();
  await expect(panel).toContainText('made available under the Open Database License (ODbL) 1.0');
  expect(await inPanel(page)).toBe(true);
  // Tab and Shift+Tab stay inside it
  for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); expect(await inPanel(page), `Tab ${i + 1}`).toBe(true); }
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Tab'); expect(await inPanel(page), `Shift+Tab ${i + 1}`).toBe(true); }
  // Escape closes it, gives focus back to the card's button, and leaves the picker open
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(duskAbout).toBeFocused();
  await expect(page.locator('.flight-list')).toBeVisible();

  // the 737-900's card says so; the 737-800's says nothing about the type
  await page.locator('.flight-card[data-flight="lv-19-day"] button[data-about]').click();
  await expect(panel.locator('.sub')).toHaveText('Runway 19R, from the north-east');
  await expect(panel.locator('.type-note')).toContainText('This flight was a 737-900. The aircraft drawn is a 737-800');
  await expect(panel.locator('tr.waived')).toHaveCount(0);
  await page.locator('.flight-card[data-flight="lv-19-night"] button[data-about]').click();
  await expect(panel.locator('.sub')).toHaveText('Runway 19R, from the east');
  await expect(panel.locator('.type-note')).toHaveCount(0);

  // nothing identifying in what the panel says, for any flight
  for (const f of realFlights()) {
    await page.locator(`.flight-card[data-flight="${f.id}"] button[data-about]`).click();
    await expect(panel.locator('tr[data-gate]').first()).toBeVisible();
    const text = (await panel.innerText()).toLowerCase();
    for (const id of ids) expect(text.includes(id.toLowerCase()), `About ${f.id} contains ${id}`).toBe(false);
  }
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // fly the dusk flight's final; the bar's About opens the same panel on it, Escape gives focus back to the button
  await dusk.locator('button[data-play="final"]').click();
  await page.waitForFunction(() => window.__skyline.flight.active() && window.__skyline.flight.state()?.id === 'lv-19-dusk', null, { timeout: 300_000 });
  const barAbout = page.locator('#flightbar button.about');
  await expect(barAbout).toBeVisible();
  await barAbout.click();
  await expect(panel).toBeVisible();
  await expect(barAbout).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('tr[data-gate="heightRmsLast60sM"]')).toContainText('Waived');
  await expect(panel).toContainText('Weather as flown');
  await expect(panel).toContainText('Wind from 160° at 10 kt, gusting 21 kt');
  expect(await inPanel(page)).toBe(true);
  const playing = await page.evaluate(() => window.__skyline.flight.state().playing);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(barAbout).toHaveAttribute('aria-expanded', 'false');
  await expect(barAbout).toBeFocused();
  expect(await page.evaluate(() => window.__skyline.flight.state().playing)).toBe(playing);
  expect(await page.evaluate(() => window.__skyline.flight.active())).toBe(true); // Escape closed the panel, not Fly

  // the corner label names the flight tracks' licence while flying; its dialog credits every source on screen
  const corner = page.locator('#credit button[data-credits]');
  await expect(corner).toContainText('flight tracks adsb.lol (ODbL)');
  await corner.click();
  const credits = page.locator('#credits');
  await expect(credits).toBeVisible();
  for (const who of ['adsb.lol', 'OpenStreetMap contributors', 'Federal Aviation Administration', 'U.S. Geological Survey', 'NASA', 'EOxCloudless', 'Open-Meteo', 'Iowa Environmental Mesonet']) {
    await expect(credits, who).toContainText(who);
  }
  await page.keyboard.press('Escape');
  await expect(credits).toBeHidden();

  // at a phone's width it fits, and the page does not scroll sideways
  await page.setViewportSize({ width: 390, height: 844 });
  await barAbout.click();
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await panel.locator('.x').click();
  await expect(panel).toBeHidden();

  expect(problems).toEqual([]);
});

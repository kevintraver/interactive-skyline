// Drive mode on real data: I-15 north from Primm (route i15n). Each test shares one page, because a
// SwiftShader load takes over half a minute and a drive frame several seconds; see helpers.js for how
// frames are made deterministic. Goldens are the canvas only. The default moment (moment.js) changes its
// clock time from day to day, but the canvas depends only on the look it picks, which it keeps.
import { test, expect } from '@playwright/test';
import { openCity, captureCanvas, FROZEN_AT, GOLDEN } from './helpers.js';

const ROUTE = 'i15n';
const STRAT = 'w135457469';
const SPHERE = 'w976405284';
const MPH70 = 70 * 0.44704; // 31.29 m/s

// a drive frame under the software renderer is slow; a test here waits for several dozen
test.describe.configure({ timeout: 900_000 });

/**
 * Fail the test on any console error or warning, and on uncaught errors. SwiftShader's own performance
 * notes ("GL Driver Message ... GPU stall due to ReadPixels", from the viewpoint snapshots and the canvas
 * captures) are the driver talking, not the app, and the map logs them too.
 */
function watchConsole(page) {
  const problems = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/GL Driver Message/.test(m.text())) problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  return problems;
}

/** Open the app at an address, the way openCity does for a plain city. */
async function openAt(page, query) {
  await page.addInitScript(() => {
    try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* defaults apply */ }
  });
  await page.routeWebSocket(/.*/, () => {});
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0
    && window.__skyline && window.__skyline.attractions && window.__skyline.drive, null, { timeout: 120_000 });
  await page.evaluate(async (at) => {
    const s = window.__skyline;
    s.attractions.freeze(at);
    await s.attractions.ready;
    s.attractions.freeze(at);
  }, FROZEN_AT);
}

const drive = (page, fn, arg) => page.evaluate(fn, arg);
/** Seek, wait until the frame is settled and drawn, and return the pose. */
const seekSettled = (page, at) => drive(page, async (a) => {
  const d = window.__skyline.drive;
  d.seek(a);
  await d.whenSettled();
  return d.pose();
}, at);

test('lv drive: motion, seeking, the reveal and the per-frame budget', async ({ page }) => {
  const problems = watchConsole(page);
  await openCity(page, 'lv');
  const route = await drive(page, async (id) => {
    const d = window.__skyline.drive;
    await d.start(id, { s: 5000 });
    d.pause();
    return d.route();
  }, ROUTE);
  expect(route.id).toBe(ROUTE);

  await test.step('at 70 mph the car covers 31.29 m/s', async () => {
    const { a, b } = await drive(page, () => {
      const d = window.__skyline.drive;
      d.seek({ s: 10000 });
      const a = d.pose();
      d.seek({ t: a.t + 10_000 });
      return { a, b: d.pose() };
    });
    expect(a.mph).toBeCloseTo(70, 6);
    expect((b.s - a.s) / 10).toBeGreaterThan(MPH70 * 0.99);
    expect((b.s - a.s) / 10).toBeLessThan(MPH70 * 1.01);
  });

  await test.step('seeking away and back gives the same pose', async () => {
    const [a, b] = await drive(page, () => {
      const d = window.__skyline.drive;
      d.seek({ s: 30000 });
      const a = d.pose();
      d.seek({ s: 50000 });
      d.seek({ s: 66000 });
      d.seek({ s: 30000 });
      return [a, d.pose()];
    });
    expect(b).toEqual(a);
  });

  await test.step('the same { s, t } reached two ways draws the same frame', async () => {
    const at = await seekSettled(page, { s: 2000 }).then(() => seekSettled(page, { s: 33000 }));
    const first = await captureCanvas(page);
    expect.soft(first).toMatchSnapshot('drive-km33.png', GOLDEN);
    await seekSettled(page, { s: 60000 });
    const again = await seekSettled(page, { s: 33000, t: at.t });
    expect(again.s).toBeCloseTo(at.s, 6);
    expect((await captureCanvas(page)).equals(first)).toBe(true);
  });

  await test.step('the Strat comes into view at the reveal', async () => {
    const r = await drive(page, (id) => window.__skyline.drive.route().reveal, ROUTE);
    expect(r.target).toBe(STRAT);
    const seen = async (s) => { await seekSettled(page, { s }); return drive(page, (id) => window.__skyline.drive.visible(id), STRAT); };
    expect(await seen(r.s - 1500)).toBe(false);
    expect(await seen(r.s + 1500)).toBe(true);
  });

  await test.step('the drive\'s own JavaScript stays within budget', async () => {
    const js = await drive(page, async (length) => {
      const d = window.__skyline.drive;
      d.stats(); // warm
      window.__skyline.driveTimings = null;
      const before = d.stats().js.total.count;
      for (let i = 0; i < 60; i++) {
        d.seek({ s: (i + 0.5) * (length / 60) });
        await d.whenSettled();
      }
      const st = d.stats();
      return { ...st.js, frames: st.js.total.count - before };
    }, route.s1);
    console.log('drive per-frame JS (ms):', JSON.stringify(js));
    expect(js.total.count).toBeGreaterThanOrEqual(60);
    expect(js.total.p95).toBeLessThan(4);
    expect(js.total.max).toBeLessThan(16);
  });

  expect(problems).toEqual([]);
});

test('lv drive: opened from an address, goldens, and hiding the Sphere', async ({ page }) => {
  const problems = watchConsole(page);
  await openAt(page, `city=lv&mode=drive&route=${ROUTE}&s=5000`);
  await drive(page, async () => {
    const d = window.__skyline.drive;
    // entering ends by starting the clock once the first frame is in; pause after that
    while (!d.active() || !d.pose() || !d.pose().playing) await new Promise((r) => requestAnimationFrame(r));
    d.pause();
  });
  expect(await page.evaluate(() => new URLSearchParams(location.search).get('mode'))).toBe('drive');

  // the look the default moment gives: day at km 5, night from km 33 on
  for (const [name, s, night] of [['km5', 5000, false], ['km33', 33000, true], ['reveal', 44200, true], ['km62', 62000, true]]) {
    await test.step(`golden ${name}`, async () => {
      const p = await seekSettled(page, { s });
      expect(p.night).toBe(night);
      expect.soft(await captureCanvas(page)).toMatchSnapshot(`drive-${name}.png`, GOLDEN);
    });
  }
  await test.step('golden km62 in the other look', async () => {
    const p = await seekSettled(page, { s: 62000, t: Date.parse('2026-11-21T21:00:00Z') });
    expect(p.night).toBe(false);
    expect.soft(await captureCanvas(page)).toMatchSnapshot('drive-km62-day.png', GOLDEN);
  });

  await test.step('a Sphere hidden on the map is gone from the drive, and back once restored', async () => {
    await drive(page, (id) => {
      const s = window.__skyline;
      s.drive.exit();
      s.select(id);
      document.querySelector('#card [data-act="hide"]').click();
    }, SPHERE);
    expect(await page.evaluate(() => window.__skyline.hiddenIds())).toEqual([SPHERE]);
    const look = await drive(page, async (id) => {
      const s = window.__skyline;
      await s.drive.start('i15n', { s: 63000 });
      s.drive.pause();
      // "Zoom to" turns the head towards the building while driving: east of the road, to the right
      s.focusOn(s.tall.find((e) => e.data.id === id));
      await s.drive.whenSettled();
      return { pose: s.drive.pose(), visible: s.drive.visible(id), flying: s.flying() };
    }, SPHERE);
    expect(look.flying).toBe(false);
    expect(look.pose.yaw).toBeLessThan(-60);
    expect(look.visible).toBe(false);
    const hidden = await captureCanvas(page);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('ControlOrMeta+z');
    expect(await page.evaluate(() => window.__skyline.hiddenIds())).toEqual([]);
    expect(await drive(page, async (id) => { await window.__skyline.drive.whenSettled(); return window.__skyline.drive.visible(id); }, SPHERE)).toBe(true);
    expect((await captureCanvas(page)).equals(hidden)).toBe(false);
  });

  expect(problems).toEqual([]);
});

test('lv drive: the mode switch, and leaving restores the map exactly', async ({ page }) => {
  const problems = watchConsole(page);
  await openCity(page, 'lv');
  const before = await page.evaluate(() => ({ stored: localStorage.getItem('slc-skyline-settings'), settings: { ...window.__skyline.settings } }));
  await page.getByRole('button', { name: 'Drive', exact: true }).click();
  await drive(page, async () => {
    const d = window.__skyline.drive;
    while (!d.active() || !d.pose() || !d.pose().playing) await new Promise((r) => requestAnimationFrame(r));
  });
  const inDrive = await page.evaluate(() => ({
    mode: new URLSearchParams(location.search).get('mode'), night: window.__skyline.drive.pose().night,
    theme: document.documentElement.dataset.theme, nightBtn: document.getElementById('night').hidden,
    views: document.querySelector('.views').hidden, transport: !document.getElementById('drivebar').hidden,
  }));
  // the default moment starts 70 s before the reveal, in civil twilight: the night look, a dark interface
  expect(inDrive).toEqual({ mode: 'drive', night: true, theme: 'dark', nightBtn: true, views: true, transport: true });
  await page.keyboard.press(' ');
  expect(await page.evaluate(() => window.__skyline.drive.pose().playing)).toBe(false);

  await page.getByRole('button', { name: 'Map', exact: true }).click();
  const after = await page.evaluate(() => ({
    stored: localStorage.getItem('slc-skyline-settings'), settings: { ...window.__skyline.settings },
    mode: new URLSearchParams(location.search).get('mode'), active: window.__skyline.drive.active(),
    theme: document.documentElement.dataset.theme,
  }));
  expect(after).toEqual({ ...before, mode: null, active: false, theme: 'light' });
  expect.soft(await captureCanvas(page)).toMatchSnapshot('lv-east-day.png', GOLDEN);
  expect(problems).toEqual([]);
});

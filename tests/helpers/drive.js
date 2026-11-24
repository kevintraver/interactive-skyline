// Driving Drive mode from Playwright (plan 02), on top of helpers/app.js. Everything goes through
// window.__skyline.drive (plan 02, section 5.12).
//
// Drive goldens are the WebGL canvas only, so DOM controls drawn over it never touch these pixels. They live with
// plan 01's under tests/reference/baseline/<platform>/ as drive-*.png, and like those are compared only where the
// running platform has them (see tests/README.md). They are provisional: later phases change the drive's picture.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { SHOW_TIME } from './app.js';

/** A drive frame under the software renderer takes seconds, and a drive test waits for several dozen. */
export const DRIVE_TIMEOUT = 900_000;
/** Canvas goldens: 0.2 % of pixels may differ. */
export const GOLDEN = { maxDiffPixelRatio: 0.002 };

const updating = () => ['all', 'changed'].includes(test.info().config.updateSnapshots);

/**
 * Fail the test on any console error or warning, and on uncaught errors. SwiftShader's own performance notes
 * ("GL Driver Message ... GPU stall due to ReadPixels", from the viewpoint tiles and the canvas captures) are the
 * driver talking, not the app, and the map logs them too.
 */
export function watchConsole(page) {
  const problems = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/GL Driver Message/.test(m.text())) problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  return problems;
}

/**
 * Open the app at an address (`city=lv`, `city=lv&mode=drive&...`) from a clean slate, with the first-visit hint
 * marked as seen, and wait until the city, its extras and the drive hooks are in, with the show clocks held.
 */
export async function openAt(page, query) {
  await page.addInitScript(() => {
    try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* defaults apply anyway */ }
  });
  // Drive runs on the classic renderer until its materials are ported to the new one (plan 02); the map specs of
  // plan 01 run on the new renderer through helpers/app.js
  await page.goto(`/?${/(^|&)renderer=/.test(query) ? query : `${query}&renderer=legacy`}`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0
    && document.getElementById('loading').classList.contains('done')
    && window.__skyline && window.__skyline.attractions && window.__skyline.drive, null, { timeout: 120_000 });
  await page.evaluate(async (at) => {
    const s = window.__skyline;
    // hold the clocks before the extras land, so the wheel is placed at the frozen angle from the start
    s.attractions.freeze(at);
    await s.attractions.ready;
    s.attractions.freeze(at);
  }, SHOW_TIME);
}
export const openCity = (page, city) => openAt(page, `city=${city}`);

/**
 * Let the scene settle, wait for the frame the last change asked for and return the WebGL canvas as PNG bytes.
 * With preserveDrawingBuffer the canvas keeps the last frame, so no extra render is forced (a SwiftShader frame of
 * lv takes seconds); three frames cover the one-frame lag of night-only extras.
 */
export async function captureCanvas(page) {
  const dataUrl = await page.evaluate(async () => {
    const s = window.__skyline;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    while (s.flying()) await frame();
    for (let i = 0; i < 3; i++) await frame();
    return document.getElementById('scene').toDataURL('image/png');
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/**
 * Compare canvas bytes with a golden, softly. Where the running platform has no golden for `name` and snapshots are
 * not being updated, nothing is compared and an annotation says so (as baseline.spec.js does).
 */
export function expectGolden(png, name) {
  if (!updating() && !fs.existsSync(test.info().snapshotPath(name))) {
    test.info().annotations.push({ type: 'skipped-golden', description: `no ${process.platform} golden for ${name}` });
    return;
  }
  expect.soft(png).toMatchSnapshot(name, GOLDEN);
}

/** In the page: keep the canvas's pixels under `key`, for pixelsDiffer(). */
export const keepPixels = (page, key) => page.evaluate(async (k) => {
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
  const c = document.getElementById('scene');
  const ctx = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height }).getContext('2d');
  ctx.drawImage(c, 0, 0);
  (window.__kept ||= {})[k] = ctx.getImageData(0, 0, c.width, c.height).data;
}, key);

/** In the page: the share of pixels that differ between two kept canvases (any channel off by more than 8). */
export const pixelsDiffer = (page, a, b) => page.evaluate(([ka, kb]) => {
  const x = window.__kept[ka], y = window.__kept[kb];
  if (x.length !== y.length) return 1;
  let n = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (Math.abs(x[i] - y[i]) > 8 || Math.abs(x[i + 1] - y[i + 1]) > 8 || Math.abs(x[i + 2] - y[i + 2]) > 8) n++;
  }
  return n / (x.length / 4);
}, [a, b]);

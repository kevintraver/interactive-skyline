// Driving Drive mode from Playwright (plan 02), on top of helpers/app.js. Everything goes through
// window.__skyline.drive (plan 02, section 5.12).
//
// Drive goldens are the canvas only, so DOM controls drawn over it never touch these pixels. They live with plan 01's
// under tests/reference/baseline/<platform>/ as drive-*.png, and like those are compared only on SwiftShader (a project
// with `metadata: { goldens: true }`, drive-software) and only where the running platform has them (see
// tests/README.md). On the GPU (drive-gpu) every spec runs the same steps and compares no picture.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { SHOW_TIME, WEATHER_URLS } from './app.js';

/** A drive frame under the software renderer takes seconds, and a drive test waits for several dozen. */
export const DRIVE_TIMEOUT = 900_000;
/** Canvas goldens: 0.2 % of pixels may differ. */
export const GOLDEN = { maxDiffPixelRatio: 0.002 };

const updating = () => ['all', 'changed'].includes(test.info().config.updateSnapshots);
const project = () => test.info().project;

/**
 * Fail the test on any console error or warning, and on uncaught errors. SwiftShader's own performance notes
 * ("GL Driver Message ... GPU stall due to ReadPixels", from the viewpoint tiles and the canvas captures) are the
 * driver talking, not the app, and the map logs them too. So is Chromium's "No available adapters." where the app looks
 * for WebGPU and finds none, and the browser's line for a weather request that
 * playwright.config.js made unresolvable (Drive enters plan 01's clock state, which asks for the weather; `vite preview`
 * has no /api, so the client tries the upstreams, whose hosts do not resolve in the test browser).
 */
export function watchConsole(page) {
  const problems = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (/GL Driver Message/.test(m.text())) return;
    // the browser's line when the app asks for a WebGPU adapter where there is none (SwiftShader: the app then takes WebGL2)
    if (m.type() === 'warning' && /^No available adapters\.$/.test(m.text())) return;
    if (/ERR_NAME_NOT_RESOLVED/.test(m.text()) && WEATHER_URLS.test(m.location()?.url || '')) return;
    problems.push(`[${m.type()}] ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ''}`);
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
  // The drive runs on plan 01's renderer. `renderer=webgpu` keeps the interim seam (?mode=drive, and the Drive button,
  // opened the classic renderer) from choosing the classic one; once the seam is gone the app ignores it.
  if (!/(^|&)renderer=/.test(query)) query = `${query}&renderer=webgpu`;
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0
    && document.getElementById('loading').classList.contains('done')
    && window.__skyline && window.__skyline.attractions && window.__skyline.drive, null, { timeout: 120_000 });
  await expectBackend(page, query);
  await page.evaluate(async (at) => {
    const s = window.__skyline;
    // hold the clocks before the extras land, so the wheel is placed at the frozen angle from the start
    s.attractions.freeze(at);
    await s.attractions.ready;
    s.attractions.freeze(at);
  }, SHOW_TIME);
}
export const openCity = (page, city) => openAt(page, `city=${city}`);

/** The backend the page runs on: { kind, backend ('webgpu' | 'webgl2' | 'webgl'), depth ('reversed' | 'logarithmic' | 'standard'), gl }. */
export const backendOf = (page) => page.evaluate(() => {
  const s = window.__skyline, r = s.renderer, { kind, backend } = s.rendererInfo;
  const gl = r.backend?.gl || (r.getContext ? r.getContext() : null);
  const info = gl && gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    kind, backend, depth: r.reversedDepthBuffer ? 'reversed' : r.logarithmicDepthBuffer ? 'logarithmic' : 'standard',
    gl: info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null,
  };
});

/**
 * A project may say which backend it is for (`metadata: { backend }` in playwright.config.js); an address may name one. A GPU project that got
 * a software renderer would pass while testing the wrong thing: on macOS a browser started from a sandboxed process
 * (an agent's shell, for one) gets no GPU and falls back to SwiftShader without a word.
 */
export async function expectBackend(page, query = '') {
  // an address that names its backend (drive-depth.spec.js asks for ?backend=webgl on every project) gets that one
  const asked = /(?:^|&)backend=(webgl|webgpu)\b/.exec(query);
  const want = asked ? (asked[1] === 'webgl' ? 'webgl2' : 'webgpu') : project().metadata?.backend;
  if (!want) return;
  const got = await backendOf(page);
  test.info().annotations.push({ type: 'backend', description: JSON.stringify(got) });
  expect(got.kind, 'plan 01\'s renderer').toBe('webgpu');
  expect(got.backend, `project ${project().name} is for the ${want} backend (got ${JSON.stringify(got)}; a sandboxed browser has no GPU)`).toBe(want);
}

/**
 * Let the scene settle, wait for the frame the last change asked for and return the canvas as PNG bytes. Plan 01's
 * renderer keeps no drawing buffer (neither backend has preserveDrawingBuffer), so the frame is drawn once more and
 * read in the task that drew it (window.__skyline.capture, src/render/capture.js); three frames before cover the
 * one-frame lag of night-only extras.
 */
export async function captureCanvas(page) {
  const dataUrl = await page.evaluate(async () => {
    const s = window.__skyline;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    while (s.flying()) await frame();
    for (let i = 0; i < 3; i++) await frame();
    const blob = await s.capture('image/png');
    return new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/** In the page: the current frame's RGBA pixels, drawn once more and read as captureCanvas() does. Defined on window as __pixels. */
const PIXELS = `window.__pixels = async () => {
  const blob = await window.__skyline.capture('image/png');
  const bmp = await createImageBitmap(blob);
  const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height).data;
};`;
/** Make window.__pixels() available in the page (idempotent). */
export const definePixels = (page) => page.evaluate(PIXELS);

/**
 * Compare canvas bytes with a golden, softly, in a project that compares goldens (drive-software). Where the running
 * platform has no golden for `name` and snapshots are not being updated, nothing is compared and an annotation says so
 * (as baseline.spec.js does).
 */
export function expectGolden(png, name) {
  if (!project().metadata?.goldens) {
    test.info().annotations.push({ type: 'skipped-golden', description: `${name}: goldens are compared on SwiftShader only` });
    return;
  }
  if (!updating() && !fs.existsSync(test.info().snapshotPath(name))) {
    test.info().annotations.push({ type: 'skipped-golden', description: `no ${process.platform} golden for ${name}` });
    return;
  }
  expect.soft(png).toMatchSnapshot(name, GOLDEN);
}

/** In the page: keep the frame's pixels under `key`, for pixelsDiffer(). */
export const keepPixels = async (page, key) => {
  await definePixels(page);
  await page.evaluate(async (k) => {
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    (window.__kept ||= {})[k] = await window.__pixels();
  }, key);
};

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

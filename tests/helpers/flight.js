// Driving Fly mode from Playwright (plan 03), on the new renderer. Everything goes through window.__skyline.flight
// (plan 03, section 5.5).
//
// The specs must not depend on another agent's unfinished data: by default /data/lv/flights/ is served from the
// synthetic fixture (tests/fixtures/flight/synthetic-19.*, the last ten minutes of a runway 19R arrival) through
// page.route. A spec that wants the baked flight passes { real: true } and skips when the file is not there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOW_TIME } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/flight');
/** The baked flight of phase 1 (another agent's work; may not exist yet). */
export const REAL_FLIGHT = path.join(ROOT, 'public/data/lv/flights/lv-19-day.json');
export const hasRealFlight = () => fs.existsSync(REAL_FLIGHT) && fs.existsSync(REAL_FLIGHT.replace(/\.json$/, '.bin'));

/** A flight on the GPU still takes a while under load; the first one builds the wide ground. */
export const FLIGHT_TIMEOUT = 600_000;

/** The index entry scripts/bake_flight.py would write for the synthetic fixture. */
export function syntheticIndex() {
  const header = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'synthetic-19.json'), 'utf8'));
  const td = new Date(header.touchdown);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(td);
  const part = (t) => local.find((p) => p.type === t).value;
  return {
    format: 'skyline-flight-index/1',
    flights: [{
      id: header.id, runway: header.runway, aircraftType: header.aircraftType,
      date: `${part('year')}-${part('month')}-${part('day')}`, localTime: `${part('hour')}:${part('minute')}`, touchdown: header.touchdown,
      duration: header.samples * header.dt, samples: header.samples, start: 0, badges: header.badges,
      header: `${header.id}.json`, data: `${header.id}.bin`, preview: null,
    }],
    attribution: 'synthetic: tests/helpers/flightTrack.js',
  };
}

/** Serve /data/lv/flights/ from the synthetic fixture. */
export async function routeSynthetic(page) {
  await page.route('**/data/lv/flights/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'index.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticIndex()) });
    const file = path.join(FIXTURES, name);
    if (!/^synthetic-19\.(json|bin)$/.test(name) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ contentType: name.endsWith('.json') ? 'application/json' : 'application/octet-stream', body: fs.readFileSync(file) });
  });
}

/**
 * Open the app on the new renderer at an address (`city=lv`, `city=lv&mode=flight&...`), with the first-visit hint
 * marked as seen, the extras' show clocks held, and the flight hooks in. { real: true } leaves /data/lv/flights/ to
 * the server (the baked files); otherwise the synthetic fixture answers.
 */
export async function openFlight(page, query = 'city=lv', { real = false } = {}) {
  if (!real) await routeSynthetic(page);
  await page.addInitScript(() => {
    try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* defaults apply anyway */ }
  });
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0
    && document.getElementById('loading').classList.contains('done')
    && window.__skyline && window.__skyline.attractions && window.__skyline.flight, null, { timeout: 180_000 });
  await page.evaluate(async (at) => {
    const s = window.__skyline;
    s.attractions.freeze(at);
    await s.attractions.ready;
    s.attractions.freeze(at);
    await s.flight.ready;
  }, SHOW_TIME);
}

/** Wait for `n` animation frames. */
export const frames = (page, n = 3) => page.evaluate((k) => new Promise((done) => {
  const step = () => (k-- <= 0 ? done() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

/** Wait until the map is at rest: the fade from Fly over, no glide, the exposure settled, the loop idle. */
export async function mapAtRest(page) {
  await page.waitForFunction(() => {
    const s = window.__skyline, fade = document.getElementById('fly-fade');
    return (!fade || fade.hidden) && !s.flying() && (!s.look || s.look.exposure.state.settled);
  }, null, { timeout: 120_000 });
  await page.evaluate(() => window.__skyline.loop.settle());
  await frames(page, 4);
}

/** Everything about the map that leaving Fly must give back exactly. */
export function mapState(page) {
  return page.evaluate(() => {
    const s = window.__skyline;
    const c = s.camera;
    c.updateMatrixWorld(true);
    return {
      world: [...c.matrixWorld.elements], projection: [...c.projectionMatrix.elements], fov: c.fov, near: c.near, far: c.far,
      zoom: c.zoom, view: c.view ? { ...c.view } : null, layers: c.layers.mask,
      target: s.controls.target.toArray(), controlsEnabled: s.controls.enabled,
      env: s.env.mode, clock: { timeMs: s.clock.timeMs, rate: s.clock.rate, playing: s.clock.playing, live: s.clock.live },
      hidden: s.hiddenIds(), moved: s.movedIds(), selected: s.selectedId() ?? null, journey: !!s.timeline.active,
      transportHidden: document.getElementById('transport').hidden,
      modes: [...document.querySelectorAll('#modes button')].map((b) => [b.dataset.mode, b.getAttribute('aria-pressed')]),
      domeScale: s.scene.children.find((o) => o.geometry && o.geometry.type === 'SphereGeometry' && o.material.side === 1)?.scale.x ?? null,
      fog: s.scene.fog ? s.scene.fog.density : null,
      search: new URLSearchParams(location.search).toString(),
    };
  });
}

/**
 * Where two mapState()s differ: paths whose numbers differ by more than `rel` of their size (float noise in the last
 * place is the map's own damping settling, not a change), or whose other values are not equal. Empty when the same.
 */
export function stateDiff(a, b, rel = 1e-9, at = '') {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b)) ? [] : [`${at}: ${b} -> ${a}`];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => stateDiff(a[k], b[k], rel, `${at}.${k}`));
  }
  return a === b ? [] : [`${at}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`];
}

/**
 * Two page screenshots compared in the page: the share of pixels whose largest channel difference exceeds `tol` (of
 * 255), and the mean absolute difference. No image library in Node here.
 */
export function diffShots(page, a, b, { tol = 8 } = {}) {
  return page.evaluate(async ({ a64, b64, tol }) => {
    const load = async (s) => {
      const bytes = Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      return { w: bmp.width, h: bmp.height, px: g.getImageData(0, 0, bmp.width, bmp.height).data };
    };
    const [A, B] = await Promise.all([load(a64), load(b64)]);
    if (A.w !== B.w || A.h !== B.h) return { share: 1, mad: 1, size: [A.w, A.h, B.w, B.h] };
    let off = 0, sum = 0;
    for (let i = 0; i < A.px.length; i += 4) {
      const d = Math.max(Math.abs(A.px[i] - B.px[i]), Math.abs(A.px[i + 1] - B.px[i + 1]), Math.abs(A.px[i + 2] - B.px[i + 2]));
      if (d > tol) off++;
      sum += d;
    }
    const n = A.px.length / 4;
    return { share: off / n, mad: sum / n / 255 };
  }, { a64: a.toString('base64'), b64: b.toString('base64'), tol });
}

/** Fail on console errors and warnings (WebGPU's own adapter notes aside, and the weather hosts playwright.config.js makes unresolvable). */
export function watchConsole(page) {
  const problems = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/GL Driver Message|powerPreference|ERR_NAME_NOT_RESOLVED/.test(m.text())) problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  return problems;
}

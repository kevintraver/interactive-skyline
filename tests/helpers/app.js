// Driving the app from Playwright. Everything goes through window.__skyline (the hooks contract, T0.5).
import { test } from '@playwright/test';
import cities from '../../data/cities.json' with { type: 'json' };

export const CITIES = Object.keys(cities);
export const views = (city) => cities[city].views.map((v) => v.id);
/** Every scene the baselines and the performance suite cover: each city, each view, day and night. */
export const SCENES = CITIES.flatMap((city) => views(city).flatMap((view) => ['day', 'night'].map((look) => ({ city, view, look }))));
export const sceneName = ({ city, view, look }) => `${city}-${view}-${look}`;
/** Seconds into the fountain, LED and wheel loops at which the goldens are held (the landmark checker's default). */
export const SHOW_TIME = 47;

/** Open a city and wait until the app, its extras and its fountain shows are loaded. `query`: more parameters. */
export async function boot(page, city, query = '') {
  // the webgpu-software project runs every spec on the WebGPU backend (Chromium's software adapter)
  let project = '';
  try { project = test.info().project.name; } catch { /* outside a test */ }
  if (project === 'webgpu-software' && !/backend=|renderer=legacy/.test(query)) query = query ? `${query}&backend=webgpu` : 'backend=webgpu';
  await page.goto(`/?city=${city}${query ? `&${query}` : ''}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 90_000 });
  await page.evaluate(() => window.__skyline.attractions.ready);
}

/** Wait for `n` animation frames: the app renders on the next frame after an invalidate(). */
export const frames = (page, n = 3) => page.evaluate((k) => new Promise((done) => {
  const step = () => (k-- <= 0 ? done() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

/** Put the app into one scene, with everything that animates held still. */
export async function stage(page, { view, look }) {
  await page.evaluate(({ view, night, show }) => {
    const s = window.__skyline;
    s.attractions.freeze(show);
    s.setSetting('night', night);
    s.setView(view);
    // The shadow map is drawn only on demand, and nothing redraws it after freeze() on a day scene (setting
    // night to false is then no change), so it would keep the fountain jets as they stood whenever it was last
    // drawn during loading. Redraw it now, with the clocks held.
    s.renderer.shadowMap.needsUpdate = true;
    s.invalidate();
  }, { view, night: look === 'night', show: SHOW_TIME });
  // the view tiles redraw while the camera is still, then the frame itself; the loading cover fades out
  await frames(page, 4);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')).opacity === '0');
  // phase 2: the automatic exposure has metered the new scene and stopped adapting (nothing then renders)
  await page.waitForFunction(() => { const l = window.__skyline.look; return !l || l.exposure.state.settled; }, null, { timeout: 300_000 });
  await frames(page, 2);
}

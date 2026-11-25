// The blank frame (24 Nov 2026), on this machine's GPU, both backends. Under the runner about one preview in five came
// out blank (the page's grey through a transparent canvas, for the rest of the visit). The cause was a quality level:
// the tests clear localStorage, so the fill-rate benchmark ran 1.5 s after each load and, under load, dropped High to
// Low while Fly was being entered. On WebGPU Low's 2x MSAA with a discarded colour buffer resolved to black; on WebGL2
// an MSAA change on the existing scene target drew black; and resizing the shadow map in the same frame left a
// destroyed depth texture bound on both (src/render/pipeline.js bufferPolicy and build(), src/render/setupQuality.js
// createShadowSizer, src/render/bloom.js setScale). These steps went blank every time before the fix.
import { test, expect } from '@playwright/test';
import { openFlight, pictureCheck, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });
test.use({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });

const expectPicture = async (page, what) => {
  const r = await pictureCheck(page);
  expect(r.blank, `BLANK FRAME ${what}: ${JSON.stringify(r)}`).toBe(false);
  return r;
};

for (const backend of ['webgpu', 'webgl']) {
  const q = backend === 'webgl' ? '&backend=webgl' : '';
  test(`${backend}: a drop from High to Low while Fly is entered leaves a picture, and so does the rise back`, async ({ page }) => {
    await openFlight(page, `city=lv&nobench=1${q}`);
    await expectPicture(page, 'on the map at High');
    await page.evaluate(async () => {
      const s = window.__skyline;
      setTimeout(() => s.quality.set('low'), 300); // inside the fade, as the benchmark did
      await s.flight.start(s.flight.list()[0].id, { pace: false, play: false });
      await s.flight.whenSettled();
    });
    const low = await expectPicture(page, 'flying after the drop to Low');
    expect(low.state.quality).toBe('low');
    await page.evaluate(async () => { const s = window.__skyline; s.quality.set('high'); s.invalidate(); await s.flight.whenSettled(); });
    await expectPicture(page, 'flying after the rise back to High');
    await page.evaluate(async () => {
      const s = window.__skyline;
      await s.flight.exit();
      for (let k = 0; k < 20; k++) { s.invalidate(); await new Promise((r) => requestAnimationFrame(r)); }
    });
    await expectPicture(page, 'on the map after leaving Fly');
  });

  test(`${backend}: Low from the first frame draws the map and Fly`, async ({ page }) => {
    await openFlight(page, `city=lv&nobench=1&q=low${q}`);
    const map = await expectPicture(page, 'on the map at Low');
    expect(map.state.samples).toBe(2);
    await page.evaluate(async () => { const s = window.__skyline; await s.flight.start(s.flight.list()[0].id, { pace: false, play: false }); await s.flight.whenSettled(); });
    await expectPicture(page, 'flying at Low');
  });
}

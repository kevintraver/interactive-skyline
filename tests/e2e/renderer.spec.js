// T2.1: the app boots on each renderer and backend it offers, and the basic edit loop works there: boot, hide a
// building through the card, undo with the keyboard. The software suite has no WebGPU adapter, so the automatic
// choice there is the WebGL2 backend; the webgpu-software project (and a real GPU) run the WebGPU case.
import { test, expect } from '@playwright/test';
import { CITIES, boot } from '../helpers/app.js';

test.describe.configure({ timeout: 600_000 });

const CASES = [
  { name: 'auto', query: '', expect: null },
  { name: 'webgl2 backend', query: 'backend=webgl', expect: 'webgl2' },
  { name: 'webgpu backend', query: 'backend=webgpu', expect: 'webgpu' },
  { name: 'classic renderer', query: 'renderer=legacy', expect: 'webgl' },
];

for (const city of CITIES) {
  for (const c of CASES) {
    test(`${city} ${c.name}: boot, hide, undo`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      if (c.expect === 'webgpu') {
        await page.goto('/favicon.ico').catch(() => {});
        const has = await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter()));
        test.skip(!has, 'no WebGPU adapter in this browser');
      }
      await boot(page, city, c.query);
      const info = await page.evaluate(() => ({ backend: window.__skyline.backend, perf: window.__skyline.perf.backend }));
      if (c.expect) expect(info.backend).toBe(c.expect);
      else expect(['webgl2', 'webgpu']).toContain(info.backend);
      expect(info.perf).toBe(info.backend);
      const id = await page.evaluate(() => window.__skyline.tall[0].data.id);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')).opacity === '0');
      await page.evaluate((i) => window.__skyline.select(i), id);
      await expect(page.locator('#card [data-act="hide"]')).toBeVisible();
      const f0 = await page.evaluate(() => window.__skyline.perf.frames());
      await page.locator('#card [data-act="hide"]').click();
      await expect.poll(() => page.evaluate(() => window.__skyline.hiddenIds())).toContain(id);
      // the hide drew a frame
      await expect.poll(() => page.evaluate(() => window.__skyline.perf.frames())).toBeGreaterThan(f0);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      await expect.poll(() => page.evaluate(() => window.__skyline.hiddenIds())).not.toContain(id);
      // a captured frame is a real picture, not a blank canvas
      const png = await page.evaluate(async () => {
        const blob = await window.__skyline.capture();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(64, 40), g = c.getContext('2d');
        g.drawImage(bmp, 0, 0, 64, 40);
        const px = g.getImageData(0, 0, 64, 40).data;
        let lo = 255, hi = 0;
        for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; lo = Math.min(lo, l); hi = Math.max(hi, l); }
        return { type: blob.type, w: bmp.width, h: bmp.height, range: hi - lo };
      });
      expect(png.type).toBe('image/png');
      expect(png.w).toBeGreaterThan(100);
      expect(png.range, 'the captured frame has contrast').toBeGreaterThan(40);
      expect(errors).toEqual([]);
    });
  }
}

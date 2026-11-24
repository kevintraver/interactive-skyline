// The night reads as night (the stability pass, plan 01): each of the five night scenes of the goldens, drawn by the
// shipped look and by the classic renderer (?renderer=legacy) in the same run, same view, compared on the goldens'
// crop (x 0..1180, y 60..660, clear of the controls): mean luma 0.8 to 1.4 times the classic one; the share of pixels
// brighter than 0.85 at most the classic share plus 1.5 points; the share darker than 0.08 at least 0.7 times the
// classic share; and in the Strat view the mean saturation at least 0.8 times the classic one (the signs and the
// Sphere stay coloured). Parity specs stay as they are; this checks the shipped look's tone, not its pixels.
import { test, expect } from '@playwright/test';
import { boot, stage } from '../helpers/app.js';

test.describe.configure({ timeout: 1_800_000 });

const SCENES = [['lv', 'aerial'], ['lv', 'east'], ['lv', 'strat'], ['slc', 'aerial'], ['slc', 'ensign']];

/** Statistics of a PNG on the crop, worked out in the page (no image library in Node here). */
const stats = (page, png) => page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const W = 1180, H = 600, c = new OffscreenCanvas(W, H), g = c.getContext('2d');
  g.drawImage(bmp, 0, 60, W, H, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  let sum = 0, bright = 0, dark = 0, sat = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    sum += l; if (l > 0.85) bright++; if (l < 0.08) dark++;
    sat += mx > 1e-4 ? (mx - mn) / mx : 0;
  }
  const n = px.length / 4;
  return { mean: sum / n, bright: bright / n, dark: dark / n, sat: sat / n };
}, png.toString('base64'));

for (const [city, view] of SCENES) {
  test(`${city}-${view} at night: the shipped look keeps the classic night's tone`, async ({ browser }) => {
    const shot = async (query) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await boot(page, city, query);
      await stage(page, { view, look: 'night' });
      const png = await page.screenshot();
      const s = await stats(page, png);
      await page.close();
      return s;
    };
    const classic = await shot('renderer=legacy');
    const shipped = await shot('backend=webgl');
    const r = { classic, shipped, ratio: shipped.mean / classic.mean };
    console.log(city, view, JSON.stringify(r));
    test.info().annotations.push({ type: 'night-look', description: JSON.stringify(r) });
    expect(r.ratio, 'mean luma against the classic night').toBeGreaterThanOrEqual(0.8);
    expect(r.ratio, 'mean luma against the classic night').toBeLessThanOrEqual(1.4);
    expect(shipped.bright, 'share brighter than 0.85').toBeLessThanOrEqual(classic.bright + 0.015);
    expect(shipped.dark, 'share darker than 0.08').toBeGreaterThanOrEqual(0.7 * classic.dark);
    if (view === 'strat') expect(shipped.sat, 'mean saturation').toBeGreaterThanOrEqual(0.8 * classic.sat);
  });
}

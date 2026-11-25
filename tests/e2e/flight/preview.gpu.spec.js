// Plan 03, F2.8 (section 4.2): the picker's preview pictures. Each baked flight in the index is rendered on this
// machine's GPU from its default seat (the Strip's side, the default look) 90 seconds before touchdown, with the
// interface hidden. A normal run checks only that the picture is a picture (not blank, not one colour). Run with
//   SKYLINE_WRITE_PREVIEWS=1
// it also writes public/data/lv/flights/<id>.jpg, which the picker looks for beside each flight (src/flight/ui/cards.js
// previewUrl); the index is not touched (scripts/bake_flights.py writes it afresh).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openFlight, realFlights, frames, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });
test.use({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });

const WRITE = process.env.SKYLINE_WRITE_PREVIEWS === '1';
const DIR = path.resolve('public/data/lv/flights');
/** Seconds before touchdown (section 4.2). */
const LEAD_S = 90;

for (const f of realFlights()) {
  test(`preview of ${f.id}: the default seat ${LEAD_S} s before touchdown`, async ({ page }) => {
    await openFlight(page, 'city=lv', { real: true });
    const info = await page.evaluate(async ({ id, lead }) => {
      const fl = window.__skyline.flight;
      await fl.start(id, { pace: false, play: false });
      const td = fl.state().touchdownT;
      await fl.seek({ at: td - lead });
      fl.options({ hud: false });
      await fl.whenSettled();
      // the picture alone: everything over the canvas hidden
      const canvas = document.querySelector('canvas');
      for (const el of document.body.children) if (!el.contains(canvas)) el.style.visibility = 'hidden';
      return { state: fl.state(), td };
    }, { id: f.id, lead: LEAD_S });
    // KNOWN DEFECT (24 Nov 2026, not diagnosed): under the Playwright runner about one run in five shows a blank frame
    // here, the page's grey through a transparent canvas, and it stays blank through further drawn frames; the canvas
    // is visible and sized, the exposure is sane, a quality change does not cause it, and ten runs of the same steps
    // outside the runner did not show it. The spread check below fails such a run.
    await frames(page, 2);
    await page.evaluate(() => window.__skyline.flight.whenSettled());
    const jpg = await page.screenshot({ type: 'jpeg', quality: 80 });
    await test.info().attach(`${f.id}.jpg`, { body: jpg, contentType: 'image/jpeg' });
    expect(info.state.seat).toMatch(/^\d+[AF]$/);
    expect(info.state.t).toBeCloseTo(info.td - LEAD_S, 1);

    // a picture: its pixels vary (not a cleared canvas or a single colour)
    const spread = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let sum = 0, sum2 = 0, n = 0;
      for (let i = 0; i < px.length; i += 16) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += l; sum2 += l * l; n++; }
      const mean = sum / n;
      return { mean, sd: Math.sqrt(sum2 / n - mean * mean) };
    }, jpg.toString('base64'));
    console.log(f.id, 'preview', JSON.stringify({ seat: info.state.seat, t: info.state.t, ...spread, bytes: jpg.length }));
    expect(spread.sd).toBeGreaterThan(8);

    if (WRITE) {
      fs.writeFileSync(path.join(DIR, `${f.id}.jpg`), jpg);
      console.log('wrote', path.relative(process.cwd(), path.join(DIR, `${f.id}.jpg`)));
    }
  });
}

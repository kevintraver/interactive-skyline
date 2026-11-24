// Far out (the stability pass, plan 01): from the edge of where the camera may go, the sky is the dome's gradient
// everywhere (no clear colour, no flat second colour where a dome fixed at the origin was clipped by the far plane),
// and below the horizon there is only ground or haze (the apron continues the terrain past its grid), never the
// sky's colour. The camera is put by the hooks at each corner and edge midpoint of cameraLimits.bounds, at the
// largest distance, looking inward and outward, in both cities, on the new renderer and on the classic one.
import { test, expect } from '@playwright/test';
import { boot, frames } from '../helpers/app.js';

test.describe.configure({ timeout: 3_600_000 });

const W = 320, H = 200;

/** Analyse one captured frame: transparent (clear) pixels, the spread of the top rows, sky-coloured ground. */
const look = (page, pose) => page.evaluate(async ({ pose, W, H }) => {
  const s = window.__skyline, c = s.controls, b = s.cameraLimits.bounds;
  const x = pose.fx < 0 ? b.minX : pose.fx > 0 ? b.maxX : (b.minX + b.maxX) / 2;
  const z = pose.fz < 0 ? b.minZ : pose.fz > 0 ? b.maxZ : (b.minZ + b.maxZ) / 2;
  // the outward direction from the middle of the box
  const ox = pose.fx, oz = pose.fz, ol = Math.hypot(ox, oz) || 1;
  const dir = pose.outward ? 1 : -1; // looking outward: the camera stands inward of the pivot
  const dist = c.maxDistance, polar = 80 * Math.PI / 180;
  c.target.set(x, 0, z);
  const hor = Math.sin(polar) * dist;
  s.camera.position.set(x - dir * (ox / ol) * hor, Math.cos(polar) * dist, z - dir * (oz / ol) * hor);
  c.update();
  s.invalidate();
  const blob = await s.capture();
  const bmp = await createImageBitmap(blob), cv = new OffscreenCanvas(W, H), g = cv.getContext('2d');
  g.drawImage(bmp, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const at = (i, j) => { const k = (j * W + i) * 4; return [px[k], px[k + 1], px[k + 2], px[k + 3]]; };
  let clear = 0;
  for (let k = 3; k < px.length; k += 4) if (px[k] < 250) clear++;
  // the top eighth of the frame is sky: each row follows the gradient, so its colour barely changes along the row
  let rowSpread = 0;
  const top = [0, 0, 0];
  for (let j = 0; j < H / 8; j++) {
    let lo = [255, 255, 255], hi = [0, 0, 0];
    for (let i = 0; i < W; i++) {
      const p = at(i, j);
      lo = lo.map((v, q) => Math.min(v, p[q])); hi = hi.map((v, q) => Math.max(v, p[q]));
      if (j < 4) for (let q = 0; q < 3; q++) top[q] += p[q] / (4 * W);
    }
    rowSpread = Math.max(rowSpread, ...hi.map((v, q) => v - lo[q]));
  }
  // the bottom third is below the horizon: no pixel there may have the colour of the sky at the top of the frame
  let skyBelow = 0;
  for (let j = Math.floor((2 * H) / 3); j < H; j++) for (let i = 0; i < W; i++) {
    const p = at(i, j);
    if (Math.max(Math.abs(p[0] - top[0]), Math.abs(p[1] - top[1]), Math.abs(p[2] - top[2])) < 6) skyBelow++;
  }
  return { pose, cam: s.camera.position.toArray().map(Math.round), clear, rowSpread, skyBelow, top: top.map(Math.round) };
}, { pose, W, H });

const POSES = [];
for (const fx of [-1, 0, 1]) for (const fz of [-1, 0, 1]) if (fx || fz) for (const outward of [true, false]) POSES.push({ fx, fz, outward });

for (const city of ['lv', 'slc']) {
  for (const query of ['backend=webgl', 'renderer=legacy']) {
    test(`${city} ${query}: far out, the sky is the dome and the ground goes on into the haze`, async ({ page }) => {
      await page.setViewportSize({ width: W, height: H });
      await boot(page, city, query);
      await page.evaluate(() => { const s = window.__skyline; s.attractions.freeze(47); s.setSetting('night', false); });
      await frames(page, 2);
      const rows = [];
      for (const pose of POSES) rows.push(await look(page, pose));
      console.log(JSON.stringify(rows));
      test.info().annotations.push({ type: 'far-out', description: JSON.stringify(rows) });
      for (const r of rows) {
        const name = `${JSON.stringify(r.pose)} at ${r.cam}`;
        expect(r.clear, `clear pixels, ${name}`).toBe(0);
        expect(r.rowSpread, `spread along a sky row, ${name}`).toBeLessThanOrEqual(24);
        expect(r.skyBelow, `sky-coloured pixels below the horizon, ${name}`).toBeLessThanOrEqual(W * H * 0.002);
      }
    });
  }
}

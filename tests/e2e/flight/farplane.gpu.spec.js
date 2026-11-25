// Plan 03, F6.2 (src/flight/view/layers.js nearFar): at cruise the far plane reaches the eye's horizon plus the horizon
// of the region's highest summit (4,421 m), at most 700 km, on both backends, with the near plane at 2 cm, under plan
// 01's depth schemes (reversed float depth where the backend has clip control: WebGPU, and WebGL2 on ANGLE Metal;
// logarithmic depth on a WebGL2 without it). Depth must still hold: a frame drawn again with the eye moved by 0.1 mm is
// the same frame, at cruise (terrain to 600 km, the wing at 3 m) and at touchdown looking down at the runway (paint 3 cm
// over the pavement, which lies 0.25 m over the ground moved under it), where depth fighting would flip patches between
// surfaces from one frame to the next. The pictures are attached.
//
// Why no picture of the old far plane against the new: today's exponential fog turns all ground beyond about 200 km into
// the fog's colour, which matches the sky dome there, so ground cut at the old plane (the horizon + 80 km) and ground
// drawn to the new one look the same (measured: 0 pixels differ). The cut shows once plan 01's aerial perspective, which
// keeps far ranges visible, replaces the fog. The unit test (tests/unit/flight/layers.test.js) works the depth
// resolution of both schemes through.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { openFlight, frames, diffShots, realFlights, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const R = 6371000 * (7 / 6);
const horizon = (h) => Math.sqrt(2 * R * Math.max(h, 2));

/** Draw the view twice as it is (the control: what changes from one frame to the next anyway), then again with the
 * eye 0.1 mm up and 0.1 mm right (the wing 3 m away moves 0.03 px; depth fighting flips at any change): the share of pixels that changed each time. */
async function jitter(page, name) {
  const draw = (dx, dy) => page.evaluate(({ dx, dy }) => {
    const s = window.__skyline, c = s.camera;
    c.position.x += dx; c.position.y += dy;
    c.updateMatrixWorld(true);
    s.perf.info(); // one frame drawn without the flight placing the camera again
    c.position.x -= dx; c.position.y -= dy;
    c.updateMatrixWorld(true);
  }, { dx, dy });
  await draw(0, 0);
  const a = await page.screenshot();
  await draw(0, 0);
  const a2 = await page.screenshot();
  await draw(0.0001, 0.0001);
  const b = await page.screenshot();
  fs.writeFileSync(test.info().outputPath(`${name}.png`), a);
  fs.writeFileSync(test.info().outputPath(`${name}-moved.png`), b);
  await test.info().attach(`${name}.png`, { body: a, contentType: 'image/png' });
  const still = await diffShots(page, a, a2, { tol: 12 }), moved = await diffShots(page, a2, b, { tol: 12 });
  return { still: still.share, share: moved.share, mad: moved.mad };
}

for (const backend of ['webgpu', 'webgl2']) {
  test(`${backend}: the far plane reaches every summit that can show, and depth holds from the pane to the horizon`, async ({ page }) => {
    const id = realFlights()[0]?.id;
    test.skip(!id, 'no baked flight');
    await openFlight(page, `city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`, { real: true }); // the address says webgl
    const r = await page.evaluate(async (fid) => {
      const s = window.__skyline, f = s.flight;
      await f.start(fid, { pace: false, play: false });
      f.options({ hud: false, frame: false }); // the clean view: the cabin trim 30 cm away would move by parallax
      f.look({ yaw: 0, pitch: -3, lens: 26 });
      await f.whenSettled();
      for (const el of document.body.children) if (!el.contains(s.renderer.domElement)) el.style.visibility = 'hidden';
      const c = s.camera;
      return {
        far: c.far, near: c.near, altMsl: f.state().altMsl,
        reversed: !!s.renderer.reversedDepthBuffer, logarithmic: !!s.renderer.logarithmicDepthBuffer, backend: s.perf.gpu().backend,
      };
    }, id);
    console.log(backend, 'cruise', JSON.stringify(r));
    expect(r.backend).toBe(backend);
    if (backend === 'webgpu') expect(r.reversed).toBe(true); else expect(r.reversed || r.logarithmic).toBe(true);
    expect(r.near).toBe(0.02);
    const want = Math.min(horizon(r.altMsl) + horizon(4421), 700000);
    expect(r.far).toBeGreaterThan(want - 2000); // the eye sits a few metres above the wheels the state reports
    expect(r.far).toBeLessThan(want + 2000);
    await frames(page, 4);
    const cruise = await jitter(page, `${backend}-cruise-far-${Math.round(r.far / 1000)}km`);
    console.log(backend, 'cruise, eye moved 0.1 mm', JSON.stringify(cruise));
    expect(cruise.share, 'pixels that change when the eye moves 0.1 mm at cruise').toBeLessThan(0.002);

    const t = await page.evaluate(async () => {
      const f = window.__skyline.flight;
      await f.seek({ chapter: 'touchdown' });
      f.look({ yaw: -10, pitch: -25, lens: 26 });
      await f.whenSettled();
      return { far: window.__skyline.camera.far, hag: f.state().heightAboveGround };
    });
    await frames(page, 4);
    const td = await jitter(page, `${backend}-touchdown-runway-far-${Math.round(t.far / 1000)}km`);
    console.log(backend, 'touchdown, eye moved 0.1 mm', JSON.stringify({ ...t, ...td }));
    expect(td.share, 'pixels that change when the eye moves 0.1 mm over the runway').toBeLessThan(0.002);
  });
}

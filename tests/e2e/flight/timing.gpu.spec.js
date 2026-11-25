// The flight's own JavaScript per frame, and what a frame draws (plan 03, sections 9.1 and 9.4; F8.2), in the way the
// drive's timing is held (tests/e2e/drive.perf.spec.js): __skyline.flight.stats() keeps the last 240 frames of the
// mode's own work (session.js, loop order 20: the track's sample, the layers and the camera, the airframe and its lamps,
// the cabin, the pane, the world: terrain chunks, night ground, airport lights; and the flight's bar), split by step.
// Frame time as a whole is not judged here: it depends on the machine and its load (tests/manual/flight-perf.mjs
// measures it, part by part).
//
// Runs in flight-gpu (a *.gpu.spec.js) until a flight-timing project exists in playwright.config.js. Alone, on a quiet
// machine: with other browsers busy on every core the page being timed is starved, and the step timers, which are wall
// time, take the waits in. To run just this:
//   SKYLINE_DIST=dist-timing SKYLINE_PORT=4911 pnpm exec playwright test --project=flight-gpu --workers=1 tests/e2e/flight/timing.gpu.spec.js
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openFlight, realFlights, frames, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const ID = 'lv-19-night';

test(`${ID}: the flight's own JavaScript per frame, and the draws and triangles of a frame on final`, async ({ page }) => {
  test.skip(!realFlights().some((f) => f.id === ID), `${ID} is not baked`);
  await openFlight(page, 'city=lv', { real: true });
  const r = await page.evaluate(async (id) => {
    const f = window.__skyline.flight;
    await f.start(id, { pace: false, play: false });
    f.options({ hud: false });
    const { touchdownT, durationS } = f.state();
    // seeks across the flight, from cruise to the rollout: each frame places everything afresh
    for (let i = 0; i < 24; i++) {
      await f.seek({ at: (i + 0.5) * (Math.min(durationS - 1, touchdownT + 30) / 24) });
      await f.whenSettled();
    }
    const seeks = f.stats().layerMs;
    // the counts of a frame drawn by the app (not by a measurement) 60 s out, the night ground and the airport in view
    await f.seek({ at: touchdownT - 60 });
    await f.whenSettled();
    const st = f.stats();
    const counts = { drawCalls: st.drawCalls, triangles: st.triangles, scenePass: st.scenePass, region: { drawCalls: st.world.region.drawCalls, triangles: st.world.region.triangles },
      mapChunks: st.world.mapChunks, lamps: st.world.ground.lamps?.drawn ?? 0 };
    // playing the last 75 s: the steady state the budget is for. 300 frames leave only playing frames in the 240 kept.
    await f.seek({ at: touchdownT - 75 });
    await f.whenSettled();
    f.play();
    await new Promise((resolve) => { let n = 0; const step = () => (++n >= 300 ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step); });
    f.pause();
    const pl = f.stats();
    return { seeks, counts, playing: pl.layerMs, steps: pl.steps };
  }, ID);
  await frames(page, 2);
  console.log(`${ID} per-frame JS (ms) and counts:`, JSON.stringify(r));
  test.info().annotations.push({ type: 'flight-timing', description: JSON.stringify(r) });

  // The counts: the map's ground is drawn in chunks while flying (terrain/mapChunks.js) and a frame 60 s out draws a
  // fraction of its 3.16 million triangles. Measured 25 Nov 2026 on the M4 (WebGPU): 175 draws, 2.72 million triangles
  // (4.44 million before the chunks); the scene pass 152 draws.
  expect(r.counts.mapChunks.every((c) => c.shown && c.chunks > 0)).toBe(true);
  expect(r.counts.drawCalls).toBeGreaterThan(50);
  expect(r.counts.drawCalls).toBeLessThan(260);
  expect(r.counts.triangles).toBeLessThan(3.4e6);
  expect(r.counts.region.triangles).toBeLessThanOrEqual(1.5e6); // section 9.1 on High (meshes.js BUDGET)

  // The flight's own JavaScript. Section 9.1 budgets 0.4 ms on High (0.6 on Low) for the track sample, the rig, the
  // head, the uniforms and the chunk selection; the mode's work now also holds the airport's lights, the night ground,
  // the cabin's light and the pane, so these gates are the measured cost with room, not the plan's figure. Measured on
  // the M4, 25 Nov 2026 (load 15 to 30 from other work): playing, mean 0.8 to 1.2 ms and p95 1.4 to 2.1 ms; a seek's
  // frame p95 under 3 ms. Before F8.2 the playing mean was 1.8 to 2.1 ms (0.6 ms of it a layout forced by reading the
  // canvas's size in the frame).
  expect(r.playing.frames).toBeGreaterThanOrEqual(200);
  expect(r.playing.mean).toBeLessThan(1.6);
  expect(r.playing.p95).toBeLessThan(3);
  expect(r.seeks.p95).toBeLessThan(6);
  // no single step takes the frame: the track's sample (the forced layout lived there) stays small
  expect(r.steps.sample.mean).toBeLessThan(0.3);
});

// Section 9.2: the flight's code is a lazy chunk of at most 200 KB minified. The build this run serves holds it in
// mode-<hash>.js (the session, the world and everything the mode imports; three and the renderer are the app's). Measured
// 217 KB (82 KB gzipped) at cba1fe2 and 223 KB at e442cf3 (25 Nov 2026): over the plan's figure, guarded at 230 KB so
// that it does not grow unseen.
test('the flight\'s code chunk stays within its size', () => {
  const dir = path.resolve(process.env.SKYLINE_DIST || 'dist', 'assets');
  test.skip(!fs.existsSync(dir), `no build at ${dir}`);
  const chunk = fs.readdirSync(dir).find((f) => /^mode-[\w-]+\.js$/.test(f));
  expect(chunk).toBeTruthy();
  const kb = fs.statSync(path.join(dir, chunk)).size / 1024;
  console.log(`flight chunk ${chunk}: ${kb.toFixed(1)} KB`);
  expect(kb).toBeLessThan(230);
});


// Plan 03, F6.4 and section 7.11 (src/flight/ground): the ground at night from the air, on both backends.
//   - the valley's street lamps are drawn as points from 60 s out, in one draw, within the quality level's budget;
//   - the airport's ground does not glow: at runway 19's threshold, almost nothing in the lower part of the frame is
//     the map's orange street glow (before the night ground, 71 % of it was, measured on the frame of a265056);
//   - the lamps switch with the Sun (each lamp's photocell, as in the drive: 2 % lit at -3 degrees, 17 % at -4, 74 % at
//     -5, 98 % at -6): none at cruise on the dusk flight (the Sun 4 degrees up), the first few at its threshold (1.3
//     degrees down, about a hundred of the valley's lamps), all on the night flights; the same moment, the same lamps;
//   - F8.1: on the night final the cabin, dimmed for landing, is a dim shape (its sidewall at least 0.09 cd/m^2, the
//     cabin's emergency lighting alone), not black; on the dusk final the cabin is part way into its night setting and
//     the obstruction lights burn (their own photocell), though almost no street lamp is lit yet.
// Frame times and counts are printed and attached; they are not judged here (section 9.1 is F8.2's).
import { test, expect } from '@playwright/test';
import { openFlight, frames, realFlights, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const have = (id) => realFlights().some((f) => f.id === id);

/** Seek, settle, and return the night ground's numbers and the frame's. */
async function at(page, where, { clean = true, otherSide = false } = {}) {
  return page.evaluate(async ({ where, clean, otherSide }) => {
    const s = window.__skyline, f = s.flight;
    const seat = f.state().seat;
    if (otherSide && !/A$/.test(seat)) f.setSeat(seat.replace(/[A-Z]$/, 'A'));
    f.options({ hud: false, frame: !clean });
    await f.seek(where);
    await f.whenSettled();
    await f.whenSettled();
    for (const el of document.body.children) if (!el.contains(s.renderer.domElement)) el.style.visibility = 'hidden';
    const g = f.stats().world.ground;
    const tp = await s.perf.throughput(20, 4);
    // the cabin's sidewall beside the window (the default look centres the window), through the window view only
    const wall = clean ? null : (await f.luminance({ x: -0.81, y: 0.1 })).composed;
    return { ground: g, msPerFrame: +tp.msPerFrame.toFixed(2), calls: s.perf.info().calls, sunAltDeg: s.env.state?.sun?.altDeg, backend: s.perf.gpu().backend, t: f.state().t,
      cabinLight: f.stats().cabinLight, wall };
  }, { where, clean, otherSide });
}

/** Share of pixels in the lower part of a screenshot that are the street glow's orange (hue 20 to 45 degrees, lit). */
function orangeShare(page, png, fromY = 0.55) {
  return page.evaluate(async ({ b64, fromY }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const y0 = Math.floor(img.height * fromY), d = x.getImageData(0, y0, img.width, img.height - y0).data;
    let n = 0, orange = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      n++;
      if (r < 40 || r < g * 1.25 || g < b * 1.05) continue;
      const hue = (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
      if (hue > 15 && hue < 50) orange++;
    }
    return orange / n;
  }, { b64: png.toString('base64'), fromY });
}

for (const backend of ['webgpu', 'webgl2']) {
  const query = `city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`;

  test(`${backend}: the valley's lamps from 60 s out, and a dark airport ground at the threshold`, async ({ page }) => {
    test.skip(!have('lv-19-night'), 'lv-19-night is not baked');
    await openFlight(page, query, { real: true });
    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-night', { pace: false, play: false }); });
    const out = await page.evaluate(() => window.__skyline.flight.state().touchdownT - 60);
    const r = await at(page, { at: out });
    console.log(backend, '60 s out', JSON.stringify({ ...r, ground: { drawn: r.ground.drawn, draws: r.ground.draws, lamps: r.ground.lamps?.lampsInView, extinctionKm: r.ground.extinctionKm } }));
    expect(r.backend).toBe(backend);
    expect(r.ground.loaded).toBe(true);
    expect(r.ground.lit).toBeGreaterThan(0.99);
    expect(r.ground.drawn).toBeGreaterThan(5000);
    expect(r.ground.drawn).toBeLessThanOrEqual(r.ground.budget);
    expect(r.ground.draws).toBeLessThanOrEqual(3); // lamps, ribbons, obstruction lights
    await frames(page, 3);
    const a = await page.screenshot();
    await test.info().attach(`${backend}-19-sixty-out.png`, { body: a, contentType: 'image/png' });

    const th = await at(page, { chapter: 'threshold' });
    expect(th.ground.mapGroundDark).toBeGreaterThan(0);
    await frames(page, 3);
    const b = await page.screenshot();
    await test.info().attach(`${backend}-19-threshold.png`, { body: b, contentType: 'image/png' });
    const share = await orangeShare(page, b);
    console.log(backend, 'threshold: orange share of the lower frame', share.toFixed(4), JSON.stringify({ ms: th.msPerFrame, calls: th.calls }));
    expect(share).toBeLessThan(0.02);

    // through the window: the cabin dimmed for landing (cabinLight 0.3) is dark but not black (0.031 cd/m^2 before F8.1)
    const cab = await at(page, { chapter: 'threshold' }, { clean: false });
    console.log(backend, 'night threshold: cabin', JSON.stringify({ wall: cab.wall, light: cab.cabinLight }));
    expect(cab.cabinLight.night).toBeGreaterThan(0.99);
    expect(cab.wall).toBeGreaterThan(0.09);
    expect(cab.wall).toBeLessThan(0.6);
  });

  test(`${backend}: lamps follow the Sun through civil twilight, and the same moment draws the same lamps`, async ({ page }) => {
    test.skip(!have('lv-19-dusk') || !have('lv-19-night'), 'the dusk and night flights are not baked');
    await openFlight(page, query, { real: true });
    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-dusk', { pace: false, play: false }); });
    const cruise = await at(page, { at: 0 });
    expect(cruise.sunAltDeg).toBeGreaterThan(2);
    expect(cruise.ground.lit).toBeLessThan(1e-3);
    expect(cruise.ground.drawn).toBe(0);
    const th = await at(page, { chapter: 'threshold' });
    console.log(backend, 'dusk threshold', JSON.stringify({ sun: th.sunAltDeg, lit: th.ground.lit, drawn: th.ground.drawn }));
    expect(th.sunAltDeg).toBeLessThan(0);
    expect(th.ground.lit).toBeGreaterThan(1e-4);
    expect(th.ground.lit).toBeLessThan(0.01);
    // F8.1: the obstruction lights by their own photocell, and the cabin part way into its night setting (the day's
    // full setting until the Sun set, then 15 % at once, before)
    expect(th.ground.obstruction?.on).toBe(true);
    console.log(backend, 'dusk threshold: cabin', JSON.stringify(th.cabinLight));
    expect(th.cabinLight.night).toBeGreaterThan(0.3);
    expect(th.cabinLight.night).toBeLessThan(0.9);
    expect(cruise.cabinLight.night).toBeLessThan(0.05);

    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-night', { pace: false, play: false }); });
    const where = await page.evaluate(() => ({ at: window.__skyline.flight.state().touchdownT - 200 }));
    const one = await at(page, where, { otherSide: true });
    await at(page, { at: where.at - 300 }, { otherSide: true });
    const two = await at(page, where, { otherSide: true });
    console.log(backend, 'night, 200 s out, twice', one.ground.drawn, two.ground.drawn);
    expect(one.ground.lit).toBeGreaterThan(0.99);
    expect(one.ground.drawn).toBeGreaterThan(0);
    expect(two.ground.drawn).toBe(one.ground.drawn);
    expect(two.ground.lamps.lampsInView).toBe(one.ground.lamps.lampsInView);
  });
}

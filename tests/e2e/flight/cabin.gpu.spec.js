// Plan 03, the cabin (F3.5, F5.5, F5.6; the cabin pass of 25 Nov 2026), on this machine's GPU, both backends:
//   - the cabin's own adaptation (src/flight/cabin/cabin.js cabinAdaptation, laid over the outside by the cabin stage):
//     by day nothing is lifted (gain exactly 1); on a night final the dimmed cabin is lifted (it drew at 0 to 18 of
//     255 from 23F, the window a lit rectangle in a black screen) and the wall beside the window reads; it is never
//     lifted over the ceiling; at dusk the guard is taken back when the session hands the cabin the prior's terms;
//   - the model: inside its triangle and draw budgets, with a service unit over the rows whose passenger signs are lit
//     on the approach (a small patch near white in the view up and forward);
//   - the shade asked for twice is there at once, paused (the hook's promise).
import { test, expect } from '@playwright/test';
import { openFlight, frames, realFlights, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const have = (id) => realFlights().some((f) => f.id === id);

/** Seek with the default look of the seat and settle; the cabin's numbers. */
function at(page, where, { seat = '23F', look = null } = {}) {
  return page.evaluate(async ({ where, seat, look }) => {
    const s = window.__skyline, f = s.flight;
    f.options({ hud: false, frame: true });
    if (f.state().seat !== seat) f.setSeat(seat);
    if (look) f.look(look);
    await f.seek(where);
    await f.whenSettled();
    await f.whenSettled();
    for (const el of document.body.children) if (!el.contains(s.renderer.domElement)) el.style.visibility = 'hidden';
    const st = f.stats();
    return { k: s.env.nodes.exposure.value, adaptation: st.cabinStage.adaptation, triangles: st.cabinStage.triangles, draws: st.cabinDrawCalls, stageDraws: st.cabinStage.draws,
      backend: s.perf.gpu().backend, look: f.state().look };
  }, { where, seat, look });
}

/** Mean luma (sRGB 0..255) of a box of a screenshot round a point (NDC), and the brightest luma in a region. */
function sample(page, png, boxes) {
  return page.evaluate(async ({ b64, boxes }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const out = {};
    for (const [k, [u, v, half]] of Object.entries(boxes)) {
      const px = Math.round(((u + 1) / 2) * img.width), py = Math.round(((1 - v) / 2) * img.height);
      const x0 = Math.max(0, px - half), y0 = Math.max(0, py - half);
      const d = x.getImageData(x0, y0, Math.min(img.width - x0, 2 * half + 1), Math.min(img.height - y0, 2 * half + 1)).data;
      let sum = 0, peak = 0;
      for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; peak = Math.max(peak, l); }
      out[k] = { mean: Math.round(sum / (d.length / 4)), peak: Math.round(peak) };
    }
    return out;
  }, { b64: png.toString('base64'), boxes });
}

const WALL = [-0.81, 0.1, 20]; // the sidewall beside the window in the default look (as tests/manual/flight-night-shots.mjs)

for (const backend of ['webgpu', 'webgl2']) {
  const query = `city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`;

  test(`${backend}: the night cabin is lifted on final and reads; the signs are lit; inside its budgets`, async ({ page }) => {
    test.skip(!have('lv-19-night'), 'lv-19-night is not baked');
    await openFlight(page, query, { real: true });
    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-night', { pace: false, play: false }); });
    const out = await page.evaluate(() => window.__skyline.flight.state().touchdownT - 60);
    const fin = await at(page, { at: out });
    expect(fin.backend).toBe(backend);
    console.log(backend, 'night final', JSON.stringify(fin.adaptation));
    // the dimmed cabin (cabinLight 0.3) under an exposure the valley's lamps set: lifted, but not to the ceiling
    expect(fin.adaptation.liftEv).toBeGreaterThan(0.6);
    expect(fin.adaptation.liftEv).toBeLessThanOrEqual(3);
    expect(fin.adaptation.evShown).toBeLessThan(-0.8);
    await frames(page, 3);
    const png = await page.screenshot();
    await test.info().attach(`${backend}-night-final-23F.png`, { body: png, contentType: 'image/png' });
    const r = await sample(page, png, { wall: WALL });
    console.log(backend, 'night final picture', JSON.stringify(r));
    // it drew at 1 to 16 of 255 before the cabin pass; a dark shape beside the lit window now, not black and not bright
    expect(r.wall.mean).toBeGreaterThan(28);
    expect(r.wall.mean).toBeLessThan(110);
    // what the cabin pass draws, instances counted (162,204 before the bay went from 96 to 64 samples round its opening;
    // about 30,000 at cba1fe2, ESTIMATED from its parts); the stage's measured cost is unchanged within noise
    expect(fin.triangles).toBeLessThan(125000);
    expect(fin.draws).toBeLessThan(25);

    // up and forward at the service units over the rows ahead: the signs lit on the approach (near white, small)
    const home = fin.look;
    await at(page, { at: out }, { look: { yaw: home.yaw + 75, pitch: home.pitch + 40, lens: 14 } });
    await frames(page, 3);
    const up = await page.screenshot();
    await test.info().attach(`${backend}-night-final-psu.png`, { body: up, contentType: 'image/png' });
    const sign = await sample(page, up, { upper: [-0.45, 0.45, 200] });
    expect(sign.upper.peak).toBeGreaterThan(235);
  });

  test(`${backend}: by day the cabin is shown as it is; the shade asked for twice is there at once`, async ({ page }) => {
    test.skip(!have('lv-19-day'), 'lv-19-day is not baked');
    await openFlight(page, query, { real: true });
    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-day', { pace: false, play: false }); });
    for (const where of [{ chapter: '10000' }, { chapter: 'touchdown' }]) {
      const d = await at(page, where);
      expect(d.adaptation.liftEv).toBe(0);
      expect(d.adaptation.gain).toBe(1);
    }
    const shade = await page.evaluate(() => { const f = window.__skyline.flight; f.shade(0.5); return f.shade(0.5); });
    expect(shade).toBe(0.5);
    await page.evaluate(() => window.__skyline.flight.shade(0));
  });

  test(`${backend}: at dusk the cabin takes back the guard when it has the prior's terms, never over the ceiling`, async ({ page }) => {
    test.skip(!have('lv-19-dusk'), 'lv-19-dusk is not baked');
    await openFlight(page, query, { real: true });
    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-dusk', { pace: false, play: false }); });
    const d = await at(page, { chapter: '10000' });
    console.log(backend, 'dusk 10000', JSON.stringify(d.adaptation));
    expect(d.adaptation.evShown).toBeLessThanOrEqual(-0.8 + 1e-6);
    if (d.adaptation.exact) expect(d.adaptation.guardEv).toBeGreaterThan(1);
    else test.info().annotations.push({ type: 'note', description: "the session does not hand the cabin the prior's terms yet: the guard is not taken back" });
  });
}

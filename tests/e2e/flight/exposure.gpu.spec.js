// Plan 03, the exposure while flying (src/flight/exposure.js through plan 01's look.setPriorTerms; sections 7.7, 7.11,
// F5.6): the prior follows the light at the aircraft, not a camera standing in the lit city. On both backends:
//   - night cruise (lv-19-night, 30,000 ft over dark desert): exposed about three stops brighter than plan 01's lit
//     street (k 0.032 before this pass), so the towns read and the dimmed cabin keeps its shapes;
//   - on final the valley's lamps raise the prior: the exposure is darker than at cruise, the lamps' light at the eye
//     is between 0.05 and 5 lux, and the lower frame (the lit valley) is bright but not clipped;
//   - dusk at 10,000 ft (lv-19-dusk, the Sun 0.2 degrees up): the key is taken on lit terrain, so under 0.5 % of the
//     ground below the horizon is clipped (1.6 to 4.3 % before this pass, sunlit slopes drawn white);
//   - Orbit (no journey on the timeline) keeps the flight's prior: over the Strip the lamps set it;
//   - leaving Fly gives the map its own prior back: the same EV and exposure as before entering, bit for bit.
import { test, expect } from '@playwright/test';
import { openFlight, frames, realFlights, FLIGHT_TIMEOUT, mapAtRest } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const have = (id) => realFlights().some((f) => f.id === id);

/** Seek, settle, and return the exposure's numbers. */
function at(page, where, { clean = true } = {}) {
  return page.evaluate(async ({ where, clean }) => {
    const s = window.__skyline, f = s.flight;
    f.options({ hud: false, frame: !clean });
    await f.seek(where);
    await f.whenSettled();
    await f.whenSettled();
    for (const el of document.body.children) if (!el.contains(s.renderer.domElement)) el.style.visibility = 'hidden';
    const t = s.look.current.priorTerms;
    return { k: s.env.nodes.exposure.value, priorEv: s.look.current.priorEv, terms: t ? { ...t } : null, sunAltDeg: s.env.state?.sun?.altDeg,
      backend: s.perf.gpu().backend };
  }, { where, clean });
}

/** Share of clipped pixels (a channel at 250 or more) and the median luma in the lower part of a screenshot. */
function lower(page, png, fromY = 0.6) {
  return page.evaluate(async ({ b64, fromY }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const y0 = Math.floor(img.height * fromY), d = x.getImageData(0, y0, img.width, img.height - y0).data;
    const h = new Uint32Array(256);
    let n = 0, clip = 0;
    for (let i = 0; i < d.length; i += 4) {
      n++;
      if (d[i] >= 250 || d[i + 1] >= 250 || d[i + 2] >= 250) clip++;
      h[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    }
    let s = 0, median = 0;
    for (let i = 0; i < 256; i++) { s += h[i]; if (s >= n / 2) { median = i; break; } }
    return { clipped: clip / n, median };
  }, { b64: png.toString('base64'), fromY });
}

for (const backend of ['webgpu', 'webgl2']) {
  const query = `city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`;

  test(`${backend}: night exposed for the window, from cruise to final, and the map's own prior back after`, async ({ page }) => {
    test.skip(!have('lv-19-night'), 'lv-19-night is not baked');
    await openFlight(page, query, { real: true });
    await mapAtRest(page);
    const map = await page.evaluate(() => ({ priorEv: window.__skyline.look.current.priorEv, k: window.__skyline.env.nodes.exposure.value }));
    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-night', { pace: false, play: false }); });

    const cruise = await at(page, { at: 0 });
    console.log(backend, 'night cruise', JSON.stringify(cruise));
    expect(cruise.backend).toBe(backend);
    expect(cruise.terms).not.toBeNull();
    expect(cruise.terms.emissionLux).toBe(0);
    expect(cruise.terms.lampLux).toBeLessThan(0.01); // 100 km from the valley
    // plan 01's lit street exposed the night at 0.032 (k); over dark desert the eye's floor sets it about 3 stops higher
    expect(cruise.k).toBeGreaterThan(0.032 * 2 ** 2.5);
    expect(cruise.k).toBeLessThan(0.032 * 2 ** 3.5);

    const out = await page.evaluate(() => window.__skyline.flight.state().touchdownT - 60);
    const fin = await at(page, { at: out });
    await frames(page, 3);
    const png = await page.screenshot();
    await test.info().attach(`${backend}-night-sixty-out.png`, { body: png, contentType: 'image/png' });
    const low = await lower(page, png);
    console.log(backend, 'night, 60 s out', JSON.stringify({ ...fin, lower: low }));
    expect(fin.terms.lampLux).toBeGreaterThan(0.05);
    expect(fin.terms.lampLux).toBeLessThan(5);
    expect(fin.k).toBeLessThan(cruise.k / 2);
    expect(fin.k).toBeGreaterThan(0.032);
    expect(low.clipped).toBeLessThan(0.02); // the lamps' cores: 0.96 % on 25 Nov 2026

    // Orbit flies with no journey on the timeline: the flight's prior stays (the night ground is shown)
    const orbit = await page.evaluate(async () => {
      const s = window.__skyline, f = s.flight;
      await f.orbit({ altitudeFt: 6000, play: false });
      await f.whenSettled();
      return { journey: !!s.timeline.active, k: s.env.nodes.exposure.value, terms: s.look.current.priorTerms ? { ...s.look.current.priorTerms } : null };
    });
    console.log(backend, 'night orbit', JSON.stringify(orbit));
    expect(orbit.journey).toBe(false);
    expect(orbit.terms).not.toBeNull();
    expect(orbit.terms.emissionLux).toBe(0);
    // circling the Strip at 6,000 ft the lamps put about 2 lux at the eye (2.2 after the glass on 25 Nov 2026): plan
    // 01's lit street is 2 lux, so the exposure is close to the map's own here, not the dark desert's
    expect(orbit.terms.lampLux).toBeGreaterThan(0.5);
    expect(orbit.k).toBeLessThan(cruise.k / 4);

    await page.evaluate(() => window.__skyline.flight.exit());
    await mapAtRest(page);
    const back = await page.evaluate(() => ({ priorEv: window.__skyline.look.current.priorEv, k: window.__skyline.env.nodes.exposure.value,
      terms: window.__skyline.look.current.priorTerms ?? null }));
    expect(back.terms).toBeNull();
    expect(back.priorEv).toBe(map.priorEv);
    expect(back.k).toBe(map.k);
  });

  test(`${backend}: dusk at 10,000 ft keys the Sun to lit terrain, and the slopes do not clip`, async ({ page }) => {
    test.skip(!have('lv-19-dusk'), 'lv-19-dusk is not baked');
    await openFlight(page, query, { real: true });
    await page.evaluate(async () => { await window.__skyline.flight.start('lv-19-dusk', { pace: false, play: false }); });
    const own = await page.evaluate(() => window.__skyline.flight.state().seat);
    for (const seat of [own, own.replace(/[A-Z]$/, (c) => (c <= 'C' ? 'F' : 'A'))]) {
      await page.evaluate((id) => window.__skyline.flight.setSeat(id), seat);
      const r = await at(page, { chapter: '10000' });
      await frames(page, 3);
      const png = await page.screenshot();
      await test.info().attach(`${backend}-dusk-10000-${seat}.png`, { body: png, contentType: 'image/png' });
      const low = await lower(page, png);
      console.log(backend, 'dusk 10,000 ft', seat, JSON.stringify({ ...r, lower: low }));
      expect(r.sunAltDeg).toBeGreaterThan(0);
      expect(r.sunAltDeg).toBeLessThan(2);
      expect(Math.sin((r.terms.keyAltDeg * Math.PI) / 180)).toBeGreaterThan(0.05); // lit terrain's 0.06, not sin 0.2 deg
      expect(low.clipped).toBeLessThan(0.005);
      expect(low.median).toBeGreaterThan(15); // not black: the shade keeps its colour
    }
  });
}

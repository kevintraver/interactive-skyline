// Plan 03, F7.2 and F7.3 (sections 4.6, 4.10, 7.12): Orbit in the running app. Entered from the picker and from a
// link; the aircraft on its circle, banked toward the centre, the Strip in view from the default seat; each preset (a
// cut through black); a small change flown with no jump, a large one cut; the other seat side reversing the direction;
// "Orbit this" on a building; pause and play; scrubbing the hour leaves the aircraft where it is; at night the lamps
// are on; a reload restores the orbit; moving to a recorded flight drops the orbit's address keys; leaving gives the
// map back exactly.
import { test, expect } from '@playwright/test';
import { openFlight, mapAtRest, mapState, stateDiff, diffShots, frames, watchConsole, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const FT = 0.3048;
/** The Strip's centre (src/flight/mode.js STRIP_CENTERS: the mean of data/flights/lv/strip.json's towers). */
const STRIP = { x: 316, n: 415 };
const ORBIT_KEYS = ['orbit', 'alt', 'r', 'phase', 'c', 'on', 'out', 'ias'];
const PRESETS = { overhead: { altFt: 35000, radiusKm: 31 }, valley: { altFt: 12000, radiusKm: 9 }, strip: { altFt: 6500, radiusKm: 5 } };
/** A night moment at Las Vegas (19:00 PST, the Sun 20 degrees down) and a day one (12:00 PST). */
const NIGHT = Date.UTC(2026, 10, 15, 3, 0, 0), DAY = Date.UTC(2026, 10, 14, 20, 0, 0);

const state = (page) => page.evaluate(() => window.__skyline.flight.state());
const address = (page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
/** Wait until no fade is running and the orbit satisfies `pred` (a function body over s, the state). */
async function orbitWhere(page, pred, arg) {
  await page.waitForFunction(({ src, arg }) => {
    const fade = document.getElementById('fly-fade'), s = window.__skyline.flight.state();
    // eslint-disable-next-line no-new-func
    return (!fade || fade.hidden) && s && s.kind === 'orbit' && new Function('s', 'arg', `return (${src});`)(s, arg);
  }, { src: pred, arg }, { timeout: 120_000 });
  await page.evaluate(() => window.__skyline.flight.whenSettled());
  return state(page);
}
/** The bearing (degrees, clockwise from the aircraft's heading) from the aircraft to the orbit's centre. */
const centreOffHeading = (s) => {
  const c = s.orbit.center, toward = (Math.atan2(c.x - s.x, c.n - -s.z) * 180) / Math.PI;
  return ((toward - s.headingDeg + 540) % 360) - 180;
};
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('Orbit from the picker: the circle, the bank, the Strip in view, the presets, pause and play, the hour, night, and back to the map', async ({ page }) => {
  const problems = watchConsole(page);
  await openFlight(page, 'city=lv');
  // the level chosen, not 'auto': plan 01's governor lowers the render scale after two seconds of slow frames (this
  // machine under other agents' load) and raises it only after ten fast ones, which the idle map never draws, so the
  // map would come back at 0.9 scale (15 % of pixels changed, 25 Nov 2026). That is the governor's, not the orbit's.
  await page.evaluate(() => { const q = window.__skyline.quality; q.set(q.level); });
  await page.evaluate(() => window.__skyline.setView('aerial'));
  await mapAtRest(page);
  const before = await mapState(page);
  const shotBefore = await page.screenshot();

  // the picker offers the Orbit beside the flights; its primary button flies The valley
  await page.locator('#modes button[data-mode="flight"]').click();
  const entry = page.locator('.flight-card.orbit-card');
  await expect(entry).toBeVisible();
  await expect(entry.locator('button.primary')).toHaveText('The valley · 12,000 ft');
  await entry.locator('button[data-orbit="valley"]').click();
  await page.waitForFunction(() => window.__skyline.flight.state()?.kind === 'orbit' && window.__skyline.flight.state().playing, null, { timeout: 180_000 });
  await page.evaluate(() => window.__skyline.flight.whenSettled());
  await expect(page.locator('.flight-chip .name')).toHaveText('Orbit');
  await expect(page.locator('#transport')).toBeHidden(); // no journey: the day is plan 01's
  await expect(page.locator('#flightbar .pace')).toBeHidden();
  await expect(page.locator('#flightbar .status .phase')).toHaveText('Orbiting');
  const panel = page.locator('#orbit-controls');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-preset="valley"]')).toHaveAttribute('aria-pressed', 'true');

  // on the circle, at the height, banked toward the centre, the centre abeam on the seat's side (23F: the right)
  await page.evaluate(() => window.__skyline.flight.pause());
  let s = await state(page);
  expect(s.id).toBe('orbit');
  expect(s.seat).toBe('23F');
  expect(s.orbit.direction).toBe('cw');
  expect(s.orbit.center.x).toBeCloseTo(STRIP.x, 6);
  expect(s.orbit.center.n).toBeCloseTo(STRIP.n, 6);
  expect(Math.abs(s.fromCentreM - 9000)).toBeLessThan(3);
  expect(Math.abs(s.altMsl - 12000 * FT)).toBeLessThan(0.5);
  expect(s.rollDeg).toBeGreaterThan(5); // right wing down
  expect(Math.abs(s.bankDeg - s.steadyBankDeg)).toBeLessThan(0.5);
  expect(Math.abs(centreOffHeading(s) - 90)).toBeLessThan(15); // within the wind's crab angle
  expect(s.touchdownT).toBe(Infinity);
  // the panel's bank readout is the bank drawn
  await expect(panel.locator('.op-value').nth(1)).toContainText(`Bank ${Math.round(s.steadyBankDeg)}°`);
  // the Strip is in view through the window from the default seat and look: its centre is on screen, and of the
  // removable towers within 2.5 km of it, several have a clear line of sight from the eye (the wing hides some)
  const strip = await page.evaluate(({ x, n }) => {
    const s = window.__skyline, f = s.flight;
    const near = s.tall.filter((e) => Math.hypot(e.data.c[0] - x, e.data.c[1] - n) < 2500);
    return { centre: f.project(x, f.groundY(x, n), -n), near: near.length, seen: near.filter((e) => f.visible(e.data.id)).length };
  }, STRIP);
  console.log('the Strip from 23F', JSON.stringify(strip));
  expect(strip.centre.onScreen).toBe(true);
  expect(strip.seen).toBeGreaterThanOrEqual(5);
  // the address is a link to it
  const a = await address(page);
  expect(a).toMatchObject({ mode: 'flight', orbit: '1', alt: '12000', r: '9', seat: '23F' });
  expect(a.flight).toBeUndefined();
  expect(Math.abs(Number(a.phase) - s.phaseDeg)).toBeLessThan(0.02);

  // pause and play: Space plays the clock and the aircraft goes round; paused, it stays
  const t0 = s.t;
  await frames(page, 20);
  expect((await state(page)).t).toBe(t0);
  await page.keyboard.press('Space');
  await page.waitForFunction((t) => window.__skyline.flight.state().t > t + 0.3, t0, { timeout: 30_000 });
  expect((await state(page)).playing).toBe(true);
  await page.keyboard.press('Space');
  s = await state(page);
  expect(s.playing).toBe(false);
  await frames(page, 10);
  expect((await state(page)).t).toBe(s.t);

  // scrubbing the hour changes the light and leaves the aircraft where it is (7.12)
  const where = await state(page);
  await page.evaluate((ms) => { window.__skyline.clock.set(ms); window.__skyline.invalidate(); }, NIGHT);
  await frames(page, 4);
  const moved = await state(page);
  expect(moved.simMs).toBe(NIGHT);
  for (const k of ['x', 'y', 'z', 't']) expect(moved[k]).toBe(where[k]);

  // each preset: a cut through black onto the new circle, the panel showing it
  for (const key of ['overhead', 'strip', 'valley']) {
    const p = PRESETS[key];
    await panel.locator(`[data-preset="${key}"]`).click();
    s = await orbitWhere(page, 's.orbit.altFt === arg.altFt', p);
    expect(s.lastChange).toBe('cut');
    expect(Math.abs(s.altMsl - p.altFt * FT)).toBeLessThan(0.5);
    expect(Math.abs(s.fromCentreM - Math.max(p.radiusKm, s.orbit.minRadiusKm) * 1000)).toBeLessThan(3);
    expect(s.t).toBeGreaterThanOrEqual(0);
    expect(s.t).toBeLessThan(s.joinT + 30); // on the new track's circle from its start
    expect(s.joinT).toBe(0);
    await expect(panel.locator(`[data-preset="${key}"]`)).toHaveAttribute('aria-pressed', 'true');
    // at night the aircraft's lamps are as a recorded flight's: wing and logo lights below 10,000 ft
    const WING = 128, LOGO = 64, LANDING = 8;
    if (p.altFt < 10000) expect(s.lights & (WING | LOGO | LANDING)).toBe(WING | LOGO | LANDING);
    else expect(s.lights & (WING | LOGO | LANDING)).toBe(0);
    const g = await page.evaluate(() => window.__skyline.flight.stats().world.ground);
    console.log('night preset', key, JSON.stringify({ lit: g.lit, drawn: g.drawn, lights: s.lights }));
    expect(g.lit).toBeGreaterThan(0.99); // the valley's lamps are on at night
  }
  // by day the wing lights are off and the lamps dark
  await page.evaluate((ms) => { window.__skyline.clock.set(ms); window.__skyline.invalidate(); }, DAY);
  await frames(page, 4);
  s = await state(page);
  expect(s.lights & 128).toBe(0);

  // from the orbit to a recorded flight: the orbit's keys leave the address
  await page.evaluate(() => window.__skyline.flight.start('synthetic-19', { at: 300, play: false }));
  s = await state(page);
  expect(s.kind).toBe('flight');
  expect(s.id).toBe('synthetic-19');
  const b = await address(page);
  for (const k of ORBIT_KEYS) expect(b[k], k).toBeUndefined();
  expect(b).toMatchObject({ mode: 'flight', flight: 'synthetic-19' });
  await expect(panel).toBeHidden();
  await expect(page.locator('#flightbar .pace')).toBeVisible();

  // and back to the map, exactly as it was
  await page.locator('#modes button[data-mode="map"]').click();
  await page.waitForFunction(() => !window.__skyline.flight.active(), null, { timeout: 30_000 });
  await mapAtRest(page);
  expect(stateDiff(await mapState(page), before)).toEqual([]);
  const shotAfter = await page.screenshot();
  const d = await diffShots(page, shotBefore, shotAfter);
  await test.info().attach('map-before.png', { body: shotBefore, contentType: 'image/png' });
  await test.info().attach('map-after.png', { body: shotAfter, contentType: 'image/png' });
  console.log('map before and after an orbit', JSON.stringify(d));
  expect(d.share).toBeLessThan(0.001);
  expect(problems).toEqual([]);
});

test('a link opens the orbit on its circle and phase, paused, and a reload restores it', async ({ page }) => {
  const problems = watchConsole(page);
  const link = 'city=lv&mode=flight&orbit=1&alt=10000&r=7.5&phase=210&seat=23F&t=2026-11-14T21:30:00Z';
  await openFlight(page, link);
  await page.waitForFunction(() => window.__skyline.flight.state()?.kind === 'orbit', null, { timeout: 180_000 });
  await page.evaluate(() => window.__skyline.flight.whenSettled());
  let s = await state(page);
  expect(s.playing).toBe(false);
  expect(s.simMs).toBe(Date.parse('2026-11-14T21:30:00Z'));
  expect(angleDiff(s.phaseDeg, 210)).toBeLessThan(0.01);
  expect(Math.abs(s.fromCentreM - 7500)).toBeLessThan(3);
  expect(Math.abs(s.altMsl - 10000 * FT)).toBeLessThan(0.5);
  expect(s.orbit.direction).toBe('cw');

  // play a little, pause: the address follows; a reload comes back to the same moment within the link's rounding
  await page.evaluate(() => window.__skyline.flight.play());
  await page.waitForFunction((p) => Math.abs(window.__skyline.flight.state().phaseDeg - p) > 1, s.phaseDeg, { timeout: 30_000 });
  await page.evaluate(() => window.__skyline.flight.pause());
  s = await state(page);
  await page.waitForFunction((p) => Math.abs(Number(new URLSearchParams(location.search).get('phase')) - p) < 0.02, s.phaseDeg, { timeout: 10_000 });
  const written = await address(page);
  expect(written).toMatchObject({ mode: 'flight', orbit: '1', alt: '10000', r: '7.5', seat: '23F' });

  await page.reload();
  await page.waitForFunction(() => window.__skyline?.flight?.state?.()?.kind === 'orbit', null, { timeout: 180_000 });
  await page.evaluate(() => window.__skyline.flight.whenSettled());
  const r = await state(page);
  expect(angleDiff(r.phaseDeg, s.phaseDeg)).toBeLessThan(0.01); // the phase is written to 0.01 degree
  expect(Math.abs(r.fromCentreM - s.fromCentreM)).toBeLessThan(3);
  expect(Math.hypot(r.x - s.x, r.z - s.z)).toBeLessThan(5); // 0.01 degree is 1.3 m at 7.5 km
  expect(Math.abs(r.y - s.y)).toBeLessThan(0.5);
  expect(Math.abs(r.simMs - s.simMs)).toBeLessThan(1000);
  expect(r.playing).toBe(false);
  expect(problems).toEqual([]);
});

test('changes: a small one flown without a jump, a large one cut, the other seat side reverses, Orbit this', async ({ page }) => {
  const problems = watchConsole(page);
  await openFlight(page, 'city=lv');
  await page.evaluate(() => window.__skyline.flight.orbit({ altitudeFt: 12000, radiusKm: 9, phaseDeg: 140, play: true }));
  await page.evaluate(() => window.__skyline.flight.whenSettled());

  // a small radius change is flown: the aircraft continues from where it is, frame after frame
  const flown = await page.evaluate(async () => {
    const f = window.__skyline.flight;
    const pos = (s) => ({ x: s.x, y: s.y, z: s.z, t: s.t, gs: s.gs, rate: s.rate, w: performance.now() });
    const before = pos(f.state());
    const change = f.orbitChange({ radiusKm: 9.4 });
    const track = [before];
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      track.push(pos(f.state()));
    }
    return { plan: await change, track };
  });
  expect(flown.plan.cut).toBe(false);
  expect(flown.plan.flownS).toBeLessThanOrEqual(60);
  let worst = 0;
  for (let i = 1; i < flown.track.length; i++) {
    const a = flown.track[i - 1], b = flown.track[i];
    const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    // the distance flown in the orbit's own time between the two frames (it starts again at 0 on the new track, which
    // begins where the aircraft was), and 3 m; a jump onto the new circle would be hundreds of metres
    const dtTrack = b.t >= a.t ? b.t - a.t : b.t;
    const allowed = b.gs * dtTrack * 1.2 + 3;
    expect(dtTrack, `track time ${i}`).toBeLessThan(((b.w - a.w) / 1000) * Math.min(8, b.rate) * 3 + 0.1);
    worst = Math.max(worst, step / allowed);
    expect(step, `step ${i}`).toBeLessThan(allowed);
  }
  console.log('flown change: worst step / allowed', worst.toFixed(3));
  let s = await state(page);
  expect(s.lastChange).toBe('flown');
  // on the new circle once joined
  await page.evaluate(async (t) => { const f = window.__skyline.flight; f.pause(); await f.seek({ at: t }); }, s.joinT + 5);
  s = await state(page);
  expect(Math.abs(s.fromCentreM - 9400)).toBeLessThan(3);

  // a large change (9.4 to 20 km would take minutes) is a cut: on the new circle at once, at about the same bearing
  const phaseBefore = s.phaseDeg;
  const big = await page.evaluate(() => window.__skyline.flight.orbitChange({ radiusKm: 20 }));
  expect(big.cut).toBe(true);
  s = await state(page);
  expect(s.lastChange).toBe('cut');
  expect(Math.abs(s.fromCentreM - 20000)).toBeLessThan(3);
  expect(angleDiff(s.phaseDeg, phaseBefore)).toBeLessThan(0.5); // paused: only the fade's frames moved it, if any
  await expect(page.locator('#orbit-controls .op-value').nth(1)).toContainText('20 km');

  // the other seat side reverses the direction, so the new seat looks into the turn
  expect(s.orbit.direction).toBe('cw');
  await page.evaluate(() => window.__skyline.flight.setSeat('23A'));
  s = await orbitWhere(page, "s.orbit.direction === 'ccw'");
  expect(s.seat).toBe('23A');
  expect(s.lastChange).toBe('cut');
  expect(s.rollDeg).toBeLessThan(-5); // left wing down
  expect(Math.abs(centreOffHeading(s) + 90)).toBeLessThan(15);
  await page.evaluate(() => window.__skyline.flight.play());
  const p0 = s.phaseDeg;
  await page.waitForFunction((p) => { const q = window.__skyline.flight.state().phaseDeg; return Math.abs(((q - p + 540) % 360) - 180) > 0.5; }, p0, { timeout: 30_000 });
  const p1 = (await state(page)).phaseDeg;
  expect(((p0 - p1 + 360) % 360)).toBeGreaterThan(0); // anticlockwise: the bearing from the centre falls
  expect(((p0 - p1 + 360) % 360)).toBeLessThan(20);
  await page.evaluate(() => window.__skyline.flight.pause());
  // the address says the seat
  expect((await address(page)).seat).toBe('23A');

  // Orbit this: select a building, and its card's button re-centres the orbit on it
  const target = await page.evaluate(() => {
    const s = window.__skyline;
    const e = s.tall.find((t) => Math.hypot(t.data.c[0] - 2500, t.data.c[1] - 3000) < 3000) || s.tall[0];
    s.select(e.data.id);
    return { id: e.data.id, x: e.data.c[0], n: e.data.c[1] };
  });
  const orbitThis = page.locator('#card [data-act="orbit"]');
  await expect(orbitThis).toBeVisible();
  await orbitThis.click();
  s = await orbitWhere(page, 's.on === arg', target.id);
  expect(s.orbit.center.x).toBeCloseTo(target.x, 3);
  expect(s.orbit.center.n).toBeCloseTo(target.n, 3);
  expect((await address(page)).on).toBe(target.id);
  await expect(page.locator('#orbit-controls .op-centre button')).toBeVisible(); // "Back to the Strip"
  await page.locator('#orbit-controls .op-centre button').click();
  s = await orbitWhere(page, 's.on === null && Math.abs(s.orbit.center.x - arg.x) < 1e-6', STRIP);
  const back = await address(page);
  expect(back.on).toBeUndefined();
  expect(back.c).toBeUndefined();

  // the map's Look at stays: leaving gives Orbit this's button back to hidden
  await page.evaluate(() => window.__skyline.flight.exit());
  await expect(orbitThis).toBeHidden();
  expect(problems).toEqual([]);
});

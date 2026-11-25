// Plan 03, F1.7 and F4.8 (section 8.2): at the touchdown event the main wheels are within 0.3 m of the ground as drawn
// (the airport's pavement: its runway on the published profile), on the runway, and within 8 m of its centre line (FAA
// NASR runway ends, public/data/lv/airport.json); the terrain lies under the pavement there. Run for the synthetic
// fixture always, and for every baked flight in the index, on both runways.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openFlight, realFlights, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });

const airport = JSON.parse(fs.readFileSync(path.resolve('public/data/lv/airport.json'), 'utf8'));

/** The runway's centre line from its two ends (map metres, x east, y north), with the length between them. */
function centreLine(endId) {
  const rwy = airport.runways.find((r) => r.ends.includes(endId));
  const [a, b] = rwy.ends.map((e) => airport.ends[e].end);
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  return { a, u: [dx / len, dy / len], len };
}

async function checkTouchdown(page, id) {
  const r = await page.evaluate(async (fid) => {
    const f = window.__skyline.flight;
    const meta = f.list().find((m) => m.id === fid);
    await f.start(fid, { pace: false });
    f.pause();
    await f.seek({ chapter: 'touchdown' });
    await f.whenSettled();
    const s = f.state();
    // the map's terrain as moved under the airport: the ground the regional grids or the map's meshes draw, sampled
    // across the runway at the wheels (the pavement must be above it everywhere there)
    const st = f.stats();
    return { meta, s, airport: st.world.airport && { drawCalls: st.world.airport.drawCalls }, ground: st.world.airportGround };
  }, id);
  const { s } = r;
  const line = centreLine(s.runway);
  const px = s.x - line.a[0], py = -s.z - line.a[1];
  const along = px * line.u[0] + py * line.u[1];
  const across = Math.abs(px * line.u[1] - py * line.u[0]);
  console.log(id, 'touchdown', JSON.stringify({ t: s.t, heightAboveGround: s.heightAboveGround, across, along, length: line.len, runway: s.runway, airport: r.airport, ground: r.ground }));
  expect(r.airport, 'the airport is drawn').toBeTruthy();
  expect(r.ground?.on, 'the map\'s ground is moved under the airport while flying').toBe(true);
  expect(s.onGround).toBe(true);
  expect(Math.abs(s.heightAboveGround), 'main wheels above the drawn ground, metres').toBeLessThanOrEqual(0.3);
  expect(across, 'distance from the runway centre line, metres').toBeLessThanOrEqual(8);
  expect(along).toBeGreaterThan(0);
  expect(along).toBeLessThan(line.len);

  // on its wheels with the nose down (the rollout), the aircraft, its cabin and the camera sit at the airframe's ground
  // attitude; in the air nothing is turned
  const roll = await page.evaluate(async () => {
    const f = window.__skyline.flight;
    const air = f.state();
    await f.seek({ at: Math.min(air.durationS, air.touchdownT + 25) });
    const deadline = performance.now() + 60000;
    while (!f.state().airframeModel && performance.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    return { onWheels: f.state(), air: (await f.seek({ at: air.touchdownT - 60 }), f.state()) };
  });
  console.log(id, 'ground attitude', JSON.stringify({ rollout: roll.onWheels.groundPitchDeg, pitchDeg: roll.onWheels.pitchDeg, air: roll.air.groundPitchDeg, model: roll.onWheels.airframeModel }));
  expect(roll.onWheels.airframeModel, 'the modelled airframe loaded').toBe(true);
  expect(roll.onWheels.groundPitchDeg).toBeLessThan(-0.5);
  expect(roll.onWheels.groundPitchDeg).toBeGreaterThan(-1.5);
  expect(roll.air.groundPitchDeg).toBe(0);
}

test('the synthetic runway 19R arrival touches down on the runway', async ({ page }) => {
  await openFlight(page, 'city=lv');
  await checkTouchdown(page, 'synthetic-19');
});

for (const f of realFlights()) {
  test(`the baked flight ${f.id} (runway ${f.runway}) touches down on the runway`, async ({ page }) => {
    await openFlight(page, 'city=lv', { real: true });
    await checkTouchdown(page, f.id);
  });
}

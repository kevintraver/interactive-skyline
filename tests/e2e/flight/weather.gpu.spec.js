// Plan 03, F2.8's as-flown weather on this machine's GPU, on lv-wx (runway 26L, 1 January 2026, an overcast at
// 500 ft): the aircraft is in cloud 2,000 ft above the airport and out of it under the reported base; while it flies,
// plan 01's weather state is the as-flown one (handed over through the weather service, as #sky sets it); on leaving,
// the map's own weather is back.
import { test, expect } from '@playwright/test';
import { openFlight, watchConsole, hasRealFlight, FLIGHT_TIMEOUT } from '../../helpers/flight.js';

test.describe.configure({ timeout: FLIGHT_TIMEOUT });
test.skip(!hasRealFlight(), 'needs the baked flights');

const FT = 0.3048;

/** Seek to the second at which the wheels pass `altM` above sea level on the way down, in the clean view. */
async function seekTo(page, altM) {
  return page.evaluate(async (altM) => {
    const f = window.__skyline.flight;
    let lo = 1000, hi = f.state().touchdownT;
    for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; await f.seek({ at: mid }); if (f.state().altMsl > altM) lo = mid; else hi = mid; }
    await f.seek({ at: Math.round(lo) });
    await f.whenSettled();
    return f.state();
  }, altM);
}

/** What the page shows about the weather now: the cloud drawn round the aircraft, the pane, plan 01's state. */
function weatherNow(page) {
  return page.evaluate(async () => {
    const s = window.__skyline, f = s.flight;
    let group = null;
    s.scene.traverse((o) => { if (o.name === 'flight-clouds') group = o; });
    const shells = group ? group.children.filter((o) => o.visible && o.name.startsWith('flight-cloud-veil')).map((o) => ({ r: o.scale.x, a: o.material.opacityNode?.value })) : [];
    const decks = group ? group.children.filter((o) => o.visible && o.name.startsWith('flight-cloud-deck')).map((o) => o.material.name) : [];
    const probe = [];
    for (const [x, y] of [[0.55, 0.6], [0.55, -0.6], [0.85, 0.3], [0.85, -0.3]]) probe.push((await s.pipeline.probe(x, y)).luminanceCdM2);
    const w = s.env.state?.weather;
    return {
      inScene: !!group, shells, decks, probe, pane: f.window({}).pane.pane,
      plan01: w && { clouds: w.clouds.map((c) => ({ ...c })), visibilityM: s.env.state.visibilityM, source: w.source },
      service: s.weather && { source: s.weather.source, overrides: s.weather.overrides },
    };
  });
}

test('lv-wx: in the overcast at 2,000 ft, out of it under the base; plan 01 flies the as-flown weather and the map gets its own back', async ({ page }) => {
  const problems = watchConsole(page);
  await openFlight(page, 'city=lv', { real: true });
  const header = await page.evaluate(() => fetch('/data/lv/flights/lv-wx.json').then((r) => r.json()));
  const [layer] = header.weather.layers;
  const elev = header.weather.stationElevationM;
  expect(layer.cover).toBe('OVC');
  expect(layer.baseM - elev).toBeCloseTo(500 * FT, 0);

  // the map's own weather before Fly: a preset the visitor chose in #sky
  await page.evaluate(async () => {
    const s = window.__skyline;
    const svc = await s.loadWeather();
    svc.setSource({ kind: 'preset', id: 'hazy' });
  });
  const mapBefore = await page.evaluate(() => ({ source: window.__skyline.weather.source, overrides: window.__skyline.weather.overrides }));
  expect(mapBefore.source).toEqual({ kind: 'preset', id: 'hazy' });

  await page.evaluate(async () => {
    const f = window.__skyline.flight;
    await f.start('lv-wx', { at: 1600, play: false });
    f.options({ frame: false, hud: false });
    await f.whenSettled();
  });

  // 2,000 ft above the airport: inside the layer (its observed base, its estimated top)
  const inside = await seekTo(page, elev + 2000 * FT);
  expect(inside.altMsl).toBeGreaterThan(layer.baseM);
  expect(inside.altMsl).toBeLessThan(layer.topM);
  const a = await weatherNow(page);
  console.log('in cloud', JSON.stringify({ t: inside.t, alt: inside.altMsl, shells: a.shells, decks: a.decks, probe: a.probe, pane: a.pane }));
  expect(a.inScene).toBe(true);
  expect(a.pane.inCloud).toBe(true);
  expect(a.pane.mist).toBeGreaterThan(0.9);
  // a white-out: the view is used up within a few hundred metres, no deck inside the layer
  expect(a.shells.length).toBeGreaterThan(3);
  expect(a.shells.at(-1).r).toBeLessThan(400);
  expect(a.decks).toEqual([]);
  // the ground below and the sky above (right of the wing) are the same cloud: within 15 % of each other in the scene's light
  const [skyR, groundR, skyL, groundL] = a.probe;
  expect(Math.abs(groundR / skyR - 1)).toBeLessThan(0.15);
  expect(Math.abs(groundL / skyL - 1)).toBeLessThan(0.15);

  // plan 01's state while flying: the as-flown overcast at the reported base, the reported visibility
  expect(a.service.source).toEqual({ kind: 'preset', id: 'clear' });
  expect(a.service.overrides.lowCloud).toBe(1);
  expect(a.plan01.clouds.length).toBe(1);
  expect(a.plan01.clouds[0].cover).toBe(1);
  expect(a.plan01.clouds[0].baseM).toBeCloseTo(layer.baseM, 0);
  expect(a.plan01.visibilityM / header.weather.visibility.belowBaseM).toBeGreaterThan(0.9);
  expect(a.plan01.visibilityM / header.weather.visibility.belowBaseM).toBeLessThan(1.1);

  // under the reported base: out of the cloud, the base overhead as a deck, the reported visibility
  const below = await seekTo(page, layer.baseM - 60);
  expect(below.altMsl).toBeLessThan(layer.baseM);
  const b = await weatherNow(page);
  console.log('under the base', JSON.stringify({ t: below.t, alt: below.altMsl, shells: b.shells.map((s) => Math.round(s.r)), decks: b.decks, probe: b.probe, pane: b.pane }));
  expect(b.pane.inCloud).toBe(false);
  expect(b.decks).toEqual(['flight-cloud-base-solid']);
  expect(b.shells.at(-1).r).toBeGreaterThan(5000);
  // and the time it broke out is the record's
  const lastOut = header.weather.inCloud.at(-1)[1];
  expect(below.t).toBeGreaterThan(lastOut);
  expect(header.touchdownT - lastOut).toBeGreaterThan(30);

  // leaving Fly: the map's weather is the visitor's again, and the flight's cloud is gone
  await page.evaluate(async () => { await window.__skyline.flight.exit(); });
  await page.waitForFunction(() => window.__skyline.weather.source.kind === 'preset' && window.__skyline.weather.source.id === 'hazy', null, { timeout: 10_000 });
  const after = await page.evaluate(() => {
    const s = window.__skyline;
    let group = null;
    s.scene.traverse((o) => { if (o.name === 'flight-clouds') group = o; });
    return { source: s.weather.source, overrides: s.weather.overrides, inScene: !!group };
  });
  expect(after.source).toEqual(mapBefore.source);
  expect(after.overrides).toEqual(mapBefore.overrides);
  expect(after.inScene).toBe(false);
  expect(problems).toEqual([]);
});

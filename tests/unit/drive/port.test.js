// The port of the drive to plan 01's renderer (plan 02, third stretch): the parts registry and ?parts=, the env adapter
// over plan 01's clock and ephemeris, the look from env.state, and the node materials' factories.
import { describe, it, expect } from 'vitest';
import { PARTS, partsFromSearch, selectParts } from '../../../src/drive/parts.js';
import { clockOn, ephemerisOn, createEnv, createEphemeris as createDriveEphemeris, RATE_MAX, RATE_MIN } from '../../../src/drive/env.js';
import { lookFromEnv, lookAt, duskAt } from '../../../src/drive/look.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createEphemeris } from '../../../src/sky/ephemeris.js';
import { createRoadMaterials } from '../../../src/drive/roadnet/material.node.js';
import { PULL } from '../../../src/drive/roadnet/material.js';
import { lambert } from '../../../src/drive/roadside/lambert.js';
import { groundMaterial, waterMaterial } from '../../../src/world/terrain/material.js';

const LV = { origin: { lat: 36.1147, lon: -115.1728 }, tz: 'America/Los_Angeles' };

describe('parts and ?parts=', () => {
  it('lists the nine parts once each, none on the new renderer yet', () => {
    expect(PARTS.map((p) => p.id)).toEqual(['lamps', 'headlights', 'traffic', 'cabin', 'valley', 'obstruction', 'screens', 'billboards', 'weather']);
    expect(PARTS.every((p) => typeof p.load === 'function' && typeof p.node === 'boolean')).toBe(true);
  });

  it('reads ?parts=: absent is every part, none or empty is no part, a list is those', () => {
    expect(partsFromSearch('?city=lv')).toBe(null);
    expect(partsFromSearch('?parts=none')).toEqual([]);
    expect(partsFromSearch('?parts=')).toEqual([]);
    expect(partsFromSearch('?parts=lamps,%20cabin')).toEqual(['lamps', 'cabin']);
  });

  it('selects the named parts, and on the new renderer only those with node materials', () => {
    const registry = [{ id: 'a', node: true }, { id: 'b', node: false }, { id: 'c', node: true }];
    expect(selectParts({ legacy: true, registry }).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(selectParts({ legacy: false, registry }).map((p) => p.id)).toEqual(['a', 'c']);
    expect(selectParts({ legacy: true, wanted: ['b'], registry }).map((p) => p.id)).toEqual(['b']);
    expect(selectParts({ legacy: false, wanted: ['b'], registry })).toEqual([]);
    expect(selectParts({ legacy: true, wanted: [], registry })).toEqual([]);
    expect(selectParts({ legacy: false })).toEqual(PARTS.filter((p) => p.node));
  });
});

describe('the env adapter on plan 01 (env.js, decisions 4 and 5)', () => {
  it('puts the drive clock interface on the SimClock, which only the frame loop advances', () => {
    const sim = createSimClock({ zone: LV.tz, timeMs: Date.UTC(2026, 10, 22, 1) });
    const c = clockOn(sim);
    const seen = [];
    for (const t of ['seek', 'play', 'pause', 'rate', 'tick']) c.on(t, (e) => seen.push([t, e.simMs]));
    expect(c.now()).toBe(sim.timeMs);
    c.seek(Date.UTC(2026, 10, 22, 2));
    expect(sim.timeMs).toBe(Date.UTC(2026, 10, 22, 2));
    c.advance(1000); // a no-op: the app's frame loop moves the clock (step 0)
    expect(sim.timeMs).toBe(Date.UTC(2026, 10, 22, 2));
    c.setRate(1000);
    expect(sim.rate).toBe(RATE_MAX);
    c.setRate(0.01);
    expect(sim.rate).toBe(RATE_MIN);
    c.play();
    expect(c.playing).toBe(true);
    sim.advance(100);
    c.pause();
    expect(seen.map(([t]) => t)).toEqual(['seek', 'rate', 'rate', 'play', 'tick', 'pause']);
    expect(() => c.on('nope', () => {})).toThrow();
  });

  it('gives the drive ephemeris on plan 01: the sun within 0.2 degree of the stand-in, dusk on the local day', () => {
    const eph = ephemerisOn(createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: 610 }), LV.tz);
    const ref = createDriveEphemeris(LV);
    for (const t of [Date.UTC(2026, 10, 21, 20, 30), Date.UTC(2026, 5, 21, 3)]) {
      const a = eph.sun(t), b = ref.sun(t);
      expect(Math.abs(a.elevation - b.elevation)).toBeLessThan(0.2);
      expect(Math.abs(((a.azimuth - b.azimuth + 540) % 360) - 180)).toBeLessThan(0.2);
    }
    // the evening crossing of -3 degrees on the local calendar day, either side of UTC midnight
    const day = Date.UTC(2026, 10, 21, 20);
    const dusk = eph.timeOfSunElevation(-3, day, true);
    expect(Math.abs(dusk - ref.timeOfSunElevation(-3, day, true))).toBeLessThan(4 * 60000);
    expect(Math.abs(eph.timeOfSunElevation(-3, Date.UTC(2026, 10, 22, 6), true) - dusk)).toBeLessThan(1000); // 22:00 PST, same day
    expect(Number.isNaN(eph.timeOfSunElevation(95, day, true))).toBe(true);
    expect(Math.abs(eph.solarNoon(day) - ref.solarNoon(day))).toBeLessThan(2 * 60000);
  });

  it('reads the ambient light from env.state and keeps the drive port shape', () => {
    const sim = createSimClock({ zone: LV.tz, timeMs: 0 });
    const state = { sun: { altDeg: -4 }, sky: { horizontalLux: 37 } };
    const app = { clock: sim, env: { state, ephemeris: createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: 610 }), nodes: {} }, quality: { level: 'ultra', caps: {}, renderScale: 0.8, on: () => () => {} } };
    const env = createEnv({ city: LV, app });
    expect(env.legacy).toBe(false);
    expect(env.plan01).toBe(app.env);
    expect(env.lighting.ambientLux()).toBe(37);
    expect(env.lighting.ambientLux(-4.01)).toBe(37);
    expect(env.lighting.ambientLux(20)).toBeGreaterThan(10000); // another sun: the table
    expect(env.quality.preset).toBe('ultra');
    expect(env.weather.state().precipKind).toBe('none');
    expect(createEnv({ city: LV }).legacy).toBe(true);
  });
});

describe('the look from env.state (look.js lookFromEnv, decision 5)', () => {
  const state = (lux, street = 0, alt = 0) => ({ sun: { altDeg: alt, azDeg: 250 }, sky: { horizontalLux: lux }, lights: { street } });
  it('runs dusk from 0 in daylight to 1 at night on the same curve as the classic look', () => {
    expect(lookFromEnv(state(50000)).dusk).toBe(0);
    expect(lookFromEnv(state(1e-3)).dusk).toBe(1);
    let last = -1;
    for (const lux of [5000, 1000, 100, 10, 1, 0.1]) { const d = lookFromEnv(state(lux)).dusk; expect(d).toBeGreaterThanOrEqual(last); last = d; }
  });
  it('takes the lights from plan 01 and the beams from dusk, rounded like lookAt', () => {
    const l = lookFromEnv(state(3, 0.73, -5.2), { steps: 512 });
    expect(l.lights).toBe(Math.round(0.73 * 512) / 512);
    expect(l.dusk * 512).toBe(Math.round(l.dusk * 512));
    expect(l.sun).toEqual({ elevation: -5.2, azimuth: 250 });
    expect(l.ambientLux).toBe(3);
    expect(Object.keys(l).sort()).toEqual(['ambientLux', 'beams', 'dusk', 'lights', 'night', 'sun']);
    expect(lookFromEnv(state(1e-3, 1)).beams).toBe(1);
    expect(lookFromEnv(state(1e5, 0)).night).toBe(lookAt({ elevation: 40, azimuth: 0 }).night);
    expect(lookFromEnv(state(1e-3, 1)).night).toBe(duskAt(-20) >= 0.19);
  });
});

describe('node materials for the static world (decision 2)', () => {
  it('makes the road node materials with material.js\'s interface, no depth pull by default', () => {
    const m = createRoadMaterials({ anisotropy: 4 });
    expect(m.road.type).toBe('MeshLambertNodeMaterial');
    expect(m.road.isNodeMaterial).toBe(true);
    expect(m.road.pull).toBe(0);
    expect(m.road.userData.surfaceLight).toBe('road');
    expect(m.road.emissiveNode).toBeTruthy(); // the stand-in glow in physical units (glow.node.js)
    m.setLook({ beams: 1 });
    expect(m.roadNear.emissiveIntensity).toBeGreaterThan(m.road.emissiveIntensity);
    m.setHeadlights(true);
    expect(m.road.emissiveIntensity + m.roadNear.emissiveIntensity).toBe(0);
    m.dispose();
  });

  it('keys the pull into the program, so a pulled road never reuses an unpulled build', () => {
    const a = createRoadMaterials(), b = createRoadMaterials({ pull: true });
    expect(b.road.pullFraction).toBe(PULL);
    expect(a.road.customProgramCacheKey()).not.toBe(b.road.customProgramCacheKey());
    expect(a.road.customProgramCacheKey()).toBe(a.roadNear.customProgramCacheKey());
  });

  it('picks stock or node materials for the roadside, the ground and the water', () => {
    expect(lambert(true, { color: 0xffffff }).type).toBe('MeshLambertMaterial');
    const sign = lambert(false, { color: 0xffffff, emissive: 0xffffff }, 'sign');
    expect(sign.type).toBe('MeshLambertNodeMaterial');
    expect(sign.userData.surfaceLight).toBe('sign');
    expect(sign.emissiveNode).toBeTruthy();
    expect(lambert(false, { vertexColors: true }, 'support').emissiveNode).toBe(null);
    expect(groundMaterial(null).type).toBe('MeshLambertMaterial');
    expect(groundMaterial(null, { legacy: false }).type).toBe('MeshLambertNodeMaterial');
    expect(waterMaterial({ color: 0x24545a }, { legacy: false }).type).toBe('MeshPhongNodeMaterial');
  });
});

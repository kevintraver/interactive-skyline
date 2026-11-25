// The drive on plan 01's contract (plan 02, third stretch): the parts registry and ?parts=, the env port over plan 01's
// clock, the look from env.state, and the static world's materials.
import { describe, it, expect } from 'vitest';
import { PARTS, partsFromSearch, selectParts } from '../../../src/drive/parts.js';
import { clockOn, createEnv, RATE_MAX, RATE_MIN } from '../../../src/drive/env.js';
import { lookFromEnv, duskAt, isNightAt } from '../../../src/drive/look.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createEphemeris } from '../../../src/sky/ephemeris.js';
import { createRoadMaterials } from '../../../src/drive/roadnet/material.js';
import { lambert } from '../../../src/drive/roadside/lambert.js';
import { groundMaterial, waterMaterial } from '../../../src/world/terrain/material.js';

const LV = { origin: { lat: 36.1147, lon: -115.1728 }, tz: 'America/Los_Angeles' };

describe('parts and ?parts=', () => {
  it('lists the nine parts once each, as { id, load }', () => {
    expect(PARTS.map((p) => p.id)).toEqual(['lamps', 'headlights', 'traffic', 'cabin', 'valley', 'obstruction', 'screens', 'billboards', 'weather']);
    expect(PARTS.every((p) => typeof p.load === 'function' && Object.keys(p).sort().join() === 'id,load')).toBe(true);
  });

  it('reads ?parts=: absent is every part, none or empty is no part, a list is those', () => {
    expect(partsFromSearch('?city=lv')).toBe(null);
    expect(partsFromSearch('?parts=none')).toEqual([]);
    expect(partsFromSearch('?parts=')).toEqual([]);
    expect(partsFromSearch('?parts=lamps,%20cabin')).toEqual(['lamps', 'cabin']);
  });

  it('selects the named parts', () => {
    const registry = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(selectParts({ registry }).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(selectParts({ wanted: ['b'], registry }).map((p) => p.id)).toEqual(['b']);
    expect(selectParts({ wanted: [], registry })).toEqual([]);
    expect(selectParts({})).toEqual(PARTS);
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

  it('reads the ambient light from env.state and keeps the drive port shape', () => {
    const sim = createSimClock({ zone: LV.tz, timeMs: 0 });
    const state = { sun: { altDeg: -4 }, sky: { horizontalLux: 37 } };
    const app = { clock: sim, env: { state, ephemeris: createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: 610 }), nodes: {} }, quality: { level: 'ultra', caps: {}, renderScale: 0.8, on: () => () => {} } };
    const env = createEnv({ city: LV, app });
    expect(env.plan01).toBe(app.env);
    expect(env.lighting.ambientLux()).toBe(37);
    expect(env.lighting.ambientLux(-4.01)).toBe(37);
    expect(env.lighting.ambientLux(20)).toBeGreaterThan(10000); // another sun: the table
    expect(env.quality.preset).toBe('ultra');
    expect(env.weather.state().precipKind).toBe('none');
    expect(() => createEnv({ city: LV })).toThrow(/plan 01/);
  });
});

describe('the look from env.state (look.js lookFromEnv, decision 5)', () => {
  const state = (lux, street = 0, alt = 0) => ({ sun: { altDeg: alt, azDeg: 250 }, sky: { horizontalLux: lux }, lights: { street } });
  it('runs dusk from 0 in daylight to 1 at night on the clear sky\'s curve (duskAt)', () => {
    expect(lookFromEnv(state(50000)).dusk).toBe(0);
    expect(lookFromEnv(state(1e-3)).dusk).toBe(1);
    let last = -1;
    for (const lux of [5000, 1000, 100, 10, 1, 0.1]) { const d = lookFromEnv(state(lux)).dusk; expect(d).toBeGreaterThanOrEqual(last); last = d; }
  });
  it('takes the lights from plan 01 and the beams from dusk, rounded to the steps', () => {
    const l = lookFromEnv(state(3, 0.73, -5.2), { steps: 512 });
    expect(l.lights).toBe(Math.round(0.73 * 512) / 512);
    expect(l.dusk * 512).toBe(Math.round(l.dusk * 512));
    expect(l.sun).toEqual({ elevation: -5.2, azimuth: 250 });
    expect(l.ambientLux).toBe(3);
    expect(Object.keys(l).sort()).toEqual(['ambientLux', 'beams', 'dusk', 'lights', 'night', 'sun']);
    expect(lookFromEnv(state(1e-3, 1)).beams).toBe(1);
    expect(lookFromEnv(state(1e5, 0)).night).toBe(isNightAt(40));
    expect(lookFromEnv(state(1e-3, 1)).night).toBe(duskAt(-20) >= 0.19);
  });
});

describe('the static world\'s materials', () => {
  it('makes the road\'s two Lambert node materials, offered to the light as road, with no depth pull or glow', () => {
    const m = createRoadMaterials({ anisotropy: 4 });
    expect(m.road.type).toBe('MeshLambertNodeMaterial');
    expect(m.road.isNodeMaterial).toBe(true);
    expect(m.road.userData.surfaceLight).toBe('road');
    expect(m.road.emissiveNode).toBe(null);
    expect(m.road.setupModelViewProjection).toBe(m.roadNear.setupModelViewProjection);
    m.dispose();
  });

  it('makes node materials for the roadside, the ground and the water', () => {
    const sign = lambert({ color: 0xffffff }, 'sign');
    expect(sign.type).toBe('MeshLambertNodeMaterial');
    expect(sign.userData.surfaceLight).toBe('sign');
    expect(lambert({ vertexColors: true }, 'support').emissiveNode).toBe(null);
    expect(groundMaterial(null).type).toBe('MeshLambertNodeMaterial');
    expect(groundMaterial(null).userData.surfaceLight).toBe('ground');
    expect(waterMaterial({ color: 0x24545a }).type).toBe('MeshPhongNodeMaterial');
  });
});

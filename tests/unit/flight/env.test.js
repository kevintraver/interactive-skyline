// Plan 03, F0.2 as narrowed on 23 Nov 2026: src/flight/env.js is the one adapter between src/flight/ and the app. It
// passes plan 01's real objects through under stable names and stands in only for what plan 01 has not delivered.
import { describe, it, expect, vi } from 'vitest';
import { Vector3 } from 'three';
import { createSimClock } from '../../../src/sim/clock.js';
import { createTimeline } from '../../../src/sim/timeline.js';
import { createEmitter } from '../../../src/app/events.js';
import { createFlightEnv, standardAtmosphere } from '../../../src/flight/env.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const city = cities.lv;

/** A fake app: plan 01's pure clock and timeline, and the parts of everything else the flight reads. */
function fakeApp({ env: envOver = {}, ...over } = {}) {
  const clock = createSimClock({ zone: city.tz, now: () => Date.UTC(2025, 2, 15, 19), timeMs: Date.UTC(2025, 2, 15, 19) });
  const timeline = createTimeline({ clock });
  const state = { timeMs: clock.timeMs, sun: { altDeg: 40 }, weather: { tempC: 25 }, wind: new Vector3(3, 0, -4), visibilityM: 60000 };
  const env = {
    state,
    nodes: { exposure: { value: 1 }, pointSource: () => ({}) },
    lights: { register: () => () => {} },
    at: vi.fn((pos) => ({ rainRateMmH: 0, wetness: { film: 0, puddles: 0 }, cloudDensity: 0, inCloud: false, dustExtinctionPerM: 0,
      visibilityM: 60000, artificialLux: 0, tempC: 25 - 0.0065 * pos.y, wind: new Vector3(3, 0, -4) })),
    lightAt: vi.fn(() => ({ sunLux: 90000, ambientLux: 15000 })),
    ...envOver,
  };
  const loop = { add: vi.fn(() => () => {}), invalidate: vi.fn(), settle: () => Promise.resolve() };
  return { city, cityId: 'lv', clock, timeline, env, loop, invalidate: loop.invalidate, events: createEmitter(),
    pipeline: { addStage: vi.fn(() => () => {}), setCamera: vi.fn(), probe: vi.fn() }, quality: { level: 'high', profile: { level: 'high' } },
    transport: { attachJourney: vi.fn((j) => (j ? timeline.begin(j) : null)), slotAbove: {} }, ...over };
}

describe('the flight adapter', () => {
  it('passes plan 01 objects through under stable names', () => {
    const app = fakeApp();
    const fe = createFlightEnv(app);
    for (const k of ['clock', 'timeline', 'loop', 'events', 'pipeline', 'quality', 'city', 'transport']) expect(fe[k], k).toBe(app[k]);
    expect(fe.nodes).toBe(app.env.nodes);
    expect(fe.lights).toBe(app.env.lights);
    expect(fe.state).toBe(app.env.state);
    expect(fe.cityId).toBe('lv');
  });

  it('builds the city frame: heights above sea level become scene y with the base and the curve drop', () => {
    const fe = createFlightEnv(fakeApp());
    expect(fe.frame.base).toBe(620);
    expect(fe.frame.sceneY(665, 0, 0)).toBe(45);
    expect(fe.frame.sceneY(665, 250000, 0)).toBeCloseTo(45 - 250000 ** 2 / (2 * 6371000 * 7 / 6), 9);
  });

  it('reads the environment state live, not a copy taken at creation', () => {
    const app = fakeApp();
    const fe = createFlightEnv(app);
    const next = { ...app.env.state, timeMs: 1 };
    app.env.state = next;
    expect(fe.state).toBe(next);
  });

  it('attaches a journey through the transport when there is one, else straight to the timeline', () => {
    const journey = { id: 'j', label: 'J', durationS: 60, recordedStartMs: Date.UTC(2025, 2, 15, 19) };
    const app = fakeApp();
    const h = createFlightEnv(app).attachJourney(journey);
    expect(app.transport.attachJourney).toHaveBeenCalledWith(journey);
    expect(app.timeline.active).toBe(h);
    const bare = fakeApp({ transport: undefined });
    const h2 = createFlightEnv(bare).attachJourney(journey);
    expect(bare.timeline.active).toBe(h2);
    expect(h2.journey).toBe(journey);
    expect(h2.startMs).toBe(journey.recordedStartMs);
  });

  it('lightAt is plan 01 own', () => {
    const app = fakeApp();
    const pos = new Vector3(1, 2, 3);
    expect(createFlightEnv(app).lightAt(pos).sunLux).toBe(90000);
    expect(app.env.lightAt).toHaveBeenCalledWith(pos);
  });
});

describe('the air at a point', () => {
  it('follows the standard atmosphere: sea level, 11 km and 20 km', () => {
    const s = standardAtmosphere(0);
    expect(s.tempC).toBeCloseTo(15, 9);
    expect(s.pressureHPa).toBeCloseTo(1013.25, 6);
    expect(s.densityKgM3).toBeCloseTo(1.225, 3);
    const t = standardAtmosphere(11000);
    expect(t.tempC).toBeCloseTo(-56.5, 9);
    expect(t.pressureHPa).toBeCloseTo(226.32, 1);
    const u = standardAtmosphere(20000);
    expect(u.tempC).toBeCloseTo(-56.5, 9);
    expect(u.pressureHPa).toBeCloseTo(54.75, 1);
    // the speed of sound at 35,000 ft is 296.5 m/s (ICAO tables)
    expect(standardAtmosphere(10668).soundMs).toBeCloseTo(296.5, 0);
  });

  it('at() is plan 01 at() plus altitude, pressure and density, clear where plan 01 is silent', () => {
    const app = fakeApp();
    const fe = createFlightEnv(app);
    // 3,000 m above sea level over the origin
    const pos = new Vector3(0, 3000 - 620, 0);
    const a = fe.at(pos);
    expect(app.env.at).toHaveBeenCalledWith(pos);
    expect(a.altitudeM).toBeCloseTo(3000, 6);
    expect(a.tempC).toBeCloseTo(25 - 0.0065 * 2380, 9); // plan 01's own temperature
    expect(a.pressureHPa).toBeCloseTo(701.1, 0);
    expect(a.cloudDensity).toBe(0);
    expect(a.inCloud).toBe(false);
    expect(a.rainRateMmH).toBe(0);
    expect(a.wind.x).toBe(3);
  });

  it('far from the city, re-lapses plan 01\'s temperature by the true height: the scene\'s y drops with the curve', () => {
    // plan 01's at() (a stand-in) lapses the surface temperature by the scene's y; 300 km out at 9,000 m above sea
    // level the scene's y is some 7 km less than the height above the field, which made cruise 45 C too warm and kept
    // frost off the window
    const app = fakeApp();
    const fe = createFlightEnv(app);
    const pos = new Vector3(300000, fe.frame.sceneY(9000, 300000, 0), 0);
    expect(pos.y).toBeLessThan(9000 - 620 - 6000);
    const a = fe.at(pos);
    expect(Math.abs(a.altitudeM - 9000)).toBeLessThan(10); // the app's refraction sphere against the frame's drop
    expect(a.tempC).toBeCloseTo(25 - 0.0065 * (a.altitudeM - 620), 6);
    expect(fe.standIns).toEqual(expect.arrayContaining(['temperature aloft']));
  });

  it('works before plan 01 has built its first state, and with an env that has no at()', () => {
    const fe = createFlightEnv(fakeApp({ env: { state: null, at: undefined } }));
    const a = fe.at(new Vector3(0, 10668 - 620, 0));
    expect(a.tempC).toBeCloseTo(standardAtmosphere(10668).tempC, 6);
    expect(a.cloudDensity).toBe(0);
    expect(a.visibilityM).toBeGreaterThan(0);
    expect(a.wind.length()).toBe(0);
  });

  it('says what it stands in for', () => {
    const fe = createFlightEnv(fakeApp());
    expect(fe.standIns).toEqual(expect.arrayContaining(['shadows']));
    expect(fe.shadows).toBe(null);
    const withShadows = createFlightEnv(fakeApp({ shadows: { setFocus() {} } }));
    expect(withShadows.standIns).not.toContain('shadows');
  });
});

describe('the exposure while flying (exposure.js through plan 01\'s look.setPriorTerms)', () => {
  const journey = { id: 'j', label: 'J', durationS: 60, recordedStartMs: Date.UTC(2025, 2, 15, 19) };
  const night = { keyLux: 0, keyAltDeg: -30, ambientLux: 0.0006, cityLux: 1, emissionLux: 1, keyBody: 'moon', street: 1 };
  function withLook() {
    const look = { fn: null, current: {}, setPriorTerms: vi.fn((fn) => { look.fn = fn; }) };
    const app = fakeApp({ look, camera: { position: new Vector3(0, 3000, 0) } });
    return { app, look, fe: createFlightEnv(app) };
  }

  it('gives plan 01\'s look the flight\'s prior while a journey is attached, and the default back after', () => {
    const { look, fe } = withLook();
    expect(look.setPriorTerms).not.toHaveBeenCalled();
    fe.attachJourney(journey);
    expect(typeof look.fn).toBe('function');
    expect(fe.exposure.on).toBe(true);
    fe.attachJourney(journey); // a new flight: still on, not set twice
    expect(look.setPriorTerms).toHaveBeenCalledTimes(1);
    fe.attachJourney(null);
    expect(look.fn).toBe(null);
    expect(fe.exposure.on).toBe(false);
  });

  it('asks the night ground for the lamps\' light at the camera, the floor alone without one', () => {
    const { look, fe, app } = withLook();
    fe.attachJourney(journey);
    const bare = look.fn(night);
    expect(bare.lampLux).toBe(0);
    expect(bare.groundLux).toBe(0);
    expect(bare.cityLux).toBe(bare.floorLux);
    const seen = [];
    const { off } = fe.provideGroundLight({ lightAt: (p) => { seen.push(p); return { lampLux: 0.5, heightAboveGroundM: 0 }; } });
    const t = look.fn(night);
    expect(seen[0]).toBe(app.camera.position);
    expect(t.lampLux).toBeGreaterThan(0.38);
    expect(t.groundLux).toBeGreaterThan(0);
    expect(t.emissionLux).toBe(0);
    off();
    expect(look.fn(night).lampLux).toBe(0);
  });

  it('is on while the night ground is shown, with no journey (Orbit), and off once neither holds', () => {
    const { look, fe } = withLook();
    const link = fe.provideGroundLight({ lightAt: () => ({ lampLux: 0, heightAboveGroundM: 9000 }) });
    link.shown(true);
    expect(typeof look.fn).toBe('function');
    fe.attachJourney(journey);
    fe.attachJourney(null); // a recorded flight gives way to an orbit: the ground is still shown
    expect(typeof look.fn).toBe('function');
    link.shown(false);
    expect(look.fn).toBe(null);
    link.shown(true);
    link.off(); // disposed while shown
    expect(look.fn).toBe(null);
    expect(fe.exposure.on).toBe(false);
  });

  it('guards a grazing Sun only when the key is the Sun', () => {
    const { look, fe } = withLook();
    fe.attachJourney(journey);
    expect(look.fn({ ...night, keyLux: 50000, keyAltDeg: 0.2, keyBody: 'sun' }).keyAltDeg).toBeGreaterThan(3); // asin(0.06): 3.4 degrees
    expect(look.fn({ ...night, keyLux: 0.2, keyAltDeg: 0.2, keyBody: 'moon' }).keyAltDeg).toBe(0.2);
  });

  it('does nothing without plan 01\'s look (the classic renderer, tests)', () => {
    const fe = createFlightEnv(fakeApp());
    expect(() => fe.attachJourney(journey)).not.toThrow();
    expect(fe.exposure.on).toBe(false);
  });
});

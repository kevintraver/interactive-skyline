// T1.7: the env facade (plan 01, section 11.4): every EnvState key present with the right type, the stubs of 11.1,
// and the pinned and clock states of sections 4.2 and 5.6.
import { describe, it, expect } from 'vitest';
import { Vector3, Color } from 'three';
import { createEnvironment, CLASSIC_AFTERNOON, REFERENCE_NIGHT } from '../../../src/env/environment.js';
import { createSimClock } from '../../../src/sim/clock.js';
import { createEphemeris } from '../../../src/sky/ephemeris.js';
import { PINNED_NIGHT } from '../../../src/app/settings.js';

const LV = { origin: { lat: 36.1147, lon: -115.1728 }, base: 620, tz: 'America/Los_Angeles' };

function make({ night = false } = {}) {
  const clock = createSimClock({ zone: LV.tz, now: () => Date.UTC(2026, 5, 21, 19), timeMs: Date.UTC(2026, 5, 21, 19) });
  const ephemeris = createEphemeris({ lat: LV.origin.lat, lon: LV.origin.lon, elevationM: LV.base });
  const settings = { night, cutoff: 35 };
  const env = createEnvironment({ city: LV, clock, ephemeris, settings });
  env.update();
  return { clock, env, settings };
}

const num = 'number', vec = (v) => v instanceof Vector3, col = (v) => v instanceof Color;
const body = { dir: vec, azDeg: num, altDeg: num, illuminanceLux: num, color: col, angularRadiusRad: num, aboveHorizon: 'boolean' };
const SHAPE = {
  timeMs: num, seed: num,
  sun: body,
  moon: { ...body, phaseFraction: num },
  key: { body: (v) => ['sun', 'moon', 'none'].includes(v), dir: vec, illuminanceLux: num, color: col },
  sky: { ambientLux: num, horizontalLux: num, zenithCdM2: num, magArcsec2: num, bortle: num, limitingMag: num,
    phase: (v) => ['day', 'civil', 'nautical', 'astronomical', 'night'].includes(v) },
  exposure: { ev100: num, scale: num },
  lights: { cityFactor: num, windows: num, street: num, signs: num },
  weather: { t: num, tempC: num, visibilityM: num, clouds: Array.isArray, precip: 'object', wind: 'object' },
  wind: vec, visibilityM: num,
  rain: { rateMmH: num, fallSpeedMs: num, streakM: num },
  wetness: { film: num, puddles: num },
  lightning: { flash: num, last: (v) => v === null || typeof v === 'object' },
};
/** Every key in `shape` is present in `value` with the right type; returns the paths that are not. */
function mismatches(value, shape, at = 'state') {
  const out = [];
  for (const [k, want] of Object.entries(shape)) {
    const v = value?.[k], path = `${at}.${k}`;
    if (!(k in Object(value))) out.push(`${path} missing`);
    else if (typeof want === 'string' ? typeof v !== want : typeof want === 'function' ? !want(v) : !!mismatches(v, want, path).length) {
      out.push(...(typeof want === 'object' ? mismatches(v, want, path) : [`${path} is ${JSON.stringify(v)}`]));
    }
  }
  return out;
}

describe('env.state', () => {
  it('has every EnvState key with the right type, pinned and in the clock state', () => {
    const { env } = make();
    expect(mismatches(env.state, SHAPE)).toEqual([]);
    env.enterClock();
    env.update();
    expect(mismatches(env.state, SHAPE)).toEqual([]);
  });

  it('carries the stubs of section 11.1 until their phases land', () => {
    const { env } = make();
    env.enterClock();
    env.update();
    const s = env.state;
    expect(s.lights.cityFactor).toBe(1);
    expect(s.exposure.scale).toBe(1);
    expect(s.rain.rateMmH).toBe(0);
    expect(s.wetness).toEqual({ film: 0, puddles: 0 });
    expect(s.lightning).toEqual({ flash: 0, last: null });
    expect(s.wind.length()).toBe(0);
    expect(s.weather.source.surface).toBe('preset');
    expect(env.nightlights.radiance(0, 0)).toBe(0);
    expect(env.lightning.strikesBetween(0, 1e12)).toEqual([]);
    const local = env.at(new Vector3(0, 100, 0));
    expect(local).toMatchObject({ rainRateMmH: 0, cloudDensity: 0, inCloud: false, artificialLux: 0 });
    expect(Object.keys(env.lightAt(new Vector3())).sort()).toEqual(['ambientLux', 'moonColor', 'moonLux', 'sunColor', 'sunLux']);
    expect(typeof env.nodes.emissive).toBe('function');
    expect(typeof env.lights.register).toBe('function');
    expect(typeof env.exposure.setMeteringMask).toBe('function');
    expect(typeof env.precipitation.setShelter).toBe('function');
  });

  it('colours have luminance 1 and directions are unit vectors', () => {
    const { env } = make();
    env.enterClock();
    env.update();
    const Y = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(Y(env.state.sun.color)).toBeCloseTo(1, 6);
    expect(Y(env.state.moon.color)).toBeCloseTo(1, 6);
    expect(env.state.sun.dir.length()).toBeCloseTo(1, 9);
  });
});

describe('pinned and clock states', () => {
  it('opens pinned on the classic afternoon: the Sun at 245 deg, 32 deg, as the app has always drawn it', () => {
    const { env } = make();
    expect(env.mode).toBe('pinned');
    expect(env.state.timeMs).toBe(CLASSIC_AFTERNOON);
    expect(env.state.sun.azDeg).toBe(245);
    expect(env.state.sun.altDeg).toBe(32);
    expect(env.state.key.body).toBe('sun');
  });

  it('pinned night is the reference night, keyed by today\'s stand-in moon at the same direction', () => {
    const { env } = make({ night: true });
    expect(env.state.timeMs).toBe(REFERENCE_NIGHT);
    expect(env.state.sun.altDeg).toBeLessThan(-30);
    expect(env.state.key.body).toBe('moon');
    expect(env.state.sky.phase).toBe('night');
  });

  it('the clock state follows the clock and derives settings.night from the Sun, without persisting it', () => {
    const { env, clock, settings } = make({ night: false });
    env.enterClock();
    expect(env.mode).toBe('clock');
    clock.set(Date.UTC(2026, 5, 21, 19)); // noon PDT
    env.update();
    expect(env.state.timeMs).toBe(clock.timeMs);
    expect(env.state.sun.altDeg).toBeGreaterThan(70);
    expect(settings.night).toBe(false);
    clock.set(Date.UTC(2026, 5, 22, 7)); // midnight PDT
    env.update();
    expect(settings.night).toBe(true);
    // what would be saved is the pinned value, not the derived one
    expect(settings[PINNED_NIGHT]).toBe(false);
    expect(JSON.parse(JSON.stringify(settings)).night).toBe(true); // (saveSettings replaces it with the pinned value)
  });

  it('night means the Sun more than 6 degrees down', () => {
    const { env, clock, settings } = make();
    env.enterClock();
    const ev = env.ephemeris.timeOfSunAltitude(-6, Date.UTC(2026, 5, 21, 7), 'setting');
    clock.set(ev - 60000);
    env.update();
    expect(settings.night).toBe(false);
    clock.set(ev + 60000);
    env.update();
    expect(settings.night).toBe(true);
  });

  it('pin() returns to a pinned look, pauses the clock and restores a plain, persisted setting', () => {
    const { env, clock, settings } = make();
    env.enterClock();
    clock.play();
    env.pin(true);
    expect(env.mode).toBe('pinned');
    expect(clock.playing).toBe(false);
    expect(settings.night).toBe(true);
    expect(Object.getOwnPropertyDescriptor(settings, 'night').value).toBe(true);
    expect(PINNED_NIGHT in settings).toBe(false);
    env.update();
    expect(env.state.timeMs).toBe(REFERENCE_NIGHT);
  });

  it('writing settings.night in the clock state selects that pinned look', () => {
    const { env, settings } = make();
    env.enterClock();
    settings.night = false;
    expect(env.mode).toBe('pinned');
    expect(settings.night).toBe(false);
  });

  it('emits mode and night changes', () => {
    const { env, clock } = make();
    const seen = [];
    env.on('mode', () => seen.push(`mode:${env.mode}`));
    env.on('night', (night) => seen.push(`night:${night}`));
    env.enterClock();
    clock.set(Date.UTC(2026, 5, 22, 7));
    env.update();
    env.pin(false);
    expect(seen).toEqual(['mode:clock', 'night:true', 'mode:pinned']);
  });
});

describe('freeze', () => {
  it('pins the time, the Sun, the seed and the lights; unfreeze follows the clock again', () => {
    const { env, clock } = make();
    env.freeze({ time: '2026-03-19T05:00:00Z', seed: 7, lights: 0.25 });
    env.update();
    expect(env.mode).toBe('clock');
    expect(env.state.timeMs).toBe(REFERENCE_NIGHT);
    expect(env.state.seed).toBe(7);
    expect(env.state.lights.cityFactor).toBe(0.25);
    env.freeze({ sunAzAlt: [100, 20] });
    env.update();
    expect(env.state.sun.azDeg).toBe(100);
    expect(env.state.sun.altDeg).toBe(20);
    expect(env.state.key.body).toBe('sun');
    env.unfreeze();
    env.update();
    expect(env.state.timeMs).toBe(clock.timeMs);
    expect(env.state.lights.cityFactor).toBe(1);
  });
});

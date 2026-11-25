// The cabin's own light (plan 03, section 7.7 "Light inside the cabin"; F5.5, F5.6): drawn in its own pass with no
// scene lights, so everything it receives is here. Expected values: hand computations from the stated models.
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { windowLuminance, cabinLightLevel, sunThroughWindow, CABIN_LIGHT, GROUND_ALBEDO, cabinIlluminance, nightShare, NIGHT_SCENE, createModelledCabin } from '../../../src/flight/cabin/cabin.js';
import { ambientLux } from '../../../src/drive/env.js';
import { seat as seatOf } from '../../../src/flight/cabin/lopa.js';
import { FUSELAGE, WINDOW, bodyZ } from '../../../src/flight/aircraft/dimensions.js';
import { RING } from '../../../src/flight/window/paneFrame.js';

const AXIS = FUSELAGE.axisY, R = 1.868;
/** The centre of a window on the right side at body z, on the outer pane. */
const windowCentre = (z) => new Vector3(R * Math.cos(RING), AXIS + R * Math.sin(RING), z);

describe('windowLuminance', () => {
  it('half sky, half sunlit ground', () => {
    const L = windowLuminance({ sunLux: 100000, ambientLux: 15000, sunAltDeg: 30 });
    const sky = 15000 / Math.PI, ground = (GROUND_ALBEDO * (100000 * 0.5 + 15000)) / Math.PI;
    expect(L).toBeCloseTo(0.5 * (sky + ground), 6);
  });
  it('is near nothing on a moonless night, and never negative', () => {
    expect(windowLuminance({ sunLux: 0, ambientLux: 0.002, sunAltDeg: -30 })).toBeLessThan(0.001);
    expect(windowLuminance({ sunLux: 5, ambientLux: 1, sunAltDeg: -3 })).toBeGreaterThanOrEqual(0);
  });
});

describe('cabinLightLevel', () => {
  it('by day the channel as it is; at night dimmed, and the landing setting dark but not black', () => {
    expect(cabinLightLevel(1, false)).toBe(1);
    expect(cabinLightLevel(0.3, false)).toBeCloseTo(0.3, 9);
    expect(cabinLightLevel(1, true)).toBeCloseTo(CABIN_LIGHT.nightFull, 9);
    // the baked night arrivals dim to 0.3 for the approach (data/flights): 2 to 3.5 % of the day's light (it was
    // 0.4 % with a cubic dimmer, and the cabin drew black from 10,000 ft down: F8.1, 25 Nov 2026)
    expect(cabinLightLevel(0.3, true)).toBeGreaterThan(0.02);
    expect(cabinLightLevel(0.3, true)).toBeLessThan(0.035);
    expect(cabinLightLevel(0, true)).toBe(0);
  });
  it('takes a share of night between 0 and 1, and moves through it without a step', () => {
    expect(cabinLightLevel(1, 0)).toBe(1);
    expect(cabinLightLevel(1, 1)).toBeCloseTo(CABIN_LIGHT.nightFull, 9);
    let prev = cabinLightLevel(1, 0);
    for (let n = 0.02; n <= 1.0001; n += 0.02) {
      const l = cabinLightLevel(1, n);
      expect(l).toBeLessThanOrEqual(prev);
      expect(l / prev).toBeGreaterThan(0.94); // no more than 6 % in a fiftieth of the twilight
      prev = l;
    }
  });
});

describe("nightShare: the crew's night setting follows the light outside, not the moment of sunset", () => {
  // the window's luminance for a clear sky at a Sun elevation (the cabin's own windowLuminance over the clear-sky
  // illuminance the lamps' photocells use)
  const atSun = (el) => windowLuminance({ sunLux: 0, ambientLux: ambientLux(el), sunAltDeg: el });
  it('day above Sun +2 degrees, night below -4, in between through the twilight', () => {
    expect(nightShare(atSun(5))).toBe(0);
    expect(nightShare(atSun(2.5))).toBe(0);
    expect(nightShare(atSun(-4.5))).toBe(1);
    expect(nightShare(atSun(-10))).toBe(1);
    const dusk = nightShare(atSun(-1.5)); // lv-19-dusk on short final
    expect(dusk).toBeGreaterThan(0.3);
    expect(dusk).toBeLessThan(0.9);
    expect(nightShare(atSun(-0.1))).toBeLessThan(dusk);
    expect(nightShare(atSun(-0.1))).toBeGreaterThan(0);
  });
  it('is 1 when nothing comes through the window and 0 for a bright one; NIGHT_SCENE names the ends', () => {
    expect(nightShare(0)).toBe(1);
    expect(nightShare(1e5)).toBe(0);
    expect(NIGHT_SCENE.dayCdM2).toBeGreaterThan(NIGHT_SCENE.nightCdM2);
  });
  it('the cabin at sunset (Sun 0) is already dimmer than by day: no step when the Sun crosses the horizon', () => {
    const above = cabinLightLevel(1, nightShare(atSun(0.05))), below = cabinLightLevel(1, nightShare(atSun(-0.05)));
    expect(above).toBeLessThan(0.9);
    expect(Math.abs(above - below) / above).toBeLessThan(0.03);
  });
});

describe('createModelledCabin().update: the dimmer from the outside light', () => {
  const nodes = { emissive: (v) => v };
  it("uses the window's light when it is given, the night flag when it is not", () => {
    const c = createModelledCabin({ nodes, seat: seatOf('23F'), load: () => new Promise(() => {}) });
    c.update(null, { cabinLight: 1, night: false, outside: { windowL: Math.sqrt(NIGHT_SCENE.dayCdM2 * NIGHT_SCENE.nightCdM2) } });
    expect(c.light.night).toBeGreaterThan(0.2);
    expect(c.light.night).toBeLessThan(0.8);
    expect(c.light.level).toBeLessThan(1);
    c.update(null, { cabinLight: 1, night: true });
    expect(c.light.night).toBe(1);
    c.dispose();
  });
});

describe('cabinIlluminance', () => {
  it('a wall corner that sees the window by day is lit by the window, not by the cabin lights', () => {
    const day = cabinIlluminance({ formFactor: 0.15, occlusion: 0.8, wash: 0.3, windowL: 5000, level: 1 });
    expect(day.window).toBeGreaterThan(10 * day.lamps);
  });
  it('at night with the lights on the lamps light it, dim; for landing it is near dark', () => {
    const on = cabinIlluminance({ formFactor: 0.15, occlusion: 0.8, wash: 0.3, windowL: 0.01, level: cabinLightLevel(1, true) });
    const landing = cabinIlluminance({ formFactor: 0.15, occlusion: 0.8, wash: 0.3, windowL: 0.01, level: cabinLightLevel(0.3, true) });
    expect(on.total).toBeGreaterThan(5);
    expect(on.total).toBeLessThan(60);
    expect(landing.total).toBeLessThan(3);
  });
  it("dimmed for a night landing, the sidewall is a dim shape: at least the cabin's emergency lighting, under the city outside", () => {
    // the shell's wall (cabin.js modelledShell: formFactor 0.05, occlusion 0.85, wash 0.15), albedo of its colour
    // 0xd8d5ce (linear 0.69), no light through the window (a moonless night far from the city)
    const E = cabinIlluminance({ formFactor: 0.05, occlusion: 0.85, wash: 0.15, windowL: 0, level: cabinLightLevel(0.3, true) }).total;
    // 14 CFR 25.812(c): the emergency lighting alone gives the aisle at least 0.05 foot-candle (0.54 lux) on average;
    // a cabin dimmed for landing is not darker than that (ESTIMATED: no published figure for the dimmed setting)
    expect(E).toBeGreaterThan(0.54);
    const L = (0.69 * E) / Math.PI;
    // no brighter than the valley seen from final (0.1 to 0.6 cd/m^2 before exposure, measured in the app on 25 Nov
    // 2026): the wall reads as a shape, and its reflection (under 8 % of it) stays far under the view. The shell's far
    // wall is the cabin's brightest; the window's own sidewall, deeper in the bins' shadow, measured 7.6 cd/m^2 per
    // unit of level in the app, 0.19 here
    expect(L).toBeGreaterThan(0.09);
    expect(L).toBeLessThan(0.6);
    expect(7.6 * cabinLightLevel(0.3, true)).toBeGreaterThan(0.09);
  });
});

describe('sunThroughWindow', () => {
  const zs = [bodyZ(10), bodyZ(10.508), bodyZ(11.016)];
  const windows = zs.map((z) => ({ z, closed: 0 }));
  it('a point inboard of a window, the Sun straight through it: lit', () => {
    const c = windowCentre(zs[1]);
    const toSun = new Vector3(Math.cos(RING), Math.sin(RING), 0).normalize();
    const p = c.clone().addScaledVector(toSun, -1.2); // 1.2 m inboard along the line to the Sun
    expect(sunThroughWindow(p, toSun, windows, 'right', { radius: R })).toBeCloseTo(1, 6);
  });
  it('the same ray hitting the wall between two windows: dark', () => {
    const between = (zs[0] + zs[1]) / 2;
    const toSun = new Vector3(Math.cos(RING), Math.sin(RING), 0).normalize();
    const p = windowCentre(between).addScaledVector(toSun, -1.2);
    expect(sunThroughWindow(p, toSun, windows, 'right', { radius: R })).toBe(0);
  });
  it('the Sun on the other side of the aircraft: no window of this side lets it in', () => {
    const toSun = new Vector3(-Math.cos(RING), Math.sin(RING), 0).normalize();
    const p = windowCentre(zs[1]).add(new Vector3(-1.2, -0.5, 0));
    expect(sunThroughWindow(p, toSun, windows, 'right', { radius: R })).toBe(0);
  });
  it('a closed shade stops it; a half-closed one stops the upper half of the window', () => {
    const toSun = new Vector3(Math.cos(RING), Math.sin(RING), 0).normalize();
    const shut = windows.map((w, i) => ({ ...w, closed: i === 1 ? 1 : 0 }));
    const p = windowCentre(zs[1]).addScaledVector(toSun, -1.2);
    expect(sunThroughWindow(p, toSun, shut, 'right', { radius: R })).toBe(0);
    const half = windows.map((w, i) => ({ ...w, closed: i === 1 ? 0.5 : 0 }));
    // through the window's upper part (3 cm below its top edge along the ring): shaded
    const up = new Vector3(-Math.sin(RING), Math.cos(RING), 0);
    const pUp = windowCentre(zs[1]).addScaledVector(up, WINDOW.height / 2 - 0.03).addScaledVector(toSun, -1.2);
    expect(sunThroughWindow(pUp, toSun, half, 'right', { radius: R })).toBe(0);
    const pLow = windowCentre(zs[1]).addScaledVector(up, -WINDOW.height / 2 + 0.05).addScaledVector(toSun, -1.2);
    expect(sunThroughWindow(pLow, toSun, half, 'right', { radius: R })).toBeGreaterThan(0.9);
  });
  it('the window\'s own structure (where the ray leaves within a centimetre) gets no patch, steadily; a few cm in, it does', () => {
    // the reveal and the frame reach out to the skin (1.88 m): "in the window or not" flipped from pixel to pixel there
    const toSun = new Vector3(Math.cos(RING), Math.sin(RING), 0.3).normalize();
    const out = new Vector3(Math.cos(RING), Math.sin(RING), 0);
    const at = (r) => new Vector3(0, FUSELAGE.axisY, zs[1] - WINDOW.width / 2 + 0.03).addScaledVector(out, r);
    for (const r of [1.86, 1.865, 1.868, 1.87, 1.875, 1.879]) expect(sunThroughWindow(at(r), toSun, windows, 'right', { radius: R })).toBe(0);
    expect(sunThroughWindow(at(1.78), toSun, windows, 'right', { radius: R })).toBeGreaterThan(0.9);
  });
  it('the Sun behind the point (pointing inboard): nothing', () => {
    const toSun = new Vector3(-Math.cos(RING), -Math.sin(RING), 0);
    const p = windowCentre(zs[1]).addScaledVector(toSun, 1.2);
    expect(sunThroughWindow(p, toSun, windows, 'right', { radius: R })).toBe(0);
  });
});

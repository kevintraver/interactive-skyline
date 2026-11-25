// The cabin's own light (plan 03, section 7.7 "Light inside the cabin"; F5.5, F5.6): drawn in its own pass with no
// scene lights, so everything it receives is here. Expected values: hand computations from the stated models.
import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { windowLuminance, cabinLightLevel, sunThroughWindow, CABIN_LIGHT, GROUND_ALBEDO, cabinIlluminance } from '../../../src/flight/cabin/cabin.js';
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
  it('by day the channel as it is; at night dimmed, and the landing setting near dark', () => {
    expect(cabinLightLevel(1, false)).toBe(1);
    expect(cabinLightLevel(0.3, false)).toBeCloseTo(0.3, 9);
    expect(cabinLightLevel(1, true)).toBeCloseTo(CABIN_LIGHT.nightFull, 9);
    // the baked night arrivals dim to 0.3 for the approach (data/flights): under 1 % of the day's light
    expect(cabinLightLevel(0.3, true)).toBeLessThan(0.01);
    expect(cabinLightLevel(0, true)).toBe(0);
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
    expect(landing.total).toBeLessThan(1);
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

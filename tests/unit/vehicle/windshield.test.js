// The windshield, first part (plan 02, D4.4): the veil's phase function and D4.4's two acceptance numbers, through
// the JavaScript mirror of the shader's arithmetic (veil.js); the dirt mask; the glass's reflectance.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VEIL, phaseVeil, veilLuminance, veilModel, veilAt, sunNormalLux, airMass, sunOnGlass, glassReflectance, headLampCandela,
  windshieldMask, wiperDepth, WIPERS,
} from '../../../src/drive/vehicle/veil.js';
import { ambientLux } from '../../../src/drive/env.js';

const meta = JSON.parse(readFileSync(new URL('../../../public/models/drive/cabin.json', import.meta.url), 'utf8'));
const RAD = Math.PI / 180;
const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
const { bottomLeft: BL, bottomRight: BR, topLeft: TL } = meta.windshield.corners;
// the glass's outward normal (up and forward: away from the driver)
let glassOut = norm(cross(sub(BR, BL), sub(TL, BL)));
if (glassOut[1] < 0) glassOut = glassOut.map((x) => -x);
/** A direction in cabin coordinates (x right, y up, -z forward) at `az` degrees right of ahead and `el` up. */
const dirAt = (az, el) => [Math.sin(az * RAD) * Math.cos(el * RAD), Math.sin(el * RAD), -Math.cos(az * RAD) * Math.cos(el * RAD)];
const AHEAD = dirAt(0, 0);
const ROAD_ALBEDO = 0.15;
/** The road's luminance (cd/m^2) under the sun and sky at an elevation: a Lambert surface of albedo 0.15. */
const road = (el) => (ROAD_ALBEDO * ambientLux(el)) / Math.PI;

describe('the veil\'s phase function', () => {
  it('is the Stiles-Holladay form within a factor of two from 1 to 30 degrees, finite at the source, zero behind', () => {
    for (let th = 1; th <= 30; th += 0.5) {
      const ratio = veilLuminance({ E: 1000, thetaDeg: th }) / veilModel({ E: 1000, thetaDeg: th });
      expect(ratio, `${th} deg`).toBeGreaterThan(0.5);
      expect(ratio, `${th} deg`).toBeLessThan(2);
    }
    expect(Number.isFinite(phaseVeil(1))).toBe(true);
    expect(phaseVeil(1)).toBeCloseTo(1 / (VEIL.THETA_C * VEIL.THETA_C), 6);
    expect(phaseVeil(Math.cos(91 * RAD))).toBe(0);
    expect(phaseVeil(-1)).toBe(0);
    // decreasing in angle
    let prev = Infinity;
    for (let th = 0; th < 90; th += 1) { const p = phaseVeil(Math.cos(th * RAD)); expect(p).toBeLessThan(prev); prev = p; }
  });

  it('the sun\'s direct normal illuminance is about 100 klux high and some 15 klux at 5 degrees, nothing below the horizon', () => {
    expect(airMass(90)).toBeCloseTo(1, 2);
    expect(airMass(5)).toBeGreaterThan(9);
    expect(airMass(5)).toBeLessThan(12);
    expect(sunNormalLux(90)).toBeGreaterThan(95000);
    expect(sunNormalLux(90)).toBeLessThan(110000);
    expect(sunNormalLux(5)).toBeGreaterThan(10000);
    expect(sunNormalLux(5)).toBeLessThan(25000);
    // never more than the whole horizontal illuminance allows (the direct beam's horizontal share)
    for (const el of [2, 5, 10, 30, 60]) expect(sunNormalLux(el) * Math.sin(el * RAD)).toBeLessThan(ambientLux(el));
    expect(sunNormalLux(-1)).toBe(0);
  });
});

describe('D4.4 acceptance', () => {
  it('sun 5 degrees up, 10 degrees off the heading: the veil is within a factor of two of the scattering model (7.6)', () => {
    const sunDir = dirAt(10, 5);
    for (const mask of [0.2, 0.6, 1]) {
      const v = veilAt({ view: AHEAD, sunDir, glassOut, sunElevation: 5, mask });
      const theta = Math.acos(AHEAD[0] * sunDir[0] + AHEAD[1] * sunDir[1] + AHEAD[2] * sunDir[2]) / RAD;
      expect(theta).toBeCloseTo(11.17, 1);
      const model = veilModel({ E: sunNormalLux(5), thetaDeg: theta, mask });
      expect(v.total / model).toBeGreaterThan(0.5);
      expect(v.total / model).toBeLessThan(2);
    }
    // and it is strong: on swept glass it is a good share of the road's own luminance
    const v = veilAt({ view: AHEAD, sunDir, glassOut, sunElevation: 5, mask: 0.2 });
    expect(v.total / road(5)).toBeGreaterThan(0.1);
  });

  it('sun behind: the veil is under 1% of the scene\'s luminance, through the dustiest glass', () => {
    for (const el of [3, 5, 10, 20, 40, 60]) {
      for (const az of [150, 180, 210]) {
        const v = veilAt({ view: AHEAD, sunDir: dirAt(az, el), glassOut, sunElevation: el, mask: 1 });
        expect(v.total / road(el), `el ${el} az ${az}`).toBeLessThan(0.01);
      }
    }
    // looking down at the road through the glass too
    const v = veilAt({ view: norm(dirAt(0, -6)), sunDir: dirAt(180, 10), glassOut, sunElevation: 10, mask: 1 });
    expect(v.total / road(10)).toBeLessThan(0.01);
  });

  it('the roof shades the glass from a sun behind; a sun ahead lights it', () => {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(sunOnGlass(dot(dirAt(180, 20), glassOut))).toBe(0);
    expect(sunOnGlass(dot(dirAt(0, 5), glassOut))).toBe(1);
    expect(sunOnGlass(dot(dirAt(10, 5), glassOut))).toBe(1);
  });
});

describe('oncoming head lamps', () => {
  it('800 cd toward an eye on the axis, falling with a cos^6 lobe; a soft glare around each', () => {
    expect(headLampCandela(1)).toBe(800);
    expect(headLampCandela(Math.cos(20 * RAD))).toBeCloseTo(800 * Math.cos(20 * RAD) ** 6, 6);
    expect(headLampCandela(-0.2)).toBe(0);
    // a pair at 40 m: under a lux at the eye; the glare 2 degrees off the lamp is a fraction of a cd/m^2
    const E = 800 / 1600;
    expect(veilLuminance({ E, thetaDeg: 2, mask: 0.2 })).toBeLessThan(1);
    expect(veilLuminance({ E, thetaDeg: 2, mask: 0.2 })).toBeGreaterThan(0.05);
  });
});

describe('the glass and the dirt', () => {
  it('reflects about 8% at normal incidence (both faces) and more toward grazing', () => {
    expect(glassReflectance(1)).toBeGreaterThan(0.075);
    expect(glassReflectance(1)).toBeLessThan(0.09);
    expect(glassReflectance(Math.cos(60 * RAD))).toBeGreaterThan(glassReflectance(1));
    expect(glassReflectance(Math.cos(89 * RAD))).toBeGreaterThan(0.8);
  });

  it('the mask is deterministic, cleaner in the wiper arcs than outside them, and in 0..1', () => {
    const W = 128, H = 64, size = [1.665, 0.816];
    const a = windshieldMask({ width: W, height: H, size }), b = windshieldMask({ width: W, height: H, size });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    let inS = 0, inN = 0, outS = 0, outN = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = ((i + 0.5) / W) * size[0], y = ((j + 0.5) / H) * size[1];
        const d = Math.max(...WIPERS.map((w) => wiperDepth(x, y, w)));
        const m = a[j * W + i] / 255;
        if (d > 0.03) { inS += m; inN++; } else if (d < -0.05) { outS += m; outN++; }
      }
    }
    expect(inN).toBeGreaterThan(W * H * 0.25); // the arcs cover a good part of the glass
    expect(inS / inN).toBeLessThan(0.3);
    expect(outS / outN).toBeGreaterThan(0.55);
    // the driver's view straight ahead (the eye is above x = 0.46 m of the glass) is swept
    expect(wiperDepth(0.4625, 0.4, WIPERS[0])).toBeGreaterThan(0);
  });
});

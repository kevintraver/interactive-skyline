// D5.4 and D5.5, model side: lamp types, ground illuminance, pool maps, sprites and sodium warm-up
// (src/drive/lights/lamps.js).
import { describe, it, expect } from 'vitest';
import {
  createLampTypes, illuminanceAt, splatPool, poolAt, spriteFlux, decodeLampRecords, opticOf, uvFromXyz, xyzFromUv,
} from '../../../src/drive/lights/lamps.js';

// The fields lamps.js reads, as data/lamp_types.json has them in the lamp inventory's branch (commit 6520fa5);
// the file itself arrives with that merge and is passed in parsed, as the app will.
const LAMP_TYPES_JSON = {
  mountDefaultM: 9.14,
  types: [
    { id: 0, key: 'hps', name: 'High-pressure sodium', class: 'sodium', cctK: 2100, lmPerW: { 100: 95, 250: 110 }, defaultWatts: 150, uplight: 0.03 },
    { id: 1, key: 'led_street', name: 'LED street light', class: 'led', cctK: 4000, lmPerW: 90, defaultWatts: 100, uplight: 0.0 },
    { id: 2, key: 'led_highmast', name: 'LED high mast', class: 'led', cctK: 4000, lmPerW: 90, defaultWatts: 302, uplight: 0.0, mountM: 21.3 },
    { id: 3, key: 'induction', name: 'Induction', class: 'other', cctK: 4000, lmPerW: 67, defaultWatts: 89, uplight: 0.02 },
    { id: 5, key: 'mercury_vapor', name: 'Mercury vapour', class: 'other', cctK: 5000, lmPerW: 50, defaultWatts: 175, uplight: 0.05 },
    { id: 7, key: 'unknown', name: 'Unknown lamp', class: 'other', cctK: 3000, lmPerW: 80, defaultWatts: 100, uplight: 0.03 },
  ],
};
const types = createLampTypes(LAMP_TYPES_JSON);
const RAD = Math.PI / 180;

/** Flux of an intensity function, by a grid uniform in cos(theta) and phi (an independent rule from the module's). */
function flux(fn, nu = 1440, np = 360) {
  let s = 0;
  const du = 2 / nu, dp = 360 / np;
  for (let i = 0; i < nu; i++) {
    const theta = Math.acos(1 - (i + 0.5) * du) / RAD; // u = cos(theta) from 1 (nadir) to -1 (zenith)
    for (let k = 0; k < np; k++) s += fn(theta, -180 + (k + 0.5) * dp) * du * dp * RAD;
  }
  return s;
}

describe('lamp types', () => {
  it('assigns optics and keeps the JSON fields', () => {
    expect(types.byKey.get('hps').optic).toBe('droplens');
    expect(types.byKey.get('led_street').optic).toBe('cutoff');
    expect(types.byKey.get('led_highmast').optic).toBe('highmast');
    expect(types.byKey.get('led_highmast').mountM).toBe(21.3);
    expect(types.byId.get(0).mountM).toBe(9.14);
    expect(opticOf({ key: 'x', uplight: 0, optic: 'highmast' })).toBe('highmast');
    expect(() => createLampTypes({})).toThrow();
  });

  it('has a linear render colour of luminance 1, warm for sodium and neutral for 4,000 K', () => {
    const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const hps = types.byKey.get('hps'), led = types.byKey.get('led_street');
    expect(lum(hps.color)).toBeCloseTo(1, 2);
    expect(hps.color[0] / hps.color[2]).toBeGreaterThan(4);
    expect(led.color[0] / led.color[2]).toBeGreaterThan(1);
    expect(led.color[0] / led.color[2]).toBeLessThan(3);
    expect(Math.max(...hps.colorNorm)).toBeCloseTo(1, 9);
  });

  it.each(types.list.map((t) => [t.key, t]))('%s: I(theta, phi) integrates to the flux within 2% (acceptance)', (_, t) => {
    const lumens = 10000;
    expect(Math.abs(flux((th, ph) => t.intensity(th, ph, lumens)) / lumens - 1)).toBeLessThan(0.02);
    expect(Math.abs(flux((th) => t.intensityAvg(th, lumens)) / lumens - 1)).toBeLessThan(0.02);
    // the share above the horizontal is the type's uplight
    const up = flux((th, ph) => (th > 90 ? t.intensity(th, ph, lumens) : 0));
    expect(up / lumens).toBeCloseTo(t.uplight, 2);
  });

  it('throws a street light along the road with a cutoff, and a high mast all round', () => {
    const led = types.byKey.get('led_street');
    expect(led.intensity(65, 0, 1)).toBeGreaterThan(2 * led.intensity(65, -90, 1)); // along road vs house side
    expect(led.intensity(65, 90, 1)).toBeGreaterThan(led.intensity(65, -90, 1)); // street side vs house side
    expect(led.intensity(91, 0, 1)).toBe(0);
    const mast = types.byKey.get('led_highmast');
    expect(mast.intensity(60, 0, 1)).toBeCloseTo(mast.intensity(60, 137, 1), 12);
    const hps = types.byKey.get('hps');
    expect(hps.intensity(98, 0, 1)).toBeGreaterThan(0); // drop-lens glow above the horizontal
  });
});

describe('ground illuminance and the pool map', () => {
  const led = types.byKey.get('led_street');
  const H = 9, LM = 10000;

  it('is the point-source law', () => {
    expect(illuminanceAt(led, LM, H, 0, 0)).toBeCloseTo(led.intensityAvg(0, LM) / (H * H), 9);
    const d2 = 100 + H * H, theta = Math.acos(H / Math.sqrt(d2)) / RAD;
    // 10 m east, arm pointing north (aim 90): east is along the road, phi = 0... -90 + 90
    expect(illuminanceAt(led, LM, H, 10, 0, 90)).toBeCloseTo((led.intensity(theta, 0, LM) * (H / Math.sqrt(d2))) / d2, 9);
    expect(illuminanceAt(led, LM, H, 0, 10, 90)).toBeCloseTo((led.intensity(theta, 90, LM) * (H / Math.sqrt(d2))) / d2, 9);
    expect(illuminanceAt(led, LM, 0, 1, 1)).toBe(0);
  });

  it('on axis a 9 m, 10,000 lm lamp gives a road-lighting level', () => {
    const e0 = illuminanceAt(led, LM, H, 0, 0);
    expect(e0).toBeGreaterThan(10); // RP-8 freeway averages are 6-10 lux (recalled); under the pole is brighter
    expect(e0).toBeLessThan(60);
  });

  it.each([[null], [30]])('splats within 10% of the analytic value on axis and 10 m out (aim %s, acceptance)', (aim) => {
    const spec = { x0: -64, y0: -64, cell: 0.5, nx: 256, ny: 256 };
    const grid = new Float32Array(spec.nx * spec.ny);
    const lamp = { x: 3.3, y: -7.1, mount: H, lumens: LM, aim };
    splatPool(grid, spec, lamp, led);
    for (const [dx, dy] of [[0, 0], [10, 0], [0, 10], [-7.07, 7.07]]) {
      const analytic = illuminanceAt(led, LM, H, dx, dy, aim);
      expect(Math.abs(poolAt(grid, spec, lamp.x + dx, lamp.y + dy) / analytic - 1)).toBeLessThan(0.1);
    }
    // splats add; outside maxRadius nothing is written
    const once = poolAt(grid, spec, lamp.x, lamp.y);
    splatPool(grid, spec, lamp, led);
    expect(poolAt(grid, spec, lamp.x, lamp.y)).toBeCloseTo(2 * once, 3);
    const small = splatPool(new Float32Array(spec.nx * spec.ny), spec, lamp, led, { maxRadius: 20 });
    expect(poolAt(small, spec, lamp.x + 30, lamp.y)).toBe(0);
  });

  it('decodes the 16-byte records of the lamps layer', () => {
    const buf = new ArrayBuffer(32), v = new DataView(buf);
    v.setInt32(0, -1500, true); v.setInt32(4, 2500, true); v.setUint16(8, 91, true); v.setUint8(10, 1); v.setUint8(11, 3);
    v.setUint16(12, 1000, true); v.setUint16(14, 9000, true);
    v.setUint16(30, 0xffff, true);
    const [a, b] = decodeLampRecords(buf);
    expect(a).toEqual({ x: -1.5, y: 2.5, mount: 9.1, type: 1, flags: 3, lumens: 10000, aim: 90 });
    expect(b.aim).toBeNull();
  });
});

describe('sprites', () => {
  // a 1920-pixel-wide view with a 60 degree field: one pixel subtends about 0.031 deg
  const pixelAngle = (60 * RAD) / 1920;
  const pixelSolidAngleSr = pixelAngle ** 2;

  /** Draw the sprite as a disk at a sub-pixel offset, 16 x 16 samples per pixel, and sum radiance x pixel solid angle. */
  function rasterised(s, ox, oy) {
    const r = s.diameterPx / 2, n = Math.ceil(r) + 2, ss = 16;
    let sum = 0;
    for (let py = -n; py <= n; py++) {
      for (let px = -n; px <= n; px++) {
        let cover = 0;
        for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
          const x = px + (i + 0.5) / ss - ox, y = py + (j + 0.5) / ss - oy;
          if (x * x + y * y <= r * r) cover++;
        }
        sum += (cover / (ss * ss)) * s.radiance * pixelSolidAngleSr;
      }
    }
    return sum;
  }

  it('keeps summed light x d^2 unchanged within 5% between 2 km and 20 km, and up close (acceptance)', () => {
    const hps = types.byKey.get('hps');
    const intensityCd = hps.intensity(85, 0, 27500); // a 250 W sodium lamp seen nearly side-on
    const back = (d, ox, oy) => rasterised(spriteFlux({ intensityCd, distanceM: d, pixelSolidAngleSr }), ox, oy) * d * d;
    const ref = back(2000, 0.13, 0.41);
    for (const [d, ox, oy] of [[2000, 0.5, 0.5], [20000, 0.21, 0.77], [20000, 0, 0], [5, 0.3, 0.1]]) {
      expect(Math.abs(back(d, ox, oy) / ref - 1)).toBeLessThan(0.05);
    }
    expect(Math.abs(ref / intensityCd - 1)).toBeLessThan(0.05);
    // at 20 km the lamp is far below a pixel: clamped size, radiance carries the light
    const far = spriteFlux({ intensityCd, distanceM: 20000, pixelSolidAngleSr });
    expect(far.diameterPx).toBe(1.5);
    const near = spriteFlux({ intensityCd, distanceM: 5, pixelSolidAngleSr });
    expect(near.diameterPx).toBeGreaterThan(100);
    expect(spriteFlux({ intensityCd, distanceM: 2000, pixelSolidAngleSr, transmittance: 0.5 }).illuminanceLux).toBeCloseTo(intensityCd / 4e6 / 2, 12);
  });
});

describe('warm-up', () => {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  it("a sodium lamp reaches within 0.005 u'v' of its steady colour in 3 to 5 minutes (acceptance)", () => {
    const hps = types.byKey.get('hps');
    let reached = NaN;
    for (let t = 0; t <= 600; t += 1) {
      if (dist(hps.warmup(t).uv, hps.steadyUv) < 0.005) { reached = t; break; }
    }
    expect(reached).toBeGreaterThanOrEqual(180);
    expect(reached).toBeLessThanOrEqual(300);
    // starts dim and pink-white, ends at full amber; flux rises monotonically
    const start = hps.warmup(0);
    expect(start.flux).toBeLessThan(0.1);
    expect(dist(start.uv, hps.steadyUv)).toBeGreaterThan(0.05);
    let prev = 0;
    for (let t = 0; t <= 600; t += 10) { const f = hps.warmup(t).flux; expect(f).toBeGreaterThanOrEqual(prev); prev = f; }
    expect(hps.warmup(600).flux).toBeCloseTo(1, 6);
    expect(hps.warmup(-1).flux).toBe(0);
  });

  it('LEDs are instant', () => {
    const led = types.byKey.get('led_street');
    expect(led.warmup(0).flux).toBe(1);
    expect(dist(led.warmup(0).uv, led.steadyUv)).toBe(0);
    expect(led.warmup(NaN).flux).toBe(0);
  });

  it("converts between XYZ and u'v'", () => {
    const xyz = [0.95047, 1, 1.08883]; // D65
    const uv = uvFromXyz(xyz);
    expect(uv[0]).toBeCloseTo(0.1978, 4);
    expect(uv[1]).toBeCloseTo(0.4683, 4);
    xyzFromUv(uv).forEach((c, i) => expect(c).toBeCloseTo(xyz[i], 6));
  });
});

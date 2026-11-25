// D5.1 and D5.2 through the JavaScript mirrors of src/drive/lights/headlamps.js (headlampMirror.js): the beam
// lookup and the retro table against beam.js and retro.js, and the acceptance numbers of both tasks.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeBeam, candelaAt, roadIlluminance, DEFAULT_LAMPS } from '../../../src/drive/lights/beam.js';
import { RETRO_TYPES, retroCoefficient, retroGeometry, retroFromHeadlamps } from '../../../src/drive/roadside/retro.js';
import {
  toHalf, fromHalf, beamTexture, beamCandela, lampPositions, headlampIrradiance, retroTable, retroTableLookup,
  retroAnglesMirror, retroReturn, RETRO_ROWS, MARKING_ROWS, signTexel, linearOf, chromaOf, luminanceOf,
} from '../../../src/drive/lights/headlampMirror.js';
import { classifyMarkings, rampOf } from '../../../src/drive/lights/markingMask.js';
import * as atlas from '../../../src/drive/roadnet/atlas.js';
import { COLOURS } from '../../../src/drive/roadside/faces.js';

const dir = new URL('../../../public/data/drive/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('beam.json', dir), 'utf8'));
const low = decodeBeam(readFileSync(new URL('beam_low.bin', dir)), meta, 'low');
const high = decodeBeam(readFileSync(new URL('beam_high.bin', dir)), meta, 'high');
const texLow = beamTexture(low), texHigh = beamTexture(high);
const table = retroTable();
const NOSE = 2.85;
const AGEING = 0.8; // headlights.js AGEING.sheeting

// a car on a heading 30 degrees off the scene's axes, 4 m up, far from the origin: the mirrors must work in the scene
const th = (30 * Math.PI) / 180;
const pose = {
  position: { x: 41000, y: 4, z: -52000 },
  forward: { x: Math.sin(th), y: 0, z: -Math.cos(th) },
  up: { x: 0, y: 1, z: 0 },
  right: { x: Math.cos(th), y: 0, z: Math.sin(th) },
};
const basis = { right: pose.right, up: pose.up, forward: pose.forward };
const lamps = lampPositions(pose, DEFAULT_LAMPS, NOSE);
/** Car frame of beam.js (lamps at z = 0, x right, y up) to the scene. */
const scene = ([x, y, z]) => ['x', 'y', 'z'].map((k) => pose.position[k] + pose.right[k] * x + pose.up[k] * y + pose.forward[k] * (z + NOSE));
const sceneDir = ([x, y, z]) => ['x', 'y', 'z'].map((k) => pose.right[k] * x + pose.up[k] * y + pose.forward[k] * z);
const EYE_CAR = [0, 1.2, -NOSE]; // the clean view's eye: on the centre line, 1.2 m up, at pose.position

describe('half floats', () => {
  it('round-trips the values the textures hold', () => {
    for (const x of [0, 1, 0.5, 1 / 3, 1e-4, 580, 0.0125, 65504]) expect(Math.abs(fromHalf(toHalf(x)) - x)).toBeLessThanOrEqual(Math.abs(x) * 5e-4 + 6e-8);
  });
});

describe('the beam lookup', () => {
  it('matches candelaAt across the map, from the scene through the car basis', () => {
    let worst = 0;
    for (let h = -44; h <= 44; h += 3.7) {
      for (let v = -14.5; v <= 9.5; v += 1.3) {
        const d = sceneDir([Math.sin(h * Math.PI / 180) * Math.cos(v * Math.PI / 180), Math.sin(v * Math.PI / 180), Math.cos(h * Math.PI / 180) * Math.cos(v * Math.PI / 180)].map((x) => x * 37));
        const want = candelaAt(low, h, v);
        const got = beamCandela(texLow, d, basis) * texLow.peakCd;
        worst = Math.max(worst, Math.abs(got - want) / (want + 20));
      }
    }
    expect(worst).toBeLessThan(2e-3);
  });

  it('is zero behind the lamps and clamps at the map edge as beam.js does', () => {
    expect(beamCandela(texLow, sceneDir([0, 0, -10]), basis)).toBe(0);
    expect(beamCandela(texLow, sceneDir([10, 0, -1]), basis)).toBe(0);
    const edge = beamCandela(texLow, sceneDir([Math.tan(60 * Math.PI / 180), 0, 1]), basis) * texLow.peakCd;
    expect(edge).toBeCloseTo(candelaAt(low, 60, 0), -1);
  });

  it('gives the illuminance of roadIlluminance on the pavement', () => {
    for (const z of [5, 10, 20, 30, 45, 60, 100]) {
      for (const x of [-3.5, 0, 1.8, 5]) {
        const want = roadIlluminance(low, DEFAULT_LAMPS, { x, y: 0, z });
        const got = headlampIrradiance({ tex: texLow, lamps, basis, point: scene([x, 0, z]), normal: [0, 1, 0] });
        expect(Math.abs(got - want)).toBeLessThanOrEqual(want * 3e-3 + 1e-6);
      }
    }
  });
});

describe('D5.1 acceptance', () => {
  it('road luminance 30 m ahead in the lane is within a factor of two of E x rho / pi', () => {
    for (const rho of [0.07, 0.12]) {
      const e = roadIlluminance(low, DEFAULT_LAMPS, { x: 0, y: 0, z: 30 });
      const want = (e * rho) / Math.PI;
      // what the shader adds: slE = E (lux) x units.lux, reflected as albedo x slE / pi; units divided out
      const got = (rho * headlampIrradiance({ tex: texLow, lamps, basis, point: scene([0, 0, 30]), normal: [0, 1, 0] })) / Math.PI;
      expect(got / want).toBeGreaterThan(0.5);
      expect(got / want).toBeLessThan(2);
      expect(e).toBeGreaterThan(0.3); // a low beam's pool: about a lux at 30 m
      expect(e).toBeLessThan(5);
    }
  });

  it('the high beam reaches farther', () => {
    const at = (tex, z) => headlampIrradiance({ tex, lamps, basis, point: scene([0, 0, z]), normal: [0, 1, 0] });
    expect(at(texHigh, 100) / at(texLow, 100)).toBeGreaterThan(3);
    // a sign face 150 m ahead, 6.5 m up (overhead): high beam several times the light
    const sign = (tex) => headlampIrradiance({ tex, lamps, basis, point: scene([0, 6.5, 150]), normal: sceneDir([0, 0, -1]) });
    expect(sign(texHigh) / sign(texLow)).toBeGreaterThan(5);
  });
});

describe('retroreflection mirrors', () => {
  it('computes alpha, beta and nu as retroGeometry does', () => {
    const cases = [[[0, 6.5, 150], [0, 0, -1]], [[12, 2.5, 50], [-0.2, 0, -1]], [[-4, 0, 30], [0, 1, 0]], [[3, 1, 8], [0, 0, -1]]];
    for (const [p, n] of cases) {
      for (const lamp of DEFAULT_LAMPS) {
        const want = retroGeometry(lamp, { x: EYE_CAR[0], y: EYE_CAR[1], z: EYE_CAR[2] }, p, n);
        const got = retroAnglesMirror(scene([lamp.x, lamp.y, lamp.z]), scene(EYE_CAR), scene(p), sceneDir(n));
        expect(got.alphaDeg).toBeCloseTo(want.alphaDeg, 5);
        expect(got.betaDeg).toBeCloseTo(want.betaDeg, 4);
        expect(got.viewAngleDeg).toBeCloseTo(want.viewAngleDeg, 4);
      }
    }
  });

  it('bakes retroCoefficient into the table: exact at the beta nodes, within 1.5% between alpha samples', () => {
    let worst = 0;
    RETRO_ROWS.forEach((name, row) => {
      const type = RETRO_TYPES[name];
      const peak = Math.max(...type.table.flat());
      for (let a = 0; a <= 4; a += 0.0173) {
        for (const b of [0, 2, 4, 10, 17, 30, 33, 40, 51, 60, 75, 90]) {
          const want = retroCoefficient(type, a, b);
          const got = retroTableLookup(table, row, a, b);
          if (want > 0.01 * peak) worst = Math.max(worst, Math.abs(got - want) / want);
          else expect(Math.abs(got - want)).toBeLessThan(0.015 * peak);
        }
      }
    });
    expect(worst).toBeLessThan(0.015);
  });

  it('returns what retroFromHeadlamps does, for a sign and a lane line', () => {
    const eye = { x: EYE_CAR[0], y: EYE_CAR[1], z: EYE_CAR[2] };
    for (const [p, n, rowName, type, marking] of [
      [[0, 6.5, 150], [0, 0, -1], 'white', 'white', false],
      [[11, 2.4, 80], [-0.15, 0, -1], 'green', 'green', false],
      [[-1.8, 0, 30], [0, 1, 0], 'markingWhite', 'markingWhite', true],
      [[1.8, 0, 60], [0, 1, 0], 'markingYellow', 'markingYellow', true],
    ]) {
      const row = RETRO_ROWS.indexOf(rowName);
      const want = retroFromHeadlamps({ type, map: low, eye, point: p, normal: n });
      const [got] = retroReturn({ tex: texLow, table, lamps, basis, eye: scene(EYE_CAR), point: scene(p), normal: sceneDir(n), rows: [row, row], marking });
      expect(Math.abs(got - want) / want).toBeLessThan(0.02);
    }
  });
});

describe('D5.2 acceptance', () => {
  const ink = ['black', 'white', 'yellow', 'red', 'green'].map((c) => linearOf(COLOURS[c] || '#b5121b'));
  const overhead = (z, tex = texLow, extra = {}) => retroReturn({
    tex, table, lamps, basis, eye: scene(EYE_CAR), point: scene([0, 6.5, z]), normal: sceneDir([0, 0, -1]), rows: [3, 0], ...extra,
  }).map((l) => l * AGEING);

  it('a white legend 150 m ahead under low beams reads 10-60 cd/m^2, its green field about a tenth', () => {
    const [green, white] = overhead(150);
    const legend = signTexel({ albedo: ink[1], bg: 4, lg: 1, ink, L: [green, white] });
    const field = signTexel({ albedo: ink[4], bg: 4, lg: 1, ink, L: [green, white] });
    expect(legend.w).toBe(1);
    expect(field.w).toBe(0);
    expect(legend.luminance).toBeGreaterThan(10);
    expect(legend.luminance).toBeLessThan(60);
    expect(field.luminance / legend.luminance).toBeGreaterThan(0.07);
    expect(field.luminance / legend.luminance).toBeLessThan(0.15);
    // and the colour the shader draws it in keeps the luminance (chroma at luminance 1)
    expect(luminanceOf(chromaOf(ink[4]))).toBeCloseTo(1, 6);
  });

  it('is dim far away and brightens as the sign nears (300 m to 100 m), and high beams flare more', () => {
    const at = (z) => overhead(z)[1];
    expect(at(300)).toBeLessThan(at(200));
    expect(at(200)).toBeLessThan(at(100) * 1.01);
    expect(overhead(150, texHigh)[1] / at(150)).toBeGreaterThan(5);
  });

  it('is exactly zero with the lamps off', () => {
    expect(overhead(150, texLow, { on: false })).toEqual([0, 0]);
    expect(overhead(150, texLow, { gain: 0 })).toEqual([0, 0]);
    const [m] = retroReturn({ tex: texLow, table, lamps, basis, eye: scene(EYE_CAR), point: scene([-1.8, 0, 30]), normal: [0, 1, 0], rows: MARKING_ROWS, marking: true, on: false });
    expect(m).toBe(0);
  });

  it('moving the eye 0.5 m sideways at 50 m changes the return by the table ratio within 15%', () => {
    // from the clean eye (between the lamps) and from the driver's seat (0.37 m left, cabin.json), both ways
    const eyes = [EYE_CAR, [EYE_CAR[0] - 0.37, EYE_CAR[1], EYE_CAR[2]]];
    for (const p of [[0, 6.5, 50], [10, 2.4, 50]]) {
      for (const e0 of eyes) {
        for (const dx of [-0.5, 0.5]) {
          const n = [0, 0, -1];
          const ret = (eyeCar) => retroReturn({ tex: texLow, table, lamps, basis, eye: scene(eyeCar), point: scene(p), normal: sceneDir(n), rows: [0, 0] })[0];
          const want = (eyeCar) => retroFromHeadlamps({ type: 'white', map: low, eye: { x: eyeCar[0], y: eyeCar[1], z: eyeCar[2] }, point: p, normal: n });
          const moved = [e0[0] + dx, e0[1], e0[2]];
          const tableRatio = want(moved) / want(e0);
          expect(Math.abs(tableRatio - 1)).toBeGreaterThan(0.03); // the move matters at all
          expect(Math.abs(ret(moved) / ret(e0) / tableRatio - 1)).toBeLessThan(0.15);
        }
      }
    }
  });
});

describe('the marking mask', () => {
  const { drawRoadAtlas, ATLAS_W, ATLAS_H, REGIONS } = atlas;
  // rasterise drawRoadAtlas into RGBA, as a canvas would
  const raster = (night) => {
    const px = new Uint8ClampedArray(ATLAS_W * ATLAS_H * 4);
    const ctx = {
      fillStyle: '#000000',
      fillRect(x, y, w, h) {
        const c = String(this.fillStyle);
        let r, g, b, a = 1;
        const m = c.match(/^rgba?\(([^)]*)\)$/);
        if (m) [r, g, b, a = 1] = m[1].split(',').map(Number);
        else [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
        for (let j = Math.max(0, Math.round(y)); j < Math.min(ATLAS_H, Math.round(y + h)); j++) {
          for (let i = Math.max(0, Math.round(x)); i < Math.min(ATLAS_W, Math.round(x + w)); i++) {
            const k = (j * ATLAS_W + i) * 4;
            px[k] = px[k] * (1 - a) + r * a; px[k + 1] = px[k + 1] * (1 - a) + g * a; px[k + 2] = px[k + 2] * (1 - a) + b * a; px[k + 3] = 255;
          }
        }
      },
    };
    drawRoadAtlas(ctx, { night });
    return px;
  };
  const centre = (name) => Math.round((REGIONS[name][0] + REGIONS[name][1]) / 2);
  const median = (xs) => [...xs].sort((p, q) => p - q)[xs.length >> 1];
  for (const source of ['night', 'day']) {
    it(`finds white and yellow paint, and nothing else, in the ${source} atlas`, () => {
      const ramp = rampOf(atlas.PAINT?.[source]?.white, source);
      const m = classifyMarkings(raster(source === 'night'), ATLAS_W, ATLAS_H, { source, skip: [REGIONS.reflector], ramp });
      const at = (x, y) => [m[(y * ATLAS_W + x) * 4], m[(y * ATLAS_W + x) * 4 + 1]];
      const column = (x, y0, y1, c) => { const v = []; for (let y = y0; y < y1; y++) v.push(at(x, y)[c]); return v; };
      const dashPx = Math.floor((atlas.DASH / atlas.CYCLE) * (ATLAS_H / (atlas.V_CYCLES || 1)));
      // worn paint lets a little asphalt through: most of a line's texels are full paint
      for (const sfx of REGIONS.solidC ? ['', 'C'] : ['']) {
        expect(median(column(centre('solid' + sfx), 0, ATLAS_H, 0))).toBe(255);
        expect(median(column(centre('broken' + sfx), 0, dashPx - 2, 0))).toBe(255);
        expect(Math.max(...column(centre('broken' + sfx), dashPx + 4, Math.floor(ATLAS_H / (atlas.V_CYCLES || 1)) - 4, 0))).toBe(0); // the gap
        expect(median(column(centre('yellow' + sfx) + 2, 0, ATLAS_H, 1))).toBe(255);
        expect(Math.max(...column(centre('yellow' + sfx) + 2, 0, ATLAS_H, 0))).toBeLessThan(60);
      }
      for (const name of Object.keys(REGIONS).filter((n) => ['lane', 'shoulder', 'dirt', 'concrete', 'steel', 'reflector', 'laneR', 'laneC', 'shoulderC', 'joint'].includes(n))) {
        let sum = 0;
        for (let y = 0; y < ATLAS_H; y += 3) for (let x = REGIONS[name][0]; x < REGIONS[name][1]; x++) sum += at(x, y)[0] + at(x, y)[1];
        expect(sum, name).toBe(0);
      }
    });
  }
});

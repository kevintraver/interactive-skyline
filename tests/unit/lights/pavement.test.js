// The pavement's return under our headlamps (plan 02, third stretch, decision 13): R_L x E_perp instead of a matte
// surface, through the mirrors of headlamps.node.js (headlampMirror.js) and the reference albedo (markingMask.js).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeBeam, DEFAULT_LAMPS } from '../../../src/drive/lights/beam.js';
import { PAVEMENT_RL, RETRO_TYPES } from '../../../src/drive/roadside/retro.js';
import { beamTexture, lampPositions, headlampIrradiance, headlampIrradiancePerp, pavementLuminance } from '../../../src/drive/lights/headlampMirror.js';
import { meanAlbedo, pavementAlbedo, PAVEMENT_ALBEDO_FALLBACK } from '../../../src/drive/lights/markingMask.js';

const dir = new URL('../../../public/data/drive/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('beam.json', dir), 'utf8'));
const tex = beamTexture(decodeBeam(readFileSync(new URL('beam_low.bin', dir)), meta, 'low'));
const pose = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 } };
const basis = { right: pose.right, up: pose.up, forward: pose.forward };
const lamps = lampPositions(pose, DEFAULT_LAMPS, 2.85);
const up = [0, 1, 0];
const ahead = (d) => [0, 0, -(2.85 + d)];

describe('PAVEMENT_RL', () => {
  it('is asphalt 15 and concrete 25 mcd/m2/lx, under the markings it must contrast with', () => {
    expect(PAVEMENT_RL.asphalt).toBe(0.015);
    expect(PAVEMENT_RL.concrete).toBe(0.025);
    // new white paint's R_L at its 30 m geometry (alpha 1.05 deg) is 0.25: ten times the brighter pavement
    expect(RETRO_TYPES.markingWhite.table[0][2]).toBeGreaterThan(5 * PAVEMENT_RL.concrete);
  });
});

describe('headlampIrradiancePerp', () => {
  it('is the Lambert illuminance over cos i at a point of the road', () => {
    for (const d of [10, 30, 60]) {
      const p = ahead(d);
      const eL = headlampIrradiance({ tex, lamps, basis, point: p, normal: up });
      const eP = headlampIrradiancePerp({ tex, lamps, basis, point: p, normal: up });
      // lamps 0.65 m up: cos i is about 0.65 / d
      expect(eP).toBeGreaterThan(eL * (d / 0.7));
      expect(eP).toBeLessThan(eL * (d / 0.6));
    }
  });
  it('is zero behind the surface and beyond the range', () => {
    expect(headlampIrradiancePerp({ tex, lamps, basis, point: ahead(30), normal: [0, -1, 0] })).toBe(0);
    expect(headlampIrradiancePerp({ tex, lamps, basis, point: ahead(30), normal: up, range: 20, fade: 0.1 })).toBe(0);
  });
});

describe('pavementLuminance', () => {
  it('is R_L x E_perp at the reference albedo', () => {
    const reference = { asphalt: 0.14, concrete: 0.32 };
    expect(pavementLuminance({ ePerp: 40, albedo: 0.14, surface: 'asphalt', reference })).toBeCloseTo(0.6, 10);
    expect(pavementLuminance({ ePerp: 40, albedo: 0.32, surface: 'concrete', reference })).toBeCloseTo(1.0, 10);
    expect(pavementLuminance({ ePerp: 40, albedo: 0.07, surface: 'asphalt', reference })).toBeCloseTo(0.3, 10);
  });
  it('makes the low beam reach 60 m: of the order of 1, 0.5 and 0.08 cd/m2 at 10, 30 and 60 m (decision 13)', () => {
    const reference = PAVEMENT_ALBEDO_FALLBACK;
    const L = [10, 30, 60].map((d) => pavementLuminance({ ePerp: headlampIrradiancePerp({ tex, lamps, basis, point: ahead(d), normal: up }), albedo: reference.asphalt, reference }));
    const matte = [10, 30, 60].map((d) => (0.1 * headlampIrradiance({ tex, lamps, basis, point: ahead(d), normal: up })) / Math.PI);
    expect(L[1]).toBeGreaterThan(0.2);
    expect(L[2]).toBeGreaterThan(0.03);
    for (let i = 0; i < 3; i++) expect(L[i]).toBeGreaterThan(3 * matte[i]);
  });
});

describe('pavementAlbedo', () => {
  it('averages the day atlas over the lane columns, linear', () => {
    const w = 8, h = 4, px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const v = x < 4 ? 106 : 158; px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
    const lin = (c) => ((c / 255 + 0.055) / 1.055) ** 2.4;
    expect(meanAlbedo(px, w, h, [0, 4])).toBeCloseTo(lin(106), 6);
    expect(meanAlbedo(px, w, h, [4, 8])).toBeCloseTo(lin(158), 6);
    const r = pavementAlbedo({ map: { image: { width: w, height: h, data: px } } }, { lane: [0, 4], laneC: [4, 8] });
    expect(r.source).toBe('atlas');
    expect(r.asphalt).toBeCloseTo(lin(106), 6);
    expect(r.concrete).toBeCloseTo(lin(158), 6);
  });
  it('falls back to the atlas base colours without an image', () => {
    expect(pavementAlbedo({}, { lane: [0, 96], laneC: [864, 960] })).toEqual({ ...PAVEMENT_ALBEDO_FALLBACK, source: 'fallback' });
  });
});

describe('PAVEMENT_SPANS (headlamps.node.js)', async () => {
  const { PAVEMENT_SPANS } = await import('../../../src/drive/lights/headlamps.node.js');
  const { REGIONS } = await import('../../../src/drive/roadnet/atlas.js');
  const inside = (u) => PAVEMENT_SPANS.some(([a, b]) => u >= a && u < b);
  const mid = (r) => (r[0] + r[1]) / 2;
  it('holds every pavement column of the atlas, asphalt and concrete', () => {
    for (const k of ['lane', 'broken', 'solid', 'yellow', 'white', 'shoulder', 'gore', 'laneR', 'laneC', 'shoulderC', 'brokenC', 'solidC', 'yellowC', 'whiteC']) {
      expect(inside(REGIONS[k][0]), k).toBe(true);
      expect(inside(mid(REGIONS[k])), k).toBe(true);
      expect(inside(REGIONS[k][1] - 0.01), k).toBe(true);
    }
  });
  it('leaves out dirt, structure concrete, steel, reflectors and bridge joints (they keep the Lambert beam)', () => {
    for (const k of ['dirt', 'concrete', 'steel', 'reflector', 'joint']) expect(inside(mid(REGIONS[k])), k).toBe(false);
  });
});

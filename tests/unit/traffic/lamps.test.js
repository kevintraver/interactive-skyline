// D6.4: vehicle lamps. Photometry against FMVSS 108 (lamps.js), the sprite patterns as the GPU computes them, the
// sprites-to-ribbons handover in summed light (within 10%), the lamps over a kilometre against the model, the far
// field against exact placement, and determinism after a seek.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { LAMP_CD, LOBE, lampIntensity, vehicleIntensity, vehicleLitShare, vehicleThresholdLux, spriteWeight, ribbonIlluminance, VEHICLE_SWITCH } from '../../../src/drive/traffic/lamps.js';
import { patternShape, PATTERN } from '../../../src/drive/lights/spriteMirror.js';
import { SWITCH_MID_LUX } from '../../../src/drive/lights/switching.js';
import { createLampLayer } from '../../../src/drive/traffic/lampLayer.js';
import { createFarField } from '../../../src/drive/traffic/far.js';
import { LAMP_H, BIN_M } from '../../../src/drive/traffic/ribbon.js';
import { createVehicleBuffer } from '../../../src/drive/traffic/demand.js';
import { EARTH_R } from '../../../src/world/frame.js';
import { loadRoute, haveRoutes, LENGTHS } from './routes.js';

const RAD = Math.PI / 180;
const sidecar = JSON.parse(fs.readFileSync(new URL('../../../public/models/drive/vehicles.json', import.meta.url), 'utf8'));
const FRI_1830 = Date.parse('2026-11-21T02:30:00Z'); // Friday 18:30 PST

describe('lamp photometry (FMVSS 108)', () => {
  it('keeps tail and stop lamps inside Tables VIII and IX, and the stop lamp at least 5x the tail lamp', () => {
    // H-V: tail 2..18 cd, stop 80..300 cd
    expect(lampIntensity('tail', 1)).toBeGreaterThanOrEqual(2);
    expect(lampIntensity('tail', 1)).toBeLessThanOrEqual(18);
    expect(lampIntensity('stop', 1)).toBeGreaterThanOrEqual(80);
    expect(lampIntensity('stop', 1)).toBeLessThanOrEqual(300);
    expect(lampIntensity('stop', 1) / lampIntensity('tail', 1)).toBeGreaterThanOrEqual(5);
    // the minimum test points: 10 deg left/right and 20 deg (tail 0.8 and 0.3 cd; stop 40 and 10 cd)
    expect(lampIntensity('tail', Math.cos(10 * RAD))).toBeGreaterThanOrEqual(0.8);
    expect(lampIntensity('tail', Math.cos(20 * RAD) * Math.cos(5 * RAD))).toBeGreaterThanOrEqual(0.3);
    expect(lampIntensity('stop', Math.cos(10 * RAD))).toBeGreaterThanOrEqual(40);
    expect(lampIntensity('stop', Math.cos(20 * RAD) * Math.cos(5 * RAD))).toBeGreaterThanOrEqual(10);
    // markers (Tables X and XI): 0.62 cd amber, 0.25 cd red at 45 deg and 10 deg up
    const c45 = Math.cos(45 * RAD) * Math.cos(10 * RAD);
    expect(lampIntensity('amber', c45)).toBeGreaterThanOrEqual(0.62);
    expect(lampIntensity('red', c45)).toBeGreaterThanOrEqual(0.25);
    // a low beam toward an eye above the cut-off: within the 700-1,000 cd of Table XIX-a's glare points
    expect(LAMP_CD.head).toBeGreaterThanOrEqual(700);
    expect(LAMP_CD.head).toBeLessThanOrEqual(1000);
  });

  it('sees a tail lamp from behind, much less from the side, and nothing from ahead; a head lamp only from ahead', () => {
    const behind = lampIntensity('tail', 1);
    const side = lampIntensity('tail', Math.cos(80 * RAD));
    const ahead = lampIntensity('tail', -1);
    expect(behind).toBe(LAMP_CD.tail);
    expect(side / behind).toBeLessThan(0.01);
    expect(ahead).toBe(0);
    expect(lampIntensity('head', -0.3)).toBe(0);
    expect(lampIntensity('head', Math.cos(30 * RAD)) / LAMP_CD.head).toBeLessThan(0.45);
    // the vehicle as the ribbons count it: white from ahead, red from behind
    const [w0, r0] = vehicleIntensity(1);
    const [w1, r1] = vehicleIntensity(-1);
    expect(w0).toBe(2 * LAMP_CD.head); expect(r0).toBe(0);
    expect(w1).toBe(0); expect(r1).toBe(2 * LAMP_CD.tail);
  });

  it('draws the same pattern on the GPU as lamps.js (the sprite shader\'s lobe)', () => {
    for (const [kind, n] of [['head', LOBE.head], ['tail', LOBE.tail], ['stop', LOBE.stop], ['chmsl', LOBE.chmsl], ['amber', LOBE.marker]]) {
      for (const deg of [0, 5, 10, 20, 45, 70, 89]) {
        const gpu = LAMP_CD[kind] * patternShape(PATTERN.lobe, [0, 0, n], deg, null);
        expect(gpu).toBeCloseTo(lampIntensity(kind, Math.cos(deg * RAD)), 6);
      }
    }
  });

  it('switches vehicles on before the street lamps, one by one by a hash of the id', () => {
    expect(VEHICLE_SWITCH.midLux).toBeGreaterThan(SWITCH_MID_LUX * 4);
    expect(vehicleLitShare(50000)).toBeLessThan(0.001);
    expect(vehicleLitShare(SWITCH_MID_LUX)).toBeGreaterThan(0.99);
    let lit = 0;
    for (let k = 0; k < 4000; k++) if (300 < vehicleThresholdLux(k * 32 * 2 + 3)) lit++;
    expect(Math.abs(lit / 4000 - vehicleLitShare(300))).toBeLessThan(0.03);
  });

  it('hands sprites over to ribbons with weights that sum to one', () => {
    for (const ds of [-2500, -1900, -1600, 0, 2900, 3100, 3500, 3999, 5000]) {
      const w = spriteWeight(ds, 4000, 2000, 0.25);
      expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(1);
    }
    expect(spriteWeight(2900, 4000, 2000, 0.25)).toBe(1);
    expect(spriteWeight(4000, 4000, 2000, 0.25)).toBe(0);
    expect(spriteWeight(-1400, 4000, 2000, 0.25)).toBe(1);
  });
});

describe.skipIf(!haveRoutes)('lamps on the road (i15n, Friday 18:30)', () => {
  const R = haveRoutes ? loadRoute('i15n') : null;

  /** The light at the eye from every vehicle (as sprites) and from every lane (as ribbons) over [sLo, sHi]. */
  function lightFrom(eye, carS, simMs, sLo, sHi, ahead, behind, band) {
    const { traffic, laneMap, fleet } = R;
    const p = fleet.place(simMs, sLo, sHi, null);
    const sum = { spritesAll: [0, 0, 0], spritesW: [0, 0, 0], ribbonAll: [0, 0, 0], ribbonW: [0, 0, 0] };
    for (let i = 0; i < p.count; i++) {
      const i3 = 3 * i;
      const ex = eye.x - p.pos[i3], ey = eye.y - (p.pos[i3 + 1] + LAMP_H), ez = eye.z - p.pos[i3 + 2];
      const d = Math.hypot(ex, ey, ez);
      const c = (p.fwd[i3] * ex + p.fwd[i3 + 1] * ey + p.fwd[i3 + 2] * ez) / d;
      const I = vehicleIntensity(c, p.body[i] >= 4 ? 1 : 0);
      const w = spriteWeight(p.s[i] - carS, ahead, behind, band);
      for (let k = 0; k < 3; k++) { const e = (I[k] * p.alpha[i]) / (d * d); sum.spritesAll[k] += e; sum.spritesW[k] += e * w; }
    }
    // ribbons: lane centre lines at lamp height, the density table's bins interpolated, 10 m steps
    const dens = new Float32Array(8), lm = {}, r = {};
    const binDens = (dir, s) => {
      const b = Math.floor((s - traffic.range[0]) / BIN_M), u = (s - traffic.range[0]) / BIN_M - b;
      const a = Array.from(traffic.laneDensities(dir, traffic.range[0] + b * BIN_M, simMs, dens));
      const c2 = Array.from(traffic.laneDensities(dir, traffic.range[0] + (b + 1) * BIN_M, simMs, dens));
      return a.map((x, k) => x + (c2[k] - x) * u);
    };
    for (const [dir, segs] of [['with', traffic.segments('with')], ['against', traffic.segments('against')]]) {
      const ld = laneMap.dirs[dir];
      for (let s = sLo + 5; s < sHi; s += 10) {
        const lam = binDens(dir, s);
        const g = segs.find((x) => x.s0 <= s && s < x.s1) || segs[0];
        for (const L of traffic.lanes(dir)) {
          laneMap.atDir(ld, L.lane, s, lm);
          ld.refline.at(lm.sRoad, r);
          const mx = r.x - Math.sin(r.heading) * lm.d, my = r.y + Math.cos(r.heading) * lm.d;
          const P = { x: mx, y: R.frame.sceneY(r.h + r.crossfall * lm.d, mx, my) + LAMP_H, z: -my };
          const ex = eye.x - P.x, ey = eye.y - P.y, ez = eye.z - P.z;
          const d = Math.hypot(ex, ey, ez);
          const tl = Math.hypot(1, r.grade);
          const c = ((Math.cos(r.heading) * ex + r.grade * ey - Math.sin(r.heading) * ez) / tl) / d;
          const E = ribbonIlluminance({ lambda: lam[L.lane - 1] * lm.w, ds: 10, d, c, truckShare: g.truckShare });
          const w = 1 - spriteWeight(s - carS, ahead, behind, band);
          for (let k = 0; k < 3; k++) { sum.ribbonAll[k] += E[k]; sum.ribbonW[k] += E[k] * w; }
        }
      }
    }
    return sum;
  }

  it('changes the summed light by under 10% where the sprites hand over to the ribbons', () => {
    const rows = [];
    for (const s of [20000, 44200, 56000, 60000]) {
      for (const dt of [0, 600e3, 1900e3]) {
        const t = FRI_1830 + dt;
        const pose = R.journey.poseAtS(s);
        const eye = { x: pose.position.x + pose.up.x * 1.2, y: pose.position.y + 1.2, z: pose.position.z + pose.up.z * 1.2 };
        const ahead = 4000, behind = 2000, band = 0.25;
        // ahead: the band [3000, 4000], with a margin either side
        const a = lightFrom(eye, s, t, s + 2800, s + 4200, ahead, behind, band);
        // behind: the band [-2000, -1500]
        const b = lightFrom(eye, s, t, s - 2200, s - 1400, ahead, behind, band);
        for (const [where, x] of [['ahead', a], ['behind', b]]) {
          for (const [k, colour] of [[0, 'white'], [1, 'red']]) {
            const mixed = x.spritesW[k] + x.ribbonW[k];
            const sprites = x.spritesAll[k], ribbons = x.ribbonAll[k];
            if (!(sprites > 0)) continue;
            rows.push({ sprites, ribbons });
            // the handover: what is drawn (sprites weighted down, ribbons weighted up) against the sprites alone
            expect(Math.abs(mixed / sprites - 1)).toBeLessThan(0.1);
          }
        }
      }
    }
    expect(rows.length).toBeGreaterThan(30);
    // and the ribbons' density against the vehicles over all the windows (one window is a few dozen vehicles)
    const S = rows.reduce((a, r) => a + r.sprites / r.sprites, 0), Rb = rows.reduce((a, r) => a + r.ribbons / r.sprites, 0);
    expect(Math.abs(Rb / S - 1)).toBeLessThan(0.05);
  });

  it('writes the lamps of as many vehicles over 1 km as the model has there, within one', () => {
    const { traffic, laneMap, frame } = R;
    const far = createFarField({ traffic, laneMap, frame, lengths: LENGTHS, earthR: EARTH_R });
    const layer = createLampLayer({ parent: new THREE.Group(), sidecar });
    const buf = createVehicleBuffer();
    for (const s of [15000, 45000, 58000, 62000]) {
      for (const t of [FRI_1830, FRI_1830 + 777e3]) {
        const fv = far.collect(t, [s, s + 1000]);
        let written = 0;
        for (let i = 0; i < fv.count; i++) written += fv.alpha[i];
        let model = 0;
        for (const dir of ['with', 'against']) { traffic.vehiclesIn(dir, s, s + 1000, t, buf); for (let i = 0; i < buf.count; i++) model += buf.fade[i]; }
        expect(Math.abs(written - model)).toBeLessThanOrEqual(1);
        // and every one of them gets its lamps written (the eye high above the stretch sees every lamp facing up-ish)
        const eye = { x: fv.pos[0] + 200, y: fv.pos[1] + 500, z: fv.pos[2] + 200 };
        layer.update({ near: null, nearWindow: { sA: 0, sB: 0 }, far: fv, carS: s, ahead: 1e6, behind: 1e6, band: 0.1, eye, on: true });
        const st = layer.stats();
        expect(Math.abs(st.vehicles - fv.count)).toBeLessThanOrEqual(0);
        expect(st.sprites).toBeGreaterThan(2 * st.vehicles);
      }
    }
  });

  it('moves the far field on within centimetres of exact placement (99%), under a metre for any vehicle', () => {
    const { traffic, laneMap, frame, fleet } = R;
    const far = createFarField({ traffic, laneMap, frame, lengths: LENGTHS, earthR: EARTH_R });
    let worst = 0, n = 0;
    const errs = [];
    for (const s of [20000, 52000]) {
      for (let k = 0; k < 6; k++) {
        const t = FRI_1830 + k * 333;
        const fv = far.collect(t, [s, s + 1500]);
        const p = fleet.place(t, s - 50, s + 1550, null);
        const at = new Map();
        for (let i = 0; i < p.count; i++) at.set(p.id[i], i);
        for (let i = 0; i < fv.count; i++) {
          const j = at.get(fv.id[i]);
          if (j === undefined) continue;
          const e = Math.hypot(fv.pos[3 * i] - p.pos[3 * j], fv.pos[3 * i + 1] - p.pos[3 * j + 1], fv.pos[3 * i + 2] - p.pos[3 * j + 2]);
          worst = Math.max(worst, e);
          errs.push(e);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(200);
    errs.sort((a, b) => b - a);
    // the jitter's speed changes: centimetres; a vehicle braking or speeding up within the quantum: under a metre
    expect(errs[Math.floor(n / 100)]).toBeLessThan(0.15);
    expect(worst).toBeLessThan(1.0);
  });

  it('lists every vehicle once: the far field\'s list is the exact placement\'s, across tile boundaries and quanta', () => {
    const { traffic, laneMap, frame, fleet } = R;
    const far = createFarField({ traffic, laneMap, frame, lengths: LENGTHS, earthR: EARTH_R });
    let frames = 0;
    for (const s of [14800, 57900, 61900]) {
      for (let f = 0; f < 150; f++) {
        const t = FRI_1830 + f * 41; // through several tiles' quanta (their phases are a quarter second apart)
        const fv = far.collect(t, [s, s + 1300]);
        const p = fleet.place(t, s, s + 1300, null);
        const a = new Set(), b = new Set();
        for (let i = 0; i < fv.count; i++) { expect(a.has(fv.id[i])).toBe(false); a.add(fv.id[i]); }
        // exact placement near the range's ends may differ by the centimetres of moving on
        for (let i = 0; i < p.count; i++) if (p.s[i] > s + 1 && p.s[i] < s + 1299) b.add(p.id[i]);
        for (const id of b) expect(a.has(id)).toBe(true);
        frames++;
      }
    }
    expect(frames).toBe(450);
  });

  it('is a pure function of time: the same lamps after a seek away and back', () => {
    const { traffic, laneMap, frame } = R;
    const far = createFarField({ traffic, laneMap, frame, lengths: LENGTHS, earthR: EARTH_R });
    const layer = createLampLayer({ parent: new THREE.Group(), sidecar });
    const snap = (t) => {
      const fv = far.collect(t, [56000, 58000, 61000, 64000]);
      const eye = { x: fv.pos[0], y: fv.pos[1] + 3, z: fv.pos[2] };
      layer.update({ near: null, nearWindow: { sA: 0, sB: 0 }, far: fv, carS: 59500, ahead: 4000, behind: 2000, band: 0.25, eye, on: true });
      const n = layer.stats().sprites;
      return Array.from(layer.layer.data[0].subarray(0, 4 * n)).concat(Array.from(layer.layer.data[2].subarray(0, 4 * n)));
    };
    const t = FRI_1830 + 4321;
    const a = snap(t);
    snap(t + 2 * 86400e3);
    snap(t - 3600e3);
    far.clear(); traffic.clear();
    const b = snap(t);
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(1000);
  });
});

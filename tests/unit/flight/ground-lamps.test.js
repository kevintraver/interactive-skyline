// Every street lamp from the air (src/flight/ground/lamps.js) on the committed valley pack (public/data/lv/lamps-drive.bin):
// where each lamp is drawn, what is drawn from a camera, that thinning keeps the light, the budget, and day.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { PerspectiveCamera, Vector3, DynamicDrawUsage } from 'three';
import { createAirLamps, AIR_BUDGET, HEAD_LIFT_M, ALL_LIGHT_FACTOR } from '../../../src/flight/ground/lamps.js';
import { decodeLampPack } from '../../../src/drive/lights/pack.js';
import { curveDrop, EARTH_R } from '../../../src/world/frame.js';
import { lampHash } from '../../../src/drive/lights/switching.js';
import cities from '../../../data/cities.json';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('lamps-drive.json', DATA), 'utf8'));
const buf = (() => { const b = readFileSync(new URL(meta.file, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })();
const pack = decodeLampPack(meta, buf);
const BASE = cities.lv.base;
const GROUND = 640; // a level valley floor, m above sea level
const renderer = { getDrawingBufferSize: (v) => v.set(1280, 800) };

function cameraAt({ x, y, alt, look }) {
  const c = new PerspectiveCamera(46.8, 1280 / 800, 1, 500000);
  c.position.set(x, alt - BASE - curveDrop(x, y), -y);
  c.lookAt(new Vector3(look[0], GROUND - BASE, -look[1]));
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

let lamps;
beforeAll(async () => {
  lamps = createAirLamps({ packs: [{ meta, buffer: buf, name: 'lamps-drive' }], heightAt: () => GROUND, base: BASE, earthR: EARTH_R, level: 'high' });
  await lamps.placeHeights();
});

describe('the lamps as instances', () => {
  it('holds every lamp of the pack once', () => {
    expect(lamps.count).toBe(pack.count);
    const P = lamps.layer.data[0];
    const seen = new Set();
    for (let t = 0; t < pack.count; t += 997) {
      // texel t holds some lamp of the pack at its map position
      const x = P[4 * t], y = -P[4 * t + 2];
      seen.add(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    expect(seen.size).toBeGreaterThan(190);
  });

  it('puts each head its mount above the ground, on the curved datum', () => {
    const P = lamps.layer.data[0];
    for (let t = 0; t < pack.count; t += 4999) {
      const x = P[4 * t], y = -P[4 * t + 2];
      // the lamp at this position (texels are a permutation within cells)
      let i = -1;
      for (let k = 0; k < pack.count; k++) if (Math.abs(pack.x[k] - x) < 0.01 && Math.abs(pack.y[k] - y) < 0.01) { i = k; break; }
      expect(i).toBeGreaterThanOrEqual(0);
      expect(P[4 * t + 1]).toBeCloseTo(GROUND - BASE + pack.mount[i] + HEAD_LIFT_M - curveDrop(x, y), 2);
      expect(P[4 * t + 3]).toBeCloseTo(pack.lumens[i], 0); // intensity: the lamp's lumens (the street-lamp optics are per lumen)
    }
  });

  it('keeps each cell together and shuffles the lamps in it', () => {
    const P = lamps.layer.data[0];
    // the first cell with many lamps: its texels hold its lamps, not in the pack's (south to north) order
    let c = 0;
    while (pack.cellStart[c + 1] - pack.cellStart[c] < 50) c++;
    const a = pack.cellStart[c], b = pack.cellStart[c + 1];
    const ys = [];
    for (let t = a; t < b; t++) ys.push(-P[4 * t + 2]);
    const sorted = [...ys].sort((p, q) => p - q);
    expect(ys).not.toEqual(sorted);
    const x0 = meta.x0 + (c % meta.nx) * meta.cell, y0 = meta.y0 + Math.floor(c / meta.nx) * meta.cell;
    for (let t = a; t < b; t++) {
      expect(P[4 * t]).toBeGreaterThanOrEqual(x0 - 1e-3);
      expect(P[4 * t]).toBeLessThan(x0 + meta.cell + 1e-3);
    }
    expect(typeof lampHash(1)).toBe('number');
  });
});

describe('what a camera draws', () => {
  it('draws the valley from 10,000 ft, thinned where lamps crowd the pixels, with every lamp\'s light kept', () => {
    const cam = cameraAt({ x: 25000, y: -25000, alt: 3050, look: [0, 0] });
    lamps.update({ camera: cam, renderer, heightAboveGround: 2400, extinctionM: 30000, ambientLux: 0.002, on: true });
    const s = lamps.stats();
    expect(s.cellsDrawn).toBeGreaterThan(100);
    expect(s.drawn).toBeGreaterThan(5000);
    expect(s.drawn).toBeLessThanOrEqual(AIR_BUDGET.high);
    expect(s.drawn).toBeLessThan(s.lampsInView); // the far cells are thinned
    expect(lamps.drawnLight()).toBeCloseTo(s.lampsInView, -1); // and carry the light of those left out
  });

  it('draws nothing of the valley when looking away from it', () => {
    const cam = cameraAt({ x: 60000, y: 0, alt: 3050, look: [120000, 0] });
    lamps.update({ camera: cam, renderer, heightAboveGround: 2400, extinctionM: 30000, ambientLux: 0.002, on: true });
    expect(lamps.stats().drawn).toBe(0);
  });

  it('keeps to the budget of the quality level', () => {
    const cam = cameraAt({ x: 0, y: -30000, alt: 1500, look: [0, 0] });
    lamps.setLevel('low');
    lamps.setDensity(100); // as if every lamp were wanted
    lamps.update({ camera: cam, renderer, heightAboveGround: 900, extinctionM: 30000, ambientLux: 0.002, on: true });
    expect(lamps.stats().drawn).toBeLessThanOrEqual(AIR_BUDGET.low);
    expect(lamps.drawnLight()).toBeLessThanOrEqual(lamps.stats().lampsInView + 1);
    lamps.setLevel('high');
    lamps.setDensity(0);
  });

  it('changes a lamp\'s weight only a little between two nearby frames (no popping)', () => {
    const at = (x) => {
      const cam = cameraAt({ x, y: -25000, alt: 3050, look: [0, 0] });
      lamps.update({ camera: cam, renderer, heightAboveGround: 2400, extinctionM: 30000, ambientLux: 0.002, on: true });
      const a = lamps.layer.drawIndices, n = lamps.stats().drawn, m = new Map();
      for (let j = 0; j < n; j++) m.set(a[2 * j], a[2 * j + 1]);
      return m;
    };
    // the list is rewritten when the eye has moved 0.2 % of its height (4.8 m here, two frames at 250 kt)
    const a = at(25000), b = at(25005);
    let worst = 0, total0 = 0, total1 = 0;
    for (const [t, w] of b) { const w0 = a.get(t) ?? 0; worst = Math.max(worst, Math.abs(w - w0)); total1 += w; }
    for (const [t, w0] of a) { total0 += w0; if (!b.has(t)) worst = Math.max(worst, w0); }
    // a far cell's last lamp fades in and out as the eye moves: a fraction of one lamp's light per rewrite (it takes
    // tens of metres to come in whole); every other lamp keeps its light, and so does the view as a whole
    expect(worst).toBeLessThan(0.35);
    expect(Math.abs(total1 - total0) / total0).toBeLessThan(1e-3);
  });

  it('hides everything by day', () => {
    const cam = cameraAt({ x: 25000, y: -25000, alt: 3050, look: [0, 0] });
    lamps.update({ camera: cam, renderer, extinctionM: 30000, ambientLux: 1e4, on: false });
    expect(lamps.mesh.visible).toBe(false);
    expect(lamps.stats().drawn).toBe(0);
  });
});

describe('the region\'s towns (public/data/lv/lights-region.bin, scripts/build_flight_lights.py)', () => {
  const rmeta = JSON.parse(readFileSync(new URL('lights-region.json', DATA), 'utf8'));
  const rbuf = (() => { const b = readFileSync(new URL(rmeta.file, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })();
  it('reads in the drive\'s pack layout, every lamp inside its cell and placed by rule', () => {
    const r = decodeLampPack(rmeta, rbuf);
    expect(r.count).toBe(rmeta.count);
    for (let c = 0; c < r.nx * r.ny; c++) {
      for (let i = r.cellStart[c]; i < r.cellStart[c + 1]; i += 37) {
        const x0 = r.x0 + (c % r.nx) * r.cell, y0 = r.y0 + Math.floor(c / r.nx) * r.cell;
        expect(r.x[i] >= x0 && r.x[i] < x0 + r.cell && r.y[i] >= y0 && r.y[i] < y0 + r.cell).toBe(true);
        expect(r.rule[i]).toBe(1);
        expect(r.mount[i]).toBeGreaterThan(5);
      }
    }
  });
  it('joins the valley\'s lamps in one layer, one draw', async () => {
    const both = createAirLamps({ packs: [{ meta, buffer: buf, name: 'lamps-drive' }, { meta: rmeta, buffer: rbuf, name: 'lights-region' }], heightAt: () => GROUND, base: BASE, earthR: EARTH_R });
    expect(both.count).toBe(pack.count + rmeta.count);
    expect(both.stats().byPack).toEqual({ 'lamps-drive': pack.count, 'lights-region': rmeta.count });
    // looking north-east from east of the valley at cruise: Mesquite and St George are in view
    await both.placeHeights();
    const cam = cameraAt({ x: 60000, y: 20000, alt: 9300, look: [130000, 100000] });
    both.update({ camera: cam, renderer, heightAboveGround: 8000, extinctionM: 60000, ambientLux: 0.002, on: true });
    expect(both.stats().drawn).toBeGreaterThan(500);
    both.dispose();
  });
});

describe("all the city's outdoor light over its street lamps (F8.1)", () => {
  it("is the inverse of the street lamps' share Kyba et al. (2021) measured from space at full output", () => {
    // Tucson, VIIRS day-night band: street lights 18 % of the city's light at full output (95 % CI 15 to 23 %), 21 %
    // with the other owners' street lights; 13 % only after midnight, with the city's dimmed. The valley's inventory
    // holds every owner's street lamps, and the flights land in the evening
    expect(ALL_LIGHT_FACTOR).toBeGreaterThanOrEqual(1 / 0.23);
    expect(ALL_LIGHT_FACTOR).toBeLessThanOrEqual(1 / 0.15);
  });
});

describe('the draw list on the GPU (F8.2)', () => {
  // three's renderers upload an attribute marked DynamicDrawUsage on every render, whole (its update ranges are spent
  // after the first upload): the 326,466 lamps' list is 2.6 MB, measured at 3.2 ms of the main thread a frame on WebGPU
  // whether 0 or 26,000 lamps were drawn. The list is written only when the cull changes it, with needsUpdate and a range.
  it('is uploaded when the cull rewrites it, not on every render', () => {
    const attr = lamps.mesh.geometry.getAttribute('spriteIndex');
    expect(attr.usage).not.toBe(DynamicDrawUsage);
    const v = attr.version;
    lamps.update({ camera: cameraAt({ x: 0, y: 2000, alt: 1500, look: [0, -3000] }), renderer, heightAboveGround: 900, extinctionM: 80000, ambientLux: 0, on: true });
    expect(attr.version).toBeGreaterThan(v);
    expect(attr.updateRanges.length).toBe(1);
    expect(attr.updateRanges[0].count).toBeLessThanOrEqual(2 * lamps.stats().drawn + 2);
  });
});


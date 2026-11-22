// D6.6: the valley's light ribbons. The arithmetic (valleyModel.js, mirrored by valley.glsl.js), the reader of
// valley.json + valley.bin, and the vertex arrays built from them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  shapeAt, densityPerMetre, lampIntensity, redShare, ribbonRadiance, driftSpeed, driftTime, driftFactor, hourOfWeekAt,
  DRIFT_CELL_M, DRIFT_CELLS, DRIFT_WRAP_S, HASH_MEAN, hash11,
} from '../../../src/drive/traffic/valleyModel.js';
import { decodeValley, ValleyError } from '../../../src/drive/traffic/valleyFormat.js';
import { buildValleyGeometry, STEP_M } from '../../../src/drive/traffic/valleyGeometry.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const shape = Array.from({ length: 168 }, (_, h) => 0.02 + 0.06 * Math.max(0, Math.sin(((h % 24) - 6) / 24 * 2 * Math.PI)));
const norm = 7 / shape.reduce((a, b) => a + b, 0);
const SHAPE = shape.map((v) => v * norm); // sum / 7 = 1, as valley.json's shapes

/** A valley file of two pieces, made the way scripts/lib/valley_traffic.py encode() writes one. */
function syntheticValley() {
  const coords = [[0, 0], [500, 0], [1000, 0], [0, 100], [0, 900]]; // quantum 2: metres / 2
  const cbytes = new Int16Array(coords.flat());
  const recs = new DataView(new ArrayBuffer(40));
  const put = (i, { start, n, cls, flags, lanes, kmh, fwd, bwd, sf, sb }) => {
    const o = i * 20;
    recs.setUint32(o, start, true); recs.setUint16(o + 4, n, true); recs.setUint8(o + 6, cls); recs.setUint8(o + 7, flags);
    recs.setUint8(o + 8, lanes); recs.setUint8(o + 9, kmh); recs.setUint16(o + 10, fwd / 10, true); recs.setUint16(o + 12, bwd / 10, true);
    recs.setUint8(o + 14, sf); recs.setUint8(o + 15, sb); recs.setUint16(o + 16, 65535, true); recs.setUint16(o + 18, 0, true);
  };
  put(0, { start: 0, n: 3, cls: 2, flags: 0, lanes: 3, kmh: 72, fwd: 20000, bwd: 18000, sf: 0, sb: 1 }); // two-way, x 0..2000 m
  put(1, { start: 3, n: 2, cls: 0, flags: 1, lanes: 4, kmh: 105, fwd: 60000, bwd: 0, sf: 1, sb: 1 }); // one-way, north
  const buffer = new Uint8Array(cbytes.byteLength + 40);
  buffer.set(new Uint8Array(cbytes.buffer), 0);
  buffer.set(new Uint8Array(recs.buffer), cbytes.byteLength);
  const doc = {
    version: 1, city: 'test', year: 2025, tz: 'America/Los_Angeles', quantum: 2, classes: ['motorway', 'trunk', 'primary', 'secondary'],
    shapes: [{ id: 0, values: SHAPE }, { id: 1, values: SHAPE.map((v, h) => SHAPE[(h + 3) % 168]) }], names: ['Test Road'],
    vertices: 5, pieces: 2, bin: { coords: [0, cbytes.byteLength], pieces: [cbytes.byteLength, 40], pieceBytes: 20 },
  };
  return { doc, buffer: buffer.buffer };
}

describe('valley model', () => {
  it('the shape at the middle of an hour is that hour\'s value, and wraps round the week', () => {
    for (const h of [0, 17, 114, 167]) expect(shapeAt(SHAPE, h + 0.5)).toBeCloseTo(SHAPE[h], 12);
    expect(shapeAt(SHAPE, 168.25)).toBeCloseTo(shapeAt(SHAPE, 0.25), 12);
    expect(shapeAt(SHAPE, 0)).toBeCloseTo((SHAPE[167] + SHAPE[0]) / 2, 12);
  });

  it('vehicles per metre at an hour = volume x shape / speed', () => {
    const volume = 42000, v = 20; // veh/day, m/s
    for (const h of [3, 18, 114]) {
      const n = densityPerMetre(volume, SHAPE, h + 0.5, v);
      expect(n).toBeCloseTo((volume * SHAPE[h]) / 3600 / v, 12);
    }
    // q = k v: the flow past a point equals density x speed
    const n = densityPerMetre(volume, SHAPE, 114.5, 25);
    expect(n * 25 * 3600).toBeCloseTo(volume * SHAPE[114], 6);
  });

  it('white toward the oncoming traffic, red behind, a blend between', () => {
    expect(redShare(1)).toBe(0);
    expect(redShare(-1)).toBe(1);
    let last = -1;
    for (let c = 1; c >= -1; c -= 0.05) { const r = redShare(c); expect(r).toBeGreaterThanOrEqual(last - 1e-12); last = r; }
    const side = lampIntensity(0);
    expect(side.tail).toBeCloseTo(0, 12);
    expect(side.head).toBeGreaterThan(0); // spill only
    expect(lampIntensity(1).head).toBeGreaterThan(10 * lampIntensity(-1).tail);
    expect(redShare(-0.5)).toBeGreaterThan(0.5);
    expect(redShare(0.5)).toBeLessThan(0.05);
  });

  it('a strip sends the same light per metre whatever its width', () => {
    const n = 0.03, I = 500;
    for (const s of [0.2, 0.7, 1]) {
      expect(ribbonRadiance(n, I, 4, s) * 4 * s).toBeCloseTo(n * I, 9);
      expect(ribbonRadiance(n, I, 25, s) * 25 * s).toBeCloseTo(n * I, 9);
      expect(ribbonRadiance(n, I, 10, s, true) * 10 * s).toBeCloseTo(n * I, 9);
    }
  });

  it('local hour of week: Friday 18:30 in Las Vegas', () => {
    expect(hourOfWeekAt(Date.parse('2026-11-21T02:30:00Z'), 'America/Los_Angeles')).toBeCloseTo(4 * 24 + 18.5, 9);
    expect(hourOfWeekAt(Date.parse('2026-07-11T01:30:00Z'), 'America/Los_Angeles')).toBeCloseTo(4 * 24 + 18.5, 9); // PDT
    expect(hourOfWeekAt(Date.parse('2026-11-23T08:00:00Z'), 'America/Los_Angeles')).toBeCloseTo(0, 9); // Monday 00:00
  });

  it('the drift is a pure function of simulation time and does not jump where its time wraps', () => {
    const v = 26.4, n = 0.01;
    const t0 = Date.parse('2026-11-21T02:30:00Z');
    expect(driftFactor(123, driftTime(t0), v, n)).toBe(driftFactor(123, driftTime(t0), v, n));
    const wrap = Math.ceil(t0 / (DRIFT_WRAP_S * 1000)) * DRIFT_WRAP_S * 1000;
    for (const u of [0, 37, 1234.5]) {
      const before = driftFactor(u, driftTime(wrap - 1), v, n), after = driftFactor(u, driftTime(wrap + 1), v, n);
      expect(Math.abs(before - after)).toBeLessThan(0.01);
    }
    // the drift speed is a whole number of pattern periods per wrap
    const per = (driftSpeed(v) * DRIFT_WRAP_S) / (DRIFT_CELL_M * DRIFT_CELLS);
    expect(Math.abs(per - Math.round(per))).toBeLessThan(1e-9);
    expect(Math.abs(driftSpeed(v) - v)).toBeLessThan((DRIFT_CELL_M * DRIFT_CELLS) / DRIFT_WRAP_S);
  });

  it('the drift keeps the mean brightness, and is quieter where traffic is dense', () => {
    const period = DRIFT_CELL_M * DRIFT_CELLS;
    let sum = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) sum += driftFactor((i + 0.5) * (period / N), 0, 20, 0.002);
    expect(sum / N).toBeCloseTo(1, 3);
    const spread = (n) => { let lo = 9, hi = -9; for (let u = 0; u < period; u += 7) { const f = driftFactor(u, 0, 20, n); lo = Math.min(lo, f); hi = Math.max(hi, f); } return hi - lo; };
    expect(spread(0.2)).toBeLessThan(spread(0.002));
    expect(HASH_MEAN).toBeCloseTo(Array.from({ length: DRIFT_CELLS }, (_, i) => hash11(i)).reduce((a, b) => a + b) / DRIFT_CELLS, 12);
  });
});

describe('valley format and geometry', () => {
  it('decodes the pieces', () => {
    const { doc, buffer } = syntheticValley();
    const v = decodeValley(doc, buffer);
    expect(v.count).toBe(2);
    expect(Array.from(v.coords.slice(0, 6))).toEqual([0, 0, 1000, 0, 2000, 0]);
    expect(v.oneway[0]).toBe(0);
    expect(v.oneway[1]).toBe(1);
    expect(v.fwd[0]).toBe(20000);
    expect(v.bwd[0]).toBe(18000);
    expect(v.speed[0]).toBeCloseTo(20, 9);
    expect(() => decodeValley({ ...doc, version: 2 }, buffer)).toThrow(ValleyError);
    expect(() => decodeValley({ ...doc, shapes: [{ values: [1] }] }, buffer)).toThrow(ValleyError);
  });

  it('one ribbon per direction carrying traffic, to the right of travel, on the ground', () => {
    const { doc, buffer } = syntheticValley();
    const v = decodeValley(doc, buffer);
    const g = buildValleyGeometry(v, { heightAt: (x, y) => 700 + 0.01 * x, base: 620, curveDrop: () => 0 });
    expect(g.ribbons).toBe(3);
    const pts = g.position.length / 6; // two vertices per point
    expect(pts).toBe(g.points);
    // piece 0 is 2000 m: steps of at most STEP_M
    expect(g.points).toBe(2 * (Math.ceil(1000 / STEP_M) * 2 + 1) + (Math.ceil(1600 / STEP_M) + 1));
    for (let p = 0; p < g.points; p++) {
      const o = 2 * p;
      const x = g.position[3 * o], y = -g.position[3 * o + 2];
      const dx = g.dir[3 * o], dy = -g.dir[3 * o + 2];
      expect(g.position[3 * o + 1]).toBeCloseTo(700 + 0.01 * x - 620 + 1.2, 3);
      if (Math.abs(dy) < 1e-6) {
        // the east-west two-way piece: eastbound (dx > 0) south of the line (y < 0), westbound north of it
        expect(Math.sign(y)).toBe(-Math.sign(dx));
        expect(Math.abs(y)).toBeCloseTo(0.5 * 3 * 3.6 + 1, 6);
      } else expect(x).toBeCloseTo(0, 6); // the one-way piece stays on its line
    }
    // the traffic attribute: volume per direction and its shape
    const east = Array.from({ length: g.points }, (_, p) => p).find((p) => g.dir[6 * p] > 0.5);
    const west = Array.from({ length: g.points }, (_, p) => p).find((p) => g.dir[6 * p] < -0.5);
    expect(g.traffic[8 * east]).toBe(20000);
    expect(g.traffic[8 * east + 1]).toBe(0);
    expect(g.traffic[8 * west]).toBe(18000);
    expect(g.traffic[8 * west + 1]).toBe(1);
    expect(Math.max(...g.index)).toBeLessThan(2 * g.points);
  });

  it('the product: every piece decodes, its brightness at an hour is volume x shape / speed', () => {
    const dir = path.join(ROOT, 'public/data/lv/traffic');
    if (!fs.existsSync(path.join(dir, 'valley.json'))) return;
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'valley.json'), 'utf8'));
    const bin = fs.readFileSync(path.join(dir, 'valley.bin'));
    const v = decodeValley(doc, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    expect(v.count).toBeGreaterThan(500);
    for (const s of v.shapes) expect(s.reduce((a, b) => a + b, 0) / 7).toBeCloseTo(1, 3);
    const how = 114.5; // Friday 18:00-19:00
    for (let i = 0; i < v.count; i += 97) {
      const n = densityPerMetre(v.fwd[i], v.shapes[v.shapeF[i]], how, v.speed[i]);
      expect(n).toBeCloseTo((v.fwd[i] * doc.shapes[v.shapeF[i]].values[114]) / 3600 / v.speed[i], 6);
    }
  });
});

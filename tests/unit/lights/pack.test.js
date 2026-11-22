// D5.4: the served lamp product (scripts/pack_lamps.py writes it, src/drive/lights/pack.js reads it) and the cull
// of its cells against a view and the horizon.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { decodeLampPack, cellAt, nonEmptyCells, cellBounds, cullCells, BOUND_STRIDE } from '../../../src/drive/lights/pack.js';
import { decodeLampRecords } from '../../../src/drive/lights/lamps.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const buf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();

/** Every wanted lamp has one got lamp at its quantised position (1/64 m), with the same fields; all but `moved` of
 * them when the packer moved poles off the pavement (scripts/pack_lamps.py), those within 60 m of where they were. */
const qkey = (x, y) => `${Math.round(x * 64)},${Math.round(y * 64)}`;
function expectSameLamps(want, got, moved = 0) {
  expect(got.length).toBe(want.length);
  const byKey = new Map();
  for (const g of got) { const k = qkey(g.x, g.y); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(g); }
  const take = (w) => {
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) { // a position at a cell's far edge is clamped by 1/64
      const list = byKey.get(qkey(w.x + dx / 64, w.y + dy / 64));
      const i = list ? list.findIndex((g) => g.type === w.type && g.lumens === w.lumens && Math.abs(g.mount - w.mount) <= 0.5 / 8 + 1e-6) : -1;
      if (i >= 0) return list.splice(i, 1)[0];
    }
    return null;
  };
  // plain checks per lamp (an expect per field and lamp is slow over 195,000 lamps), one assertion at the end
  const bad = [];
  let badCount = 0;
  for (const w of want) {
    const g = take(w);
    const ok = g && Math.abs(w.x - g.x) <= 1 / 64 + 1e-6 && Math.abs(w.y - g.y) <= 1 / 64 + 1e-6 && g.enclosed === w.enclosed
      && (w.aim == null ? Number.isNaN(g.aim) : Math.abs(((w.aim - g.aim + 540) % 360) - 180) <= 0.71);
    if (!ok) { badCount++; if (bad.length < 5) bad.push({ want: w, got: g }); }
  }
  if (!moved) { expect(bad).toEqual([]); return; }
  // a moved lamp may land within 1/64 m of where it was (a deck lamp whose arm already reached back), or leave the region
  expect(badCount).toBeLessThanOrEqual(moved);
  expect(badCount).toBeGreaterThan(moved * 0.98);
}
const fromPack = (p) => Array.from({ length: p.count }, (_, i) => ({ x: p.x[i], y: p.y[i], mount: p.mount[i], type: p.type[i], lumens: p.lumens[i], enclosed: p.enclosed[i], aim: p.aim[i] }));
const fromInventory = (recs) => recs.map((r) => ({ ...r, enclosed: r.flags & 0x10 ? 1 : 0 }));

describe.runIf(python)('the pack format: Python writes, JavaScript reads', () => {
  it('gives back the lamps of a synthetic inventory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lamps-'));
    const n = 3000, dv = new DataView(new ArrayBuffer(n * 16));
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      dv.setInt32(o, Math.round((rnd() * 9000 - 4500) * 1000), true);
      dv.setInt32(o + 4, Math.round((rnd() * 9000 - 4500) * 1000), true);
      dv.setUint16(o + 8, 60 + Math.floor(rnd() * 245), true);
      dv.setUint8(o + 10, Math.floor(rnd() * 8));
      dv.setUint8(o + 11, (i % 13 === 0 ? 0x10 : 0) | (i % 4 === 0 ? 1 : 0));
      dv.setUint16(o + 12, 9 + Math.floor(rnd() * 13000), true);
      dv.setUint16(o + 14, i % 3 ? 0xffff : Math.floor(rnd() * 36000), true);
    }
    writeFileSync(join(dir, 'lamps.bin'), new Uint8Array(dv.buffer));
    execFileSync('python3', [join(ROOT, 'scripts/pack_lamps.py'), '--inventory', join(dir, 'lamps.bin'), '--out', dir]);
    const meta = JSON.parse(readFileSync(join(dir, 'lamps-drive.json'), 'utf8'));
    const pack = decodeLampPack(meta, buf(readFileSync(join(dir, 'lamps-drive.bin'))));
    expectSameLamps(fromInventory(decodeLampRecords(dv.buffer)), fromPack(pack));
    expect(pack.lampTypes.types.length).toBeGreaterThan(0);
    // every lamp sits in the cell the index puts it in
    for (const c of nonEmptyCells(pack)) {
      for (let i = pack.cellStart[c]; i < pack.cellStart[c + 1]; i++) expect(cellAt(pack, pack.x[i] - 1e-6, pack.y[i] - 1e-6) === c || cellAt(pack, pack.x[i], pack.y[i]) === c).toBe(true);
    }
  });
});

const served = join(ROOT, 'public/data/lv/lamps-drive.json');
describe.runIf(existsSync(served) && existsSync(join(ROOT, 'data/derived/lv/lamps.bin')))('the served product', () => {
  it('holds every lamp of the inventory inside the drive region', () => {
    const meta = JSON.parse(readFileSync(served, 'utf8'));
    const pack = decodeLampPack(meta, buf(readFileSync(join(ROOT, 'public/data/lv/lamps-drive.bin'))));
    const [x0, y0, x1, y1] = meta.region;
    const inv = fromInventory(decodeLampRecords(buf(readFileSync(join(ROOT, 'data/derived/lv/lamps.bin'))))).filter((l) => l.x >= x0 && l.x < x1 && l.y >= y0 && l.y < y1);
    expectSameLamps(inv, fromPack(pack), meta.cleared?.moved ?? 0);
    expect(meta.enclosed).toBe(inv.filter((l) => l.enclosed).length);
  }, 30000);
});

describe('culling cells', () => {
  // a 5 x 5 grid of 1 km cells, one lamp row each, heads at y = 10, on a flat valley
  const pack = { count: 25, cell: 1000, x0: -2500, y0: -2500, nx: 5, ny: 5, cellStart: Uint32Array.from({ length: 26 }, (_, i) => i), x: new Float64Array(25), y: new Float64Array(25) };
  for (let i = 0; i < 25; i++) { pack.x[i] = -2000 + (i % 5) * 1000; pack.y[i] = -2000 + Math.floor(i / 5) * 1000; }
  const headY = new Float32Array(25).fill(10), headAlt = new Float32Array(25).fill(10);
  const cells = nonEmptyCells(pack);
  const bounds = cellBounds(pack, headY, headAlt, cells);
  const planesOf = (cam) => {
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    return f.planes.map((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
  };
  const ids = (res) => Array.from(res.cells.subarray(0, res.count), (k) => bounds[k * BOUND_STRIDE + 7]).sort((a, b) => a - b);

  it('keeps the cells in front and drops those behind', () => {
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 1, 1e6);
    cam.position.set(0, 2, 0); cam.lookAt(0, 2, -1); // looking north (map +y is scene -z)
    const res = cullCells(bounds, { eye: cam.position, eyeAlt: 2, planes: planesOf(cam), maxDistance: 1e6, earthR: 6.4e6 });
    const kept = ids(res);
    for (const c of [17, 22, 21, 23]) expect(kept).toContain(c); // ahead (north), within the view's width
    for (const c of [0, 1, 2, 3, 4, 7, 10, 14]) expect(kept).not.toContain(c); // behind, and far off to the sides
    expect(res.lamps).toBe(kept.length);
    // turned round, the other way
    cam.lookAt(0, 2, 1);
    const back = ids(cullCells(bounds, { eye: cam.position, eyeAlt: 2, planes: planesOf(cam), maxDistance: 1e6, earthR: 6.4e6 }));
    for (const c of [7, 2, 1, 3]) expect(back).toContain(c);
    for (const c of [17, 22]) expect(back).not.toContain(c);
  });

  it('drops cells beyond maxDistance and beyond the horizon', () => {
    const cam = new THREE.PerspectiveCamera(170, 1, 1, 1e6);
    cam.position.set(0, 2, 0); cam.lookAt(0, 2, -1);
    const all = cullCells(bounds, { eye: cam.position, eyeAlt: 2, planes: [], maxDistance: 1e6, earthR: 6.4e6 });
    expect(all.count).toBe(25);
    const near = cullCells(bounds, { eye: cam.position, eyeAlt: 2, planes: [], maxDistance: 1100, earthR: 6.4e6 });
    expect(ids(near)).toEqual([7, 11, 12, 13, 17]); // the eye's cell and the four lamps 1 km away
    // a tiny earth: from 2 m above a floor 8 m below the heads the horizon is a few metres out
    const tiny = cullCells(bounds, { eye: cam.position, eyeAlt: 2, planes: [], maxDistance: 1e6, earthR: 1000, floorAlt: 0 });
    expect(ids(tiny)).toEqual([12]);
    // a big earth sees them all
    expect(cullCells(bounds, { eye: cam.position, eyeAlt: 2, planes: [], maxDistance: 1e6, earthR: 6.4e6, floorAlt: 0 }).count).toBe(25);
  });
});

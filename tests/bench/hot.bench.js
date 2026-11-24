// T0.8: micro-benchmarks of hot pure functions, reported by `pnpm bench` (not gated; the unit tests in
// tests/unit/perf/bounds.test.js carry generous upper bounds that catch an algorithmic blow-up). Vitest 5's
// benchmark API: `bench` comes from the test context and each registration runs on its own.
import fs from 'node:fs';
import { test } from 'vitest';
import { extrude, toGeometry, fresh } from '../../src/city/extrude.js';
import { heightField, makeGroundY } from '../../src/city/terrain.js';
import { curveDrop } from '../../src/core/earth.js';
import { makePivotGround, smoothGround } from '../../src/interaction/cameraLimits.js';
import cities from '../../data/cities.json' with { type: 'json' };

const lv = JSON.parse(fs.readFileSync(new URL('../../public/data/lv/buildings.json', import.meta.url)));
const slice = lv.buildings.slice(0, 2000);
const read = (city, name) => { const b = fs.readFileSync(new URL(`../../public/data/${city}/${name}`, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(fs.readFileSync(new URL('../../public/data/lv/terrain.json', import.meta.url)));
const near = heightField(read('lv', meta.grids.near.file), meta.grids.near);
const far = heightField(read('lv', meta.grids.far.file), meta.grids.far);
const groundY = makeGroundY(near, far, cities.lv.base);
const pivotGround = makePivotGround(near, far, cities.lv.base);

test('extrude + toGeometry, 2,000 Las Vegas buildings', async ({ bench }) => {
  await bench('extrude + toGeometry, 2,000 Las Vegas buildings', () => {
    const out = fresh(1 << 16);
    for (const b of slice) for (const v of b.v) extrude(v, out, [1, 1, 1], cities.lv.base);
    toGeometry(out);
  }).run();
});

test('groundY, 10,000 lookups across both grids', async ({ bench }) => {
  await bench('groundY, 10,000 lookups across both grids', () => {
    let s = 0;
    for (let i = 0; i < 10000; i++) s += groundY(-40000 + (i % 100) * 800, -30000 + Math.floor(i / 100) * 600);
    return s;
  }).run();
});

test('curveDrop, 100,000 calls', async ({ bench }) => {
  await bench('curveDrop, 100,000 calls', () => {
    let s = 0;
    for (let i = 0; i < 100000; i++) s += curveDrop(i - 50000, 50000 - i);
    return s;
  }).run();
});

test('camera limits: the pivot ground (five-point average) and the camera clearance, 10,000 drag frames', async ({ bench }) => {
  await bench('camera limits: the pivot ground (five-point average) and the camera clearance, 10,000 drag frames', () => {
    let s = 0;
    for (let i = 0; i < 10000; i++) {
      const x = -6000 + i * 1.3, z = 2000 - i * 0.7;
      s += smoothGround(pivotGround, x, z, 40) + groundY(x + 300, -(z + 300)) + groundY(x + 299, -(z + 300));
    }
    return s;
  }).run();
});

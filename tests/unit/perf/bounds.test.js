// T0.8: generous upper bounds on hot code, so an algorithmic blow-up (quadratic where it was linear) fails here
// on any machine. Each bound is about 10x what this code takes on the reference machine (an Apple M4, measured
// 21 Nov 2026 and noted beside it); they are not performance budgets.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { extrude, toGeometry, fresh } from '../../../src/city/extrude.js';
import { heightField, makeGroundY, terrainMesh } from '../../../src/city/terrain.js';
import cities from '../../../data/cities.json' with { type: 'json' };

const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
const read = (city, name) => { const b = fs.readFileSync(new URL(`../../../public/data/${city}/${name}`, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

describe.each(Object.keys(cities))('%s', (id) => {
  const model = JSON.parse(fs.readFileSync(new URL(`../../../public/data/${id}/buildings.json`, import.meta.url)));
  const meta = JSON.parse(fs.readFileSync(new URL(`../../../public/data/${id}/terrain.json`, import.meta.url)));

  it('extrudes every building in under 6 s', () => {
    let n = 0;
    const ms = time(() => {
      const out = fresh(1 << 20);
      for (const b of model.buildings) for (const v of b.v) extrude(v, out, [1, 1, 1], cities[id].base);
      n = toGeometry(out).attributes.position.count;
    });
    expect(n).toBeGreaterThan(100000);
    expect(ms).toBeLessThan(6000); // M4: about 0.4 s (lv), 0.4 s (slc)
  });

  it('builds both terrain meshes in under 5 s and samples 100,000 heights in under 0.5 s', () => {
    const near = heightField(read(id, meta.grids.near.file), meta.grids.near);
    const far = heightField(read(id, meta.grids.far.file), meta.grids.far);
    const build = time(() => { terrainMesh(far, near, null, cities[id].base); terrainMesh(near, null, null, cities[id].base); });
    expect(build).toBeLessThan(5000); // M4: about 0.3 s
    const groundY = makeGroundY(near, far, cities[id].base);
    let s = 0;
    const sample = time(() => { for (let i = 0; i < 100000; i++) s += groundY((i % 317) * 50 - 8000, Math.floor(i / 317) * 40 - 6000); });
    expect(Number.isFinite(s)).toBe(true);
    expect(sample).toBeLessThan(500); // M4: about 10 ms
  });
});

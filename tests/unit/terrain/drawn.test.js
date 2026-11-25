// The drive's one ground (terrain.surfaceAt, src/world/terrain/drawn.js) against the meshes actually drawn: rays cast
// down onto the wide mesh (with the far grid's hole and the dam patch cut out), the dam patch's mesh, and the app's
// far and near meshes (src/city/terrain.js) land where surfaceAt says, to the centimetre; and the Python twin
// (scripts/lib/heights.py drawn_at) agrees with it to the millimetre (tests/fixtures/drawn-lv.json).
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { curveDrop } from '../../../src/world/frame.js';
import { createTerrain } from '../../../src/world/terrain/index.js';
import { buildWideMesh, buildPatchMesh } from '../../../src/world/terrain/widemesh.js';
import { terrainMesh } from '../../../src/city/terrain.js';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const bytes = (file) => { const b = readFileSync(new URL(file, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/drawn-lv.json', import.meta.url), 'utf8'));
const BASE = 620;

async function loaded() {
  const terrain = createTerrain({ meta, buffers: { near: bytes(meta.grids.near.file), far: bytes(meta.grids.far.file) }, base: BASE, fetchBinary: async (f) => bytes(f) });
  await terrain.loadWide();
  await terrain.loadPatches();
  return terrain;
}

function points(n, x0, x1, y0, y1, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => [x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0)]);
}

/** The highest hit of a ray cast straight down at map (x, y) onto any of the meshes, in metres above sea level. */
function castDown(meshes, x, y) {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 9000, -y), new THREE.Vector3(0, -1, 0));
  const hits = ray.intersectObjects(meshes, false);
  return hits.length ? hits[0].point.y + BASE + curveDrop(x, y) : null;
}

describe('the drawn ground', () => {
  it('is where the rays hit the meshes the drive draws', async () => {
    const terrain = await loaded();
    const far = terrain.grid('far'), near = terrain.grid('near'), wide = terrain.grid('wide'), dam = terrain.grid('dam');
    const meshes = [
      buildWideMesh({ wide, hole: far, cuts: [dam], base: BASE, map: null }),
      buildPatchMesh({ patch: dam, id: 'dam', base: BASE, map: null }),
      terrainMesh(far, near, null, BASE),
      terrainMesh(near, null, null, BASE),
    ];
    for (const m of meshes) m.updateMatrixWorld(true);
    const span = (g, inset = 0) => [g.x0 + inset, g.x0 + (g.nx - 1) * g.step - inset, g.y0 + inset, g.y0 + (g.ny - 1) * g.step - inset];
    // the mountains of the wide grid, the dam's canyon, far and near, and the seams between them
    const pts = [
      ...points(40, -40000, 20000, -60000, -36000, 3), ...points(25, ...span(dam), 5), ...points(25, ...span(far, 200), 7),
      ...points(20, ...span(near, 50), 11),
      ...points(15, far.x0 - 300, far.x0 + 300, -30000, 30000, 13), ...points(15, -40000, 20000, far.y0 - 300, far.y0 + 300, 17),
    ];
    let worst = 0, n = 0;
    for (const [x, y] of pts) {
      const hit = castDown(meshes, x, y);
      if (hit === null) continue;
      n++;
      worst = Math.max(worst, Math.abs(terrain.surfaceAt(x, y) - hit));
    }
    expect(n).toBeGreaterThan(120);
    expect(worst).toBeLessThan(0.02); // float32 vertices 50 km out, and the curvature drop interpolated across a cell
  }, 120000);

  it('differs from the bilinear height query by metres in the mountains, and the query is what the map keeps', async () => {
    const terrain = await loaded();
    let worst = 0;
    for (const [x, y] of points(4000, -40000, 20000, -60000, -36000, 21)) worst = Math.max(worst, Math.abs(terrain.surfaceAt(x, y) - terrain.heightAt(x, y)));
    expect(worst).toBeGreaterThan(1);
    expect(terrain.surfaceY(-19534, -55912)).toBe(terrain.surfaceAt(-19534, -55912) - BASE - curveDrop(-19534, -55912));
  });

  it('matches the Python twin to the millimetre', async () => {
    const terrain = await loaded();
    expect(fixture.points.length).toBeGreaterThanOrEqual(200);
    for (const p of fixture.points) expect(Math.abs(terrain.surfaceAt(p.x, p.y) - p.drawn), `${p.x},${p.y}`).toBeLessThan(0.001);
  });
});

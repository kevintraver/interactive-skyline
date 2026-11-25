// Plan 03, F4.8 done in the app (src/flight/view/airportGround.js): while flying, the map's near and far ground meshes
// are moved onto the airport's height model so that no ground pokes through runways, taxiways or aprons and no
// pavement floats over the ground; on leaving they are given back bit for bit. Checked on the real data: the map's two
// meshes as src/city/terrain.js builds them, the airport of public/data/lv/airport.json.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createTerrain } from '../../../src/world/terrain/index.js';
import { heightField, terrainMesh } from '../../../src/city/terrain.js';
import { createFrame } from '../../../src/world/frame.js';
import { createEnvNodes } from '../../../src/env/nodes.js';
import { createAirport } from '../../../src/flight/airport/index.js';
import { createPavementIndex, EASE_M } from '../../../src/flight/airport/geometry.js';
import { LIFT } from '../../../src/flight/airport/surfaces.js';
import { conformGround, applyConformed, pavementBox, buildInset, insetY, onInset, airportTerrain, SINK } from '../../../src/flight/view/airportGround.js';
import { curveDrop } from '../../../src/core/earth.js';
import cities from '../../../data/cities.json';

const DATA = new URL('../../../public/data/lv/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
const raw = (name) => { const b = readFileSync(new URL(name, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const data = JSON.parse(readFileSync(new URL('airport.json', DATA), 'utf8'));
const BASE = cities.lv.base;
const frame = createFrame(cities.lv);
const buffers = { near: raw(meta.grids.near.file), far: raw(meta.grids.far.file) };
const terrain = createTerrain({ meta, buffers, base: BASE, fetchBinary: async (f) => raw(f) });
const airport = createAirport({ data, frame, terrain: airportTerrain(terrain, terrain.grid('near')), nodes: createEnvNodes({ state: null }), quality: 'high' });
const pave = createPavementIndex(data);
const nearHf = heightField(buffers.near, meta.grids.near), farHf = heightField(buffers.far, meta.grids.far);
const meshes = { far: terrainMesh(farHf, nearHf, null, BASE), near: terrainMesh(nearHf, null, null, BASE) };
const nearBox = { x0: nearHf.x0, x1: nearHf.x0 + (nearHf.nx - 1) * nearHf.step, y0: nearHf.y0, y1: nearHf.y0 + (nearHf.ny - 1) * nearHf.step };
const box = pavementBox(data, EASE_M + 200);

const onPavement = (x, y, tol) => pave.on(x, y, tol);
const original = { near: meshes.near.geometry.attributes.position.array.slice(), far: meshes.far.geometry.attributes.position.array.slice() };
const farY = (x, y) => drawnY(meshes.far, farHf, x, y);
const c = { near: conformGround({ positions: meshes.near.geometry.attributes.position, grid: nearHf, base: BASE, heightModel: airport.heightAt, onPavement, box }) };
// the near edge as drawn while flying: its conformed heights (src/flight/world.js does the same on a copy)
const nearCopy = { geometry: { attributes: { position: { array: original.near.slice() } } } };
applyConformed(nearCopy.geometry.attributes.position, c.near, true);
const inset = buildInset({ far: farHf, farY, nearY: (x, y) => drawnY(nearCopy, nearHf, x, y), near: nearBox, box, base: BASE, heightModel: airport.heightAt, onPavement });
c.far = conformGround({ positions: meshes.far.geometry.attributes.position, grid: farHf, base: BASE, hole: nearBox, heightModel: airport.heightAt, onPavement, box, under: inset });

/** Scene Y of a mesh's triangles at map (x, y), split as src/city/terrain.js indexes each cell. */
function drawnY(mesh, g, x, y) {
  const p = mesh.geometry.attributes.position.array;
  const fx = (x - g.x0) / g.step, fy = (y - g.y0) / g.step;
  const i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2), ax = fx - i, ay = fy - j;
  const at = (ii, jj) => p[(jj * g.nx + ii) * 3 + 1];
  const a = at(i, j), b = at(i + 1, j), d = at(i, j + 1), e = at(i + 1, j + 1);
  return ax + ay <= 1 ? a + ax * (b - a) + ay * (d - a) : e + (1 - ax) * (d - e) + (1 - ay) * (b - e);
}
const inNear = (x, y) => x >= nearBox.x0 && x <= nearBox.x1 && y >= nearBox.y0 && y <= nearBox.y1;
/** What is seen from above: inside near's footprint the higher of near and the far mesh dipping under it at its edge. */
let insetOn = false;
const inInset = (x, y) => insetOn && onInset(inset, x, y);
const groundAt = (x, y) => Math.max(drawnY(meshes.far, farHf, x, y), inNear(x, y) ? drawnY(meshes.near, nearHf, x, y) : -Infinity, inInset(x, y) ? insetY(inset, x, y) : -Infinity);
const pavementAt = (x, y, cls) => airport.heightAt(x, y) + LIFT[cls] - BASE - curveDrop(x, y);

/** Every 6 m over the pavement: [x, y, class]. */
const samples = [];
for (let y = box[1]; y <= box[3]; y += 6) for (let x = box[0]; x <= box[2]; x += 6) { const cls = pave.classAt(x, y); if (cls) samples.push([x, y, cls]); }

/** How far the ground stands above (positive) or below the pavement drawn over it, over every sample. */
function gaps() {
  const out = samples.map(([x, y, cls]) => groundAt(x, y) - pavementAt(x, y, cls)).sort((a, b) => a - b);
  return { pokes: out.filter((v) => v > -0.03).length, worst: out[out.length - 1], deepest: out[0], p999: out[Math.floor(out.length * 0.001)], n: out.length };
}

describe('the ground under the airport', () => {
  it('as the map draws it, pokes through the pavement and lets it float (the defect being fixed)', () => {
    const g = gaps();
    console.log('before', JSON.stringify(g));
    expect(g.pokes).toBeGreaterThan(1000);
    expect(g.deepest).toBeLessThan(-0.6);
  });

  it('conformed, lies under every sample of runway, taxiway and apron, and close under it', () => {
    applyConformed(meshes.near.geometry.attributes.position, c.near, true);
    applyConformed(meshes.far.geometry.attributes.position, c.far, true);
    insetOn = true;
    const g = gaps();
    console.log('conformed', JSON.stringify(g), 'near moved', JSON.stringify(c.near.moved), 'far moved', JSON.stringify(c.far.moved));
    expect(g.n).toBeGreaterThan(100000);
    expect(g.pokes, 'samples where the ground comes within 3 cm of the pavement or above it').toBe(0);
    // no pavement floats: the ground is at most the sink, the lift and what the cells round off below it
    expect(g.p999).toBeGreaterThan(-(SINK + LIFT.runway + 0.25));
  });

  it('meets the far mesh along the inset\'s outer edges and near along its edges against near, without a step', () => {
    expect(inset).not.toBeNull();
    let worstFar = 0, worstNear = 0;
    const near = (x, y) => drawnY(meshes.near, nearHf, x, y);
    const edge = [];
    for (let x = inset.x0; x <= inset.x1; x += 4) edge.push([x, inset.y0], [x, inset.y1]);
    for (let y = inset.y0; y <= inset.y1; y += 4) edge.push([inset.x0, y], [inset.x1, y]);
    // (within one far cell of near the map's far mesh dips 8 m under near, and the inset meets near there instead)
    const byNear = (x, y) => x >= nearBox.x0 - 80 && x <= nearBox.x1 + 80 && y >= nearBox.y0 - 80 && y <= nearBox.y1 + 80;
    for (const [x, y] of edge) if (!byNear(x, y)) worstFar = Math.max(worstFar, Math.abs(insetY(inset, x, y) - farY(x, y)));
    // near's edges inside the inset's box
    for (let x = nearBox.x0; x <= nearBox.x1; x += 4) if (x > inset.x0 && x < inset.x1 && nearBox.y0 > inset.y0) worstNear = Math.max(worstNear, Math.abs(insetY(inset, x, nearBox.y0) - near(x, nearBox.y0)));
    for (let y = nearBox.y0; y <= nearBox.y1; y += 4) if (y > inset.y0 && y < inset.y1 && nearBox.x1 < inset.x1) worstNear = Math.max(worstNear, Math.abs(insetY(inset, nearBox.x1, y) - near(nearBox.x1, y)));
    console.log('inset', inset.nx, 'x', inset.ny, inset.index.length / 3, 'triangles; seams', worstFar, worstNear);
    // the far edge: the inset's 12 m posts cut the corners of the 80 m polyline (buildInset)
    expect(worstFar).toBeLessThan(0.1);
    expect(worstNear).toBeLessThan(0.01);
  });

  it('moves nothing outside the airport, marks only the span it moved for upload, and gives the map back bit for bit', () => {
    for (const name of ['near', 'far']) {
      const attr = meshes[name].geometry.attributes.position;
      const ranges = attr.updateRanges;
      expect(ranges.length).toBe(1);
      expect(ranges[0].count).toBeLessThan(attr.array.length / 2);
      applyConformed(attr, c[name], false);
      expect(Buffer.from(attr.array.buffer).equals(Buffer.from(original[name].buffer))).toBe(true);
    }
  });
});

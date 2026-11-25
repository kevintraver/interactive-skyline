// The corridor's budgets, measured in Node: every cell meshed with the real mesher over the real terrain,
// then the car walked along the route every 250 m, counting what the part would hold (cells within the
// drop radius, the worst case of its hysteresis, plus the tall mesh).
//   node tests/manual/corridor-budget.mjs
import fs from 'node:fs';
import { createTerrain } from '../../src/world/terrain/index.js';
import { decodeRoadNet } from '../../src/drive/roadnet/format.js';
import { decodeCell } from '../../src/drive/corridor/format.js';
import { meshCell, groundUnder } from '../../src/drive/corridor/mesher.js';
import { EARTH_R } from '../../src/world/frame.js';

const D = new URL('../../public/data/lv/', import.meta.url);
const read = (f) => { const b = fs.readFileSync(new URL(f, D)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(fs.readFileSync(new URL('terrain.json', D), 'utf8'));
const city = JSON.parse(fs.readFileSync(new URL('../../data/cities.json', import.meta.url), 'utf8')).lv;
const terrain = createTerrain({ meta, base: city.base, buffers: { near: read(meta.grids.near.file), far: read(meta.grids.far.file) }, fetchBinary: async (f) => read(f) });
await terrain.loadWide();
const index = JSON.parse(fs.readFileSync(new URL('corridor/index.json', D), 'utf8'));
const RADIUS = 6000, DROP = 7500;

const tri = new Map();
let worst = { ms: 0 }, total = 0, groundMsMax = 0;
for (const c of [...index.cells, { ...index.tall, file: index.tall.file, tall: true }]) {
  const buf = read(`corridor/${c.file}`);
  const t0 = performance.now();
  const g = groundUnder(decodeCell(buf.slice(0)), terrain.heightAt);
  const tg = performance.now() - t0;
  groundMsMax = Math.max(groundMsMax, tg);
  // the first run warms the JIT; time the second, as a long drive would see it
  meshCell({ buf: buf.slice(0), ...g, base: city.base, earthR: EARTH_R });
  const t1 = performance.now();
  const m = meshCell({ buf, ...g, base: city.base, earthR: EARTH_R });
  const ms = performance.now() - t1;
  tri.set(c.file, m.triangles);
  total += m.triangles;
  if (ms > worst.ms) worst = { ms, file: c.file, buildings: m.buildings, triangles: m.triangles };
}
console.log(`cells ${index.cells.length}, all triangles ${total.toLocaleString()}, slowest mesh ${worst.ms.toFixed(1)} ms (${worst.file}, ${worst.buildings} buildings, ${worst.triangles} triangles), ground sampling up to ${groundMsMax.toFixed(1)} ms`);

const rn = decodeRoadNet(JSON.parse(fs.readFileSync(new URL('roadnet.json', D), 'utf8')), read('roadnet.bin'));
const road = rn.roads.find((r) => r.id === 'i15n.main');
const dist = (c, x, y) => Math.hypot(Math.max(c.bounds[0] - x, 0, x - c.bounds[2]), Math.max(c.bounds[1] - y, 0, y - c.bounds[3]));
let peak = { calls: 0 }, peakTri = { tri: 0 };
for (let i = 0; i < road.count; i += Math.round(250 / road.spacing)) {
  const x = road.x[i], y = road.y[i];
  const held = index.cells.filter((c) => dist(c, x, y) <= DROP);
  const calls = held.length + 1, t = held.reduce((a, c) => a + tri.get(c.file), tri.get(index.tall.file));
  if (calls > peak.calls) peak = { calls, km: (i * road.spacing) / 1000 };
  if (t > peakTri.tri) peakTri = { tri: t, km: (i * road.spacing) / 1000 };
}
console.log(`along the route: at most ${peak.calls} draw calls (km ${peak.km.toFixed(1)}), at most ${peakTri.tri.toLocaleString()} triangles (km ${peakTri.km.toFixed(1)})`);

// D6.2: the demand surface's two costs (plan 02, section 9.1): building a window (budget: well under
// 50 ms) and vehiclesIn for a 3 km stretch in both directions (budget: well under 0.3 ms). Reported by
// `pnpm bench`, not gated. Uses the real i15n counts when D6.1's file is present.
import fs from 'node:fs';
import { test } from 'vitest';
import { parseTraffic } from '../../src/drive/traffic/format.js';
import { createTraffic, createVehicleBuffer } from '../../src/drive/traffic/demand.js';
import { busyFile, bottleneckFile } from '../unit/traffic/fixtures.js';

const realUrl = new URL('../../public/data/lv/traffic/i15n.json', import.meta.url);
const real = fs.existsSync(realUrl) ? parseTraffic(fs.readFileSync(realUrl, 'utf8')) : null;
const FRIDAY = Date.parse('2025-07-11T23:00:00Z'); // Friday 16:00 PDT
const QUEUE = Date.parse('2025-07-08T16:00:00Z'); // the bottleneck fixture's queue at its longest

const free = createTraffic(real || busyFile(), { cache: 8 });
const stretch = real ? [57000, 60000] : [12000, 15000];
const queued = createTraffic(bottleneckFile(), { cache: 8, capacityFloor: 0 });

let day = 0;
test(`build a free-flow window (${real ? 'i15n counts' : 'synthetic, 5 lanes'})`, async ({ bench }) => {
  await bench('build a free-flow window', () => { free.clear(); free.stateAt('with', 1000, FRIDAY + (day++ % 7) * 86400e3); }).run();
});

test('build a window holding a 20 km queue (lane drop)', async ({ bench }) => {
  await bench('build a congested window', () => { queued.clear(); queued.stateAt('with', 1000, QUEUE); }).run();
});

const buf = createVehicleBuffer(4096);
let f = 0;
test(`vehiclesIn, 3 km, both directions, Friday peak (${real ? 'i15n, s 57-60 km' : 'synthetic'})`, async ({ bench }) => {
  await bench('vehiclesIn 3 km x 2 directions, free flow', () => {
    const ms = FRIDAY + (f++ % 600) * 16.7;
    free.vehiclesIn('with', stretch[0], stretch[1], ms, buf);
    free.vehiclesIn('against', stretch[0], stretch[1], ms, buf, true);
    return buf.count;
  }).run();
});

test('vehiclesIn, 3 km, both directions, inside a queue', async ({ bench }) => {
  await bench('vehiclesIn 3 km x 2 directions, queue', () => {
    const ms = QUEUE + (f++ % 600) * 16.7;
    queued.vehiclesIn('with', 16000, 19000, ms, buf);
    queued.vehiclesIn('against', 16000, 19000, ms, buf, true);
    return buf.count;
  }).run();
});

// D6.4: the traffic part's placement (fleet.place: the model's vehicles put on their lanes on both
// carriageways) for the range the part uses at 1280 x 720 with the 50 mm lens: 1.27 km ahead, 0.44 km
// behind. Budget with the renderer's fill: 0.5 ms (plan 02, section 9.1, traffic enumeration).
if (real) {
  const { decodeRoadNet } = await import('../../src/drive/roadnet/format.js');
  const { createLaneMap } = await import('../../src/drive/traffic/lanemap.js');
  const { createFleet } = await import('../../src/drive/traffic/fleet.js');
  const { createFrame, EARTH_R } = await import('../../src/world/frame.js');
  const bin = fs.readFileSync(new URL('../../public/data/lv/roadnet.bin', import.meta.url));
  const net = decodeRoadNet(JSON.parse(fs.readFileSync(new URL('../../public/data/lv/roadnet.json', import.meta.url), 'utf8')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const road = (id) => net.roads.find((r) => r.id === id);
  const city = JSON.parse(fs.readFileSync(new URL('../../data/cities.json', import.meta.url), 'utf8')).lv;
  const laneMap = createLaneMap({ traffic: free, roads: { with: road('i15n.main'), against: road('i15s.opp') } });
  const fleet = createFleet({ traffic: free, laneMap, frame: createFrame(city), lengths: [4.9, 4.6, 5.89, 5.93, 22.24, 13.72], earthR: EARTH_R });
  const PEAK = Date.parse('2026-07-11T00:30:00Z'); // Friday 17:30 PDT
  let g = 0;
  test('fleet.place, km 63, Friday 17:30, 1.27 km ahead and 0.44 km behind (i15n)', async ({ bench }) => {
    await bench('fleet.place, city, Friday peak', () => fleet.place(PEAK + (g++ % 600) * 16.7, 63000 - 444, 63000 + 1267, null).count).run();
  });
}

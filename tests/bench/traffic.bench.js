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

// D6.4 lamps and D6.5: the traffic part's per-frame JavaScript at the evening peak in the city with lamps (plan 02,
// section 9.1; budget for the whole part 0.6 ms): every vehicle out to 4 km ahead from the far field (far.js), the
// exact placement within 300 m ahead and 150 m behind with the car on its slot (fleet.js, reference.js), and the
// lamp sprites written for all of them (lampLayer.js). Reported by `pnpm bench`, not gated.
const { haveRoutes, loadRoute, LENGTHS: L6 } = await import('../unit/traffic/routes.js');
if (haveRoutes) {
  const THREE = await import('three');
  const { createFarField } = await import('../../src/drive/traffic/far.js');
  const { createLampLayer } = await import('../../src/drive/traffic/lampLayer.js');
  const { EARTH_R: R } = await import('../../src/world/frame.js');
  const route = loadRoute('i15n');
  const sidecar = JSON.parse(fs.readFileSync(new URL('../../public/models/drive/vehicles.json', import.meta.url), 'utf8'));
  const far = createFarField({ traffic: route.traffic, laneMap: route.laneMap, frame: route.frame, lengths: L6, earthR: R });
  const lamps = createLampLayer({ parent: new THREE.Group(), sidecar });
  const NIGHT_PEAK = Date.parse('2026-11-21T01:30:00Z'); // Friday 17:30 PST, dark
  route.journey.rebase(60000, NIGHT_PEAK);
  route.reference.shifts(route.traffic, route.journey);
  let h = 0;
  test('traffic frame with lamps, km 60, Friday 17:30 at night (i15n)', async ({ bench }) => {
    await bench('far field 4.5 km + exact 0.5 km + lamp sprites', () => {
      const t = NIGHT_PEAK + (h++ % 600) * 16.7;
      const pose = route.journey.poseAt(t);
      const list = far.collect(t, [pose.s - 544, pose.s + 4000], [pose.s - 454, pose.s + 1277]);
      route.fleet.place(t, pose.s - 190, pose.s + 340, pose);
      lamps.update({ near: null, far: list, carS: pose.s, ahead: 4000, behind: 544, band: 0.25, eye: pose.position, on: true, pxPerRad: 1500 });
      return lamps.stats().sprites;
    }).run();
  });
}

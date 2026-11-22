// The three real routes for the traffic tests: road network, the visitor's journey, the counts, the lane map,
// and the traffic referenced to the journey (reference.js), loaded from public/data/lv as the part does.
import fs from 'node:fs';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';
import { parseRoutes, filesOf } from '../../../src/drive/routes.js';
import { createJourney } from '../../../src/drive/journey.js';
import { createTraffic } from '../../../src/drive/traffic/demand.js';
import { createLaneMap } from '../../../src/drive/traffic/lanemap.js';
import { createReference, createEasedPace } from '../../../src/drive/traffic/reference.js';
import { createFleet } from '../../../src/drive/traffic/fleet.js';
import { createFrame, EARTH_R } from '../../../src/world/frame.js';

const root = new URL('../../../', import.meta.url);
const file = (p) => new URL(p, root);
export const ROUTE_IDS = ['i15n', 'i15s', 'us93'];
export const LENGTHS = [4.9, 4.6, 5.89, 5.93, 22.24, 13.72];
export const haveRoutes = ROUTE_IDS.every((id) => fs.existsSync(file(`public/data/lv/traffic/${id}.json`))) && fs.existsSync(file('public/data/lv/routes.json'));

const cache = new Map();
/**
 * Everything for one route: { route, road, journey, traffic (referenced), base (the file's own lanes), laneMap,
 * reference, fleet, frame }. The journey departs at departMs from the route's start.
 */
export function loadRoute(id, { departMs = Date.parse('2026-11-21T02:00:00Z') } = {}) {
  const key = `${id}@${departMs}`;
  if (cache.has(key)) return cache.get(key);
  const doc = JSON.parse(fs.readFileSync(file('public/data/lv/routes.json'), 'utf8'));
  const raw = doc.routes.find((r) => r.id === id);
  const netFile = filesOf(raw).roadnet;
  const bin = fs.readFileSync(file(`public/data/lv/${netFile.replace(/\.json$/, '.bin')}`));
  const net = decodeRoadNet(JSON.parse(fs.readFileSync(file(`public/data/lv/${netFile}`), 'utf8')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const { routes } = parseRoutes(doc, net, { file: netFile });
  const route = routes.find((r) => r.id === id);
  const roadOf = (rid) => net.roads.find((r) => r.id === rid);
  const frame = createFrame(JSON.parse(fs.readFileSync(file('data/cities.json'), 'utf8')).lv);
  const road = roadOf(route.road);
  const journey = createJourney({ route, road, frame, departMs, startS: route.s0 ?? 0, city: 'lv' });
  const data = JSON.parse(fs.readFileSync(file(`public/data/lv/traffic/${id}.json`), 'utf8'));
  const base = createTraffic(data);
  const roads = { with: roadOf(base.file.directions.with.road) || road, against: roadOf(base.file.directions.against.road) };
  const laneMap = createLaneMap({ traffic: base, roads });
  const reference = createReference({ traffic: base, laneMap, journey });
  const traffic = createTraffic(data, { lanePace: { with: reference.lanePace.with, against: createEasedPace({ traffic: base, dir: 'against' }) } });
  reference.shifts(traffic, journey);
  const fleet = createFleet({ traffic, laneMap, frame, lengths: LENGTHS, earthR: EARTH_R, reference });
  const out = { route, road, journey, traffic, base, laneMap, reference, fleet, frame, data };
  cache.set(key, out);
  return out;
}

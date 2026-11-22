// Shared scenarios for the demand-surface tests and the benchmark.
import { syntheticTraffic, parseTraffic } from '../../../src/drive/traffic/format.js';

export const TZ = 'America/Los_Angeles';
export const at = (iso) => Date.parse(iso);

/** Four segments with ramps between (flows and lane counts change at each boundary), no queue. */
export function rampsFile() {
  return parseTraffic(syntheticTraffic({
    length: 24000,
    segments: [
      { s0: 0, s1: 6000, lanes: 3, aadt: 23000 },
      { s0: 6000, s1: 12000, lanes: 4, aadt: 30000, truckShare: 0.1 },
      { s0: 12000, s1: 18000, lanes: 3, aadt: 21000 },
      { s0: 18000, s1: 24000, lanes: 3, aadt: 26000, truckShare: 0.25 },
    ],
  }));
}

/** Busy (urban I-15 at a Friday peak): five lanes, about 7,000 vehicles an hour each way. */
export function busyFile() {
  return parseTraffic(syntheticTraffic({ length: 30000, lanes: 5, aadt: 120000, capacityVph: 5 * 2300 }));
}

/**
 * A lane drop: 3 lanes (capacity 6900/h) for 20 km, then 2 lanes (capacity 4000/h) for 10 km.
 * Demand 2000/h, except 5000/h from Tuesday 07:00 to 11:00 local (constant 08:00-10:00).
 */
export const BOTTLENECK = { x: 20000, upCap: 6900, downCap: 4000, qHigh: 5000, qLow: 2000 };
export function bottleneckFile() {
  return parseTraffic(syntheticTraffic({
    length: 30000, truckShare: 0,
    segments: [{ s0: 0, s1: 20000, lanes: 3, capacityVph: BOTTLENECK.upCap }, { s0: 20000, s1: 30000, lanes: 2, capacityVph: BOTTLENECK.downCap }],
    flow: (how) => (how >= 24 + 7 && how < 24 + 11 ? BOTTLENECK.qHigh : BOTTLENECK.qLow),
  }));
}

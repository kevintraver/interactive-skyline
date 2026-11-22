import { describe, it, expect } from 'vitest';
import { decodeRoadNet, encodeRoadNet, RoadNetError, RECORD_BYTES } from '../../../src/drive/roadnet/format.js';
import { buildSyntheticRoadNet } from '../../fixtures/roadnet/synthetic.js';
import { fixtureFiles, fixture } from './helpers.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

describe('RoadNet format', () => {
  it('the checked-in fixture is what the generator writes, byte for byte', () => {
    const { json, bin } = fixtureFiles();
    const fresh = encodeRoadNet(buildSyntheticRoadNet());
    expect(new Uint8Array(fresh.bin)).toEqual(new Uint8Array(bin));
    expect(clone(fresh.json)).toEqual(json);
  });

  it('decodes stations, fills defaults and lays roads out by offset and count', () => {
    const rn = fixture();
    expect(rn.roads.map((r) => [r.id, r.count, r.length, r.stations.offset])).toEqual([['test.main', 751, 3000, 0], ['test.south', 301, 1200, 751]]);
    const a = rn.roads[0];
    expect(a.x[0]).toBe(-38000);
    expect(a.heading[0]).toBeCloseTo(0.6, 6);
    expect(a.curvature[300]).toBeCloseTo(1 / 600, 8);
    expect(a.crossfall[0]).toBeCloseTo(0.02, 6);
    const sec = rn.roads[1].sections[0];
    expect(sec.left).toMatchObject({ shoulder: 1.22, edge: 'yellow' }); // narrow left shoulder with two lanes
    expect(sec.right).toMatchObject({ shoulder: 3.05, edge: 'white' });
    expect(sec.lanes[0]).toMatchObject({ w: 3.66, kind: 'drive', line: 'broken' });
    expect(rn.roads[1].surface).toEqual([{ s0: 0, kind: 'asphalt' }]);
  });

  it('round-trips: decode, encode, decode gives the same stations and the same bytes', () => {
    const { json, bin } = fixtureFiles();
    const once = decodeRoadNet(json, bin);
    const again = encodeRoadNet(once);
    expect(new Uint8Array(again.bin)).toEqual(new Uint8Array(bin));
    const twice = decodeRoadNet(clone(again.json), again.bin);
    for (const k of ['x', 'y', 'h', 'heading', 'curvature', 'crossfall']) expect(twice.roads[0][k]).toEqual(once.roads[0][k]);
    expect(twice.roads[0].links).toEqual(once.roads[0].links);
  });

  it('writes little-endian int32 in the documented units and signs', () => {
    const { bin } = fixtureFiles();
    const v = new DataView(bin);
    const rec = 300 * RECORD_BYTES; // inside the 600 m left curve, banked
    expect(v.getInt32(rec, true)).toBe(1200000); // s mm
    expect(v.getInt32(rec + 20, true)).toBe(1666667); // curvature nrad/m, positive left
    expect(v.getInt32(rec + 24, true)).toBe(-30000); // crossfall millionths, left edge lower
    expect(v.getInt32(16, true)).toBe(600000); // heading 0.6 rad in microradians
  });

  it('wraps heading into (-pi, pi] and rounds half away from zero', () => {
    const road = { id: 'r', sections: [{ s0: 0, s1: 4, lanes: [{}] }], spacing: 4, x: [0, -4], y: [0, 0], h: [-0.0005, 0.0005], heading: [Math.PI, -Math.PI], curvature: [0, 0], crossfall: [0, 0] };
    const { bin } = encodeRoadNet({ roads: [road] });
    const v = new DataView(bin);
    expect(v.getInt32(16, true)).toBe(3141593);
    expect(v.getInt32(28 + 16, true)).toBe(3141593);
    expect(v.getInt32(12, true)).toBe(-1);
    expect(v.getInt32(28 + 12, true)).toBe(1);
  });

  describe('validation', () => {
    const bad = (mutate, message) => {
      const { json, bin } = fixtureFiles();
      const j = clone(json);
      const b = mutate(j, bin.slice(0)) || bin;
      expect(() => decodeRoadNet(j, b)).toThrow(RoadNetError);
      expect(() => decodeRoadNet(j, b)).toThrow(message);
    };
    it('rejects another version', () => bad((j) => { j.version = 2; }, /version 2/));
    it('rejects a roadnet with no roads', () => bad((j) => { j.roads = []; }, /no roads/));
    it('rejects a truncated bin', () => bad((j, b) => b.slice(0, b.byteLength - 3), /multiple of 28/));
    it('rejects stations past the end', () => bad((j) => { j.roads[1].stations.count = 400; }, /run past the end/));
    it('rejects overlapping roads', () => bad((j) => { j.roads[1].stations.offset = 700; j.roads[1].stations.count = 51; }, /overlap/));
    it('rejects non-uniform spacing', () => bad((j, b) => { new DataView(b).setInt32(5 * 28, 20010, true); return b; }, /uniform 4 m spacing/));
    it('rejects positions that are not a spacing apart', () => bad((j, b) => { const v = new DataView(b); v.setInt32(5 * 28 + 4, v.getInt32(5 * 28 + 4, true) + 500, true); return b; }, /apart in plan/));
    it('rejects sections that leave a gap', () => bad((j) => { j.roads[0].sections[1].s0 = 1610; }, /do not meet/));
    it('rejects sections that stop short of the end', () => bad((j) => { j.roads[0].sections[1].s1 = 2900; }, /sections end at 2900/));
    it('rejects a section with no lanes', () => bad((j) => { j.roads[0].sections[0].lanes = []; }, /no lanes/));
    it('rejects a negative lane width', () => bad((j) => { j.roads[0].sections[0].lanes[1].w = -1; }, /width must be positive/));
    it('rejects an unknown placement', () => bad((j) => { j.roads[0].sections[0].placement = 'middle_of:7'; }, /placement/));
    it('rejects a repeated id', () => bad((j) => { j.roads[1].id = 'test.main'; }, /repeated/));
  });
});

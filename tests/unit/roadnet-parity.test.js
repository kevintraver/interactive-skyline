// The Python road pipeline (scripts/lib/roadnet.py, scripts/lib/refline.py) against the runtime
// (src/drive/roadnet/format.js, refline.js). tests/fixtures/roads-parity.json is written by
// tests/fixtures/roads_make_fixtures.py from the Python side; regenerate it after build_roads.py.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeRoadNet, encodeRoadNet } from '../../src/drive/roadnet/format.js';
import { createRefline } from '../../src/drive/roadnet/refline.js';

const path = (p) => new URL(p, import.meta.url);
const fixture = JSON.parse(readFileSync(path('../fixtures/roads-parity.json'), 'utf8'));
const realJson = JSON.parse(readFileSync(path('../../public/data/lv/roadnet.json'), 'utf8'));
const realBinBuf = readFileSync(path('../../public/data/lv/roadnet.bin'));
const realBin = realBinBuf.buffer.slice(realBinBuf.byteOffset, realBinBuf.byteOffset + realBinBuf.byteLength);
const bytes = (buf) => new Uint8Array(buf);

describe('RoadNet writer parity', () => {
  it('encodes the edge-case input to the same bytes as the Python writer', () => {
    const { bin } = encodeRoadNet(structuredClone(fixture.encode.input));
    const expected = Buffer.from(fixture.encode.bin, 'base64');
    expect(bin.byteLength).toBe(expected.length);
    expect(Buffer.from(bin).equals(expected)).toBe(true);
  });

  it('writes the same JSON document as the Python writer', () => {
    const { json } = encodeRoadNet(structuredClone(fixture.encode.input));
    expect(JSON.parse(JSON.stringify(json))).toEqual(fixture.encode.json);
  });

  it('re-encodes the real roadnet to the bytes on disk', () => {
    const net = decodeRoadNet(realJson, realBin);
    const { bin } = encodeRoadNet(net);
    expect(Buffer.from(bin).equals(Buffer.from(bytes(realBin)))).toBe(true);
  });
});

describe('the real Las Vegas roadnet', () => {
  const net = decodeRoadNet(realJson, realBin);

  it('decodes without a validation error', () => {
    expect(net.roads.map((r) => r.id)).toEqual(expect.arrayContaining(['i15n.main']));
    for (const r of net.roads) expect((r.count - 1) % 16).toBe(0);
  });

  it('is the road the fixture was made from', () => {
    const road = net.roads.find((r) => r.id === fixture.refline.road);
    expect(road.count).toBe(fixture.refline.count);
  });

  it('interpolates the reference line as the Python twin does, to 1 mm, at 200 chainages', () => {
    const road = net.roads.find((r) => r.id === fixture.refline.road);
    const line = createRefline(road);
    const out = {};
    expect(fixture.refline.samples.length).toBe(200);
    let worst = 0;
    for (const p of fixture.refline.samples) {
      line.at(p.s, out);
      worst = Math.max(worst, Math.hypot(out.x - p.x, out.y - p.y), Math.abs(out.h - p.h));
      expect(Math.abs(Math.atan2(Math.sin(out.heading - p.heading), Math.cos(out.heading - p.heading)))).toBeLessThan(1e-6);
      expect(Math.abs(out.grade - p.grade)).toBeLessThan(1e-6);
      expect(Math.abs(out.curvature - p.curvature)).toBeLessThan(1e-9);
      expect(Math.abs(out.crossfall - p.crossfall)).toBeLessThan(1e-6);
    }
    expect(worst).toBeLessThan(0.001);
  });
});

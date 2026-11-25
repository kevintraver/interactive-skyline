// The JavaScript writer against the Python one on the interchange records: interchange-parity.json
// is the fixture's input encoded by scripts/lib/roadnet.py (tests/data/make_interchange_parity.py).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { encodeRoadNet, decodeRoadNet } from '../../../src/drive/roadnet/format.js';
import { interchangeInput } from './interchange-fixture.js';

const fx = JSON.parse(readFileSync(new URL('interchange-parity.json', import.meta.url), 'utf8'));

describe('interchange records, JavaScript and Python writers', () => {
  it('the fixture input is what interchange-fixture.js builds', () => {
    expect(JSON.parse(JSON.stringify(interchangeInput()))).toEqual(fx.input);
  });

  it('writes the same bytes and the same document, junctions and structures included', () => {
    const { json, bin } = encodeRoadNet(structuredClone(fx.input));
    expect(Buffer.from(bin).equals(Buffer.from(fx.bin, 'base64'))).toBe(true);
    expect(JSON.parse(JSON.stringify(json))).toEqual(fx.json);
    expect(fx.json.junctions).toHaveLength(1);
    expect(fx.json.structures).toHaveLength(4);
  });

  it('decodes what the Python writer wrote', () => {
    const b = Buffer.from(fx.bin, 'base64');
    const net = decodeRoadNet(fx.json, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    expect(net.roads.map((r) => r.id)).toEqual(['m.main', 'm.x1.off', 'x.cross']);
    expect(net.roads[0].gores).toHaveLength(1);
  });
});

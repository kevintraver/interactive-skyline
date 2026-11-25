// The delta-gzip decoder of the nested terrain grids (plan 03, sections 6.7 and 7.9; F6.1, F4.7): the browser's twin
// of scripts/lib/grids.py decode_delta_gzip, proven on the fixture made by its encoder and on the committed grids.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gunzip, decodeDeltaPlanes, decodeGrid, heightOf } from '../../../src/flight/terrain/decode.js';

const fixtureJson = JSON.parse(readFileSync(new URL('../../fixtures/flight/grid-delta.json', import.meta.url), 'utf8'));
const fixtureGz = readFileSync(new URL('../../fixtures/flight/grid-delta.bin.gz', import.meta.url));
const meta = JSON.parse(readFileSync(new URL('../../../public/data/lv/terrain.json', import.meta.url), 'utf8'));
const file = (name) => readFileSync(new URL(`../../../public/data/lv/${name}`, import.meta.url));

describe('the delta-gzip decoder on the fixture', () => {
  it('inflates the gzip member to the two byte planes, byte for byte', async () => {
    const bytes = await gunzip(fixtureGz);
    expect(Array.from(bytes)).toEqual(fixtureJson.inflated);
  });

  it('inflates the same bytes through Node\'s zlib where there is no DecompressionStream', async () => {
    expect(Array.from(await gunzip(fixtureGz, { stream: false }))).toEqual(fixtureJson.inflated);
  });

  it('undoes the left-up prediction to q, word for word', async () => {
    const { nx, ny } = fixtureJson;
    const q = decodeDeltaPlanes(await gunzip(fixtureGz), nx, ny);
    expect(q).toBeInstanceOf(Uint16Array);
    expect(Array.from(q)).toEqual(fixtureJson.q.flat());
  });

  it('gives the heights in metres, row 0 south, including the wrap past 65535', async () => {
    const g = await decodeGrid(fixtureGz, fixtureJson);
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) expect(heightOf(g, i, j)).toBeCloseTo(fixtureJson.heights[j][i], 6);
    }
  });

  it('takes a body the server already inflated (Content-Encoding: gzip, as Vite serves a .gz file)', async () => {
    const g = await decodeGrid(new Uint8Array(fixtureJson.inflated), fixtureJson);
    expect(Array.from(g.q)).toEqual(fixtureJson.q.flat());
    expect(g.inflatedByServer).toBe(true);
  });

  it('refuses a body of the wrong length', async () => {
    const bytes = await gunzip(fixtureGz);
    expect(() => decodeDeltaPlanes(bytes, 5, 5)).toThrow(/bytes/);
  });
});

describe('the delta-gzip decoder on the committed grids', () => {
  for (const name of ['region', 'approaches', 'valley']) {
    it(`decodes ${name} to nx * ny heights inside the encoding's range`, async () => {
      const e = meta.grids[name];
      expect(e.encoding).toBe('delta-gzip');
      const g = await decodeGrid(file(e.file), e);
      expect(g.q.length).toBe(e.nx * e.ny);
      // Death Valley is -86 m (region's 1 km posts read -110 m there); the sea is flattened to 0 down to -150 m
      expect(g.min).toBeGreaterThan(-150);
      expect(g.max).toBeLessThan(4500); // Mount Whitney, 4,421 m, is inside region
    });
  }
});

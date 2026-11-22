// Fixture loading for the drive tests: the synthetic roadnet, its routes and the Las Vegas frame.
import { readFileSync } from 'node:fs';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';
import { parseRoutes } from '../../../src/drive/routes.js';
import { createFrame } from '../../../src/world/frame.js';

const roadDir = new URL('../../fixtures/roadnet/', import.meta.url);
const driveDir = new URL('../../fixtures/drive/', import.meta.url);

export const LV = JSON.parse(readFileSync(new URL('../../../data/cities.json', import.meta.url), 'utf8')).lv;

/** Injected fetchers that read the fixtures from disk. */
export const io = {
  fetchJson: async (name) => JSON.parse(readFileSync(new URL(name, name === 'routes.json' ? driveDir : roadDir), 'utf8')),
  fetchBinary: async (name) => {
    const b = readFileSync(new URL(name, roadDir));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
};

export function fixture() {
  const json = JSON.parse(readFileSync(new URL('roadnet.json', roadDir), 'utf8'));
  const b = readFileSync(new URL('roadnet.bin', roadDir));
  const roadnet = decodeRoadNet(json, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const doc = JSON.parse(readFileSync(new URL('routes.json', driveDir), 'utf8'));
  const { routes } = parseRoutes(doc, roadnet);
  const road = (id) => roadnet.roads.find((r) => r.id === id);
  return { roadnet, routes, route: (id) => routes.find((r) => r.id === id), road, frame: createFrame(LV) };
}

// Shared fixture loading for the roadnet tests.
import { readFileSync } from 'node:fs';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';

export const BASE = 620;
export const EARTH_R = (6371000 * 7) / 6;

const dir = new URL('../../fixtures/roadnet/', import.meta.url);

/** The fixture files as { json, bin }. */
export function fixtureFiles() {
  const json = JSON.parse(readFileSync(new URL('roadnet.json', dir), 'utf8'));
  const b = readFileSync(new URL('roadnet.bin', dir));
  return { json, bin: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
}

/** The decoded fixture. */
export function fixture() {
  const { json, bin } = fixtureFiles();
  return decodeRoadNet(json, bin);
}

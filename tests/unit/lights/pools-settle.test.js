// The lamp pools' whenSettled (src/drive/lights/pools.js) resolves however the lamps went off and on while tiles were in
// flight: tiles that arrive while the lamps are off are kept and shown when they come on again over the same window
// (a stuck waiter here stops session.whenSettled and every script that waits on it).
import { describe, it, expect } from 'vitest';
import { createPools, RING } from '../../../src/drive/lights/pools.js';
import { POOL_TILE_PX } from '../../../src/drive/lights/poolTile.js';

/** Workers that keep the tile requests until flush() answers them. */
function fakeWorkers() {
  const held = [];
  const make = () => {
    const w = { onmessage: null, postMessage(m) { if (m.type === 'tile') held.push({ w, m }); }, terminate() {} };
    return w;
  };
  const flush = () => {
    const all = held.splice(0);
    for (const { w, m } of all) w.onmessage({ data: { type: 'tile', id: m.id, ti: m.ti, tj: m.tj, rgba: new Uint16Array(POOL_TILE_PX * POOL_TILE_PX * 4), lamps: 0, ms: 1 } });
    return all.length;
  };
  return { make, flush, held };
}
const renderer = { initTexture() {}, copyTextureToTexture() {} };
const settled = async (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);

describe('pools.whenSettled', () => {
  it('resolves once the window\'s tiles are in', async () => {
    const f = fakeWorkers();
    const pools = createPools({ renderer, pack: {}, createWorker: f.make });
    pools.update(1000, 1000, true);
    const wait = pools.whenSettled();
    expect(f.held.length).toBe(RING * RING);
    f.flush();
    expect(await settled(wait)).toBe(true);
  });

  it('resolves after the lamps went off and on again over the same window while its tiles were in flight', async () => {
    const f = fakeWorkers();
    const pools = createPools({ renderer, pack: {}, createWorker: f.make });
    pools.update(1000, 1000, true);
    pools.update(1000, 1000, false); // off before any tile came back
    f.flush(); // the tiles arrive while off
    pools.update(1000, 1000, true); // on again, same window
    expect(await settled(pools.whenSettled())).toBe(true);
    expect(pools.stats().complete).toBe(true);
  });

  it('a waiter from before the lamps went off resolves when they are off (nothing to wait for)', async () => {
    const f = fakeWorkers();
    const pools = createPools({ renderer, pack: {}, createWorker: f.make });
    pools.update(1000, 1000, true);
    const wait = pools.whenSettled();
    pools.update(1000, 1000, false);
    expect(await settled(wait)).toBe(true);
  });
});

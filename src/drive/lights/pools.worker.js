// Worker for the lamp pool map (pools.js): splats tiles (poolTile.js) and answers with RGBA half floats.
// Messages in:  { type: 'init', pack }   the decoded lamp product's arrays (pack.js LampPack, transferred copies)
//               { type: 'tile', id, ti, tj }
// Messages out: { type: 'tile', id, ti, tj, rgba: Uint16Array, lamps, ms }   (rgba transferred)
import { createLampTypes } from './lamps.js';
import { poolTile, tileToHalfRgba } from './poolTile.js';

let pack = null, types = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    pack = m.pack;
    types = createLampTypes(pack.lampTypes);
    return;
  }
  if (m.type === 'tile') {
    const t0 = performance.now();
    const tile = poolTile(pack, types, m.ti, m.tj);
    const rgba = tileToHalfRgba(tile);
    self.postMessage({ type: 'tile', id: m.id, ti: m.ti, tj: m.tj, rgba, lamps: tile.lamps, ms: performance.now() - t0 }, [rgba.buffer]);
  }
};

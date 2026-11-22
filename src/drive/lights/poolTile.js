// One tile of the lamp pool map (plan 02, D5.4; section 7.8): the ground illuminance of every lamp in and near a
// square of the map, splatted with lamps.js splatPool. Pure, worker-safe: a tile is a function of its indices and
// the lamp product, so scrubbing gives the same picture as driving.
//
// Four channels, so the surfaces can follow switching and warm-up without re-splatting: the light of sodium lamps
// and of all other lamps, each split by the lamp's switching hash (u < 0.5 switches on later at dusk, u >= 0.5
// earlier; switching.js lampHash of the lamp's index in the product). pools.js weights each channel by the share
// of its slice that is lit and by the warm-up of the slice's middle lamp.

import { splatPool } from './lamps.js';
import { lampHash } from './switching.js';

export const POOL_TILE_M = 512;
export const POOL_TILE_PX = 256; // 2 m per texel
/** How far from its lamp a splat reaches: out to 80 deg from the nadir, at most this many metres. */
export const POOL_REACH_MAX_M = 150;
const TAN80 = Math.tan((80 * Math.PI) / 180);

/** The channel of lamp i: 0/1 sodium (late/early), 2/3 the rest (late/early). */
export const poolChannel = (isSodium, index) => (isSodium ? 0 : 2) + (lampHash(index) < 0.5 ? 0 : 1);

/**
 * @param {import('./pack.js').LampPack} pack
 * @param {{ byId: Map<number, object> }} types  createLampTypes(pack.lampTypes)
 * @param {number} ti  @param {number} tj  tile indices: the tile covers x in [ti T, (ti + 1) T), y likewise
 * @param {{ tileM?: number, px?: number, supersample?: number }} [opts]
 * @returns {{ ti: number, tj: number, x0: number, y0: number, cell: number, n: number, channels: Float32Array[], lamps: number }}
 *   channels: four n x n grids, row 0 at y0 (south), lux
 */
export function poolTile(pack, types, ti, tj, { tileM = POOL_TILE_M, px = POOL_TILE_PX, supersample = 2 } = {}) {
  const x0 = ti * tileM, y0 = tj * tileM, cell = tileM / px;
  const channels = [0, 1, 2, 3].map(() => new Float32Array(px * px));
  const spec = { x0, y0, cell, nx: px, ny: px };
  const m = POOL_REACH_MAX_M;
  const cx0 = Math.max(0, Math.floor((x0 - m - pack.x0) / pack.cell)), cx1 = Math.min(pack.nx - 1, Math.floor((x0 + tileM + m - pack.x0) / pack.cell));
  const cy0 = Math.max(0, Math.floor((y0 - m - pack.y0) / pack.cell)), cy1 = Math.min(pack.ny - 1, Math.floor((y0 + tileM + m - pack.y0) / pack.cell));
  const lamp = { x: 0, y: 0, mount: 0, lumens: 0, aim: null };
  let lamps = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * pack.nx + cx;
      for (let i = pack.cellStart[c]; i < pack.cellStart[c + 1]; i++) {
        const type = types.byId.get(pack.type[i]);
        if (!type) continue;
        const r = Math.min(POOL_REACH_MAX_M, pack.mount[i] * TAN80);
        const x = pack.x[i], y = pack.y[i];
        if (x + r < x0 || x - r > x0 + tileM || y + r < y0 || y - r > y0 + tileM) continue;
        lamp.x = x; lamp.y = y; lamp.mount = pack.mount[i]; lamp.lumens = pack.lumens[i];
        lamp.aim = Number.isFinite(pack.aim[i]) ? pack.aim[i] : null;
        splatPool(channels[poolChannel(type.cls === 'sodium', i)], spec, lamp, type, { supersample, maxRadius: r });
        lamps++;
      }
    }
  }
  return { ti, tj, x0, y0, cell, n: px, channels, lamps };
}

// ---------------------------------------------------------------- half floats, for a HalfFloatType texture
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** IEEE 754 binary16 bits of a number (round to nearest; overflow to infinity; tiny values to zero or subnormal). */
export function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  const h = sign | (e << 10) | (m >> 13);
  return h + ((m >> 12) & 1); // round half up on the dropped bit
}

/** The four channels interleaved as RGBA half floats (a texture's rows, south first). */
export function tileToHalfRgba(tile) {
  const n = tile.n * tile.n, out = new Uint16Array(n * 4), [a, b, c, d] = tile.channels;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[o] = toHalf(a[i]); out[o + 1] = toHalf(b[i]); out[o + 2] = toHalf(c[i]); out[o + 3] = toHalf(d[i]);
  }
  return out;
}

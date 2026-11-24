// The lamp pool map's ring around the car (plan 02, D5.4; section 7.8), shared by both renderers: the window, the
// workers, the tile cache and the ring texture. pools.js puts it on the classic renderer's materials (a GLSL surface
// term), pools.node.js on plan 01's node materials (a TSL one); neither holds any of the logic below.
//
// A ring texture of RING x RING tiles (POOL_TILE_M metres, `tilePx` texels each: 2048 m at 2 m per texel by default),
// RGBA half floats in lux, one channel per light class and switching slice (poolTile.js). Tile (ti, tj) always sits
// in ring slot (ti mod RING, tj mod RING), so the texture is read with repeat wrapping at map / (RING x tile) and
// moving the window only replaces the tiles that left it. The window is RING x RING tiles centred on the car's
// position snapped to the tile grid, so what is drawn is a function of where the car is, not of the way it came.
// Tiles are splatted in workers (pools.worker.js) and kept in a small cache; a window shows once all its tiles are
// in, and until then the part of the last complete window that the new one shares.
//
// The values a term reads (plain three objects, wrapped by each renderer's uniforms):
//   ring     the DataTexture (repeat wrapping, linear filtering)
//   rect     Vector4 x0, y0, x1, y1 of the shown window (map metres); all zero when nothing is shown
//   spec     Vector4 1 / ring size (m), edge fade (m), on (0/1), unused
//   weights  four Vector3: each channel's weight (setWeights)
// Both renderers copy a tile into the ring with renderer.copyTextureToTexture (WebGLRenderer and WebGPURenderer).

import * as THREE from 'three';
import { POOL_TILE_M, POOL_TILE_PX } from './poolTile.js';

export const RING = 4;
const RING_M = RING * POOL_TILE_M;
const CACHE_TILES = 40;
/** Fade at the window's edge, metres. */
export const EDGE_M = 120;

const defaultWorker = () => new Worker(new URL('./pools.worker.js', import.meta.url), { type: 'module' });

/** The window's tile range for a car at map (x, y): [ti0, tj0], RING tiles each way. Pure. */
export function poolWindow(x, y) {
  const ti0 = Math.round(x / POOL_TILE_M) - RING / 2, tj0 = Math.round(y / POOL_TILE_M) - RING / 2;
  return { ti0, tj0, key: `${ti0},${tj0}` };
}

/**
 * @param {{ renderer: object, pack: object, createWorker?: () => Worker, workers?: number, tilePx?: number }} opts
 *   pack: the decoded lamp product (pack.js), sent to the workers once; tilePx: texels along a tile (default
 *   POOL_TILE_PX, 2 m per texel; quality levels choose, see lights/index.js)
 */
export function createPoolRing({ renderer, pack, createWorker = defaultWorker, workers = 2, tilePx = POOL_TILE_PX }) {
  const size = RING * tilePx;
  const ring = new THREE.DataTexture(new Uint16Array(size * size * 4), size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  ring.wrapS = ring.wrapT = THREE.RepeatWrapping;
  ring.minFilter = ring.magFilter = THREE.LinearFilter;
  ring.generateMipmaps = false;
  ring.flipY = false;
  ring.needsUpdate = true;
  const tileTex = new THREE.DataTexture(new Uint16Array(tilePx * tilePx * 4), tilePx, tilePx, THREE.RGBAFormat, THREE.HalfFloatType);
  tileTex.minFilter = tileTex.magFilter = THREE.NearestFilter;
  tileTex.generateMipmaps = false;
  tileTex.flipY = false;
  const dst = new THREE.Vector2();

  const rectV = new THREE.Vector4(0, 0, 0, 0);
  const specV = new THREE.Vector4(1 / RING_M, EDGE_M, 0, 0);
  const weightsV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  // workers: tiles go to whichever has the fewest in flight
  const transferable = {
    count: pack.count, cell: pack.cell, x0: pack.x0, y0: pack.y0, nx: pack.nx, ny: pack.ny, cellStart: pack.cellStart,
    x: pack.x, y: pack.y, mount: pack.mount, type: pack.type, lumens: pack.lumens, aim: pack.aim, lampTypes: pack.lampTypes,
  };
  const pool = Array.from({ length: workers }, () => {
    const w = createWorker();
    w.onmessage = (e) => receive(e.data);
    w.postMessage({ type: 'init', pack: transferable });
    return { w, busy: 0 };
  });
  const cache = new Map(); // key -> Uint16Array rgba (most recently used last)
  const pending = new Map(); // key -> worker entry
  const slots = new Map(); // "sx,sy" -> tile key held in the ring
  let want = null, shown = null, lastComplete = null, active = false, disposed = false, waiters = [], nextId = 1, missed = false;
  const release = () => { const w = waiters; waiters = []; for (const r of w) r(); };
  const tileMs = [];

  const tileKey = (ti, tj) => `${ti},${tj}`;
  const mod = (a) => ((a % RING) + RING) % RING;

  function receive(m) {
    if (disposed || m.type !== 'tile') return;
    const key = tileKey(m.ti, m.tj);
    const entry = pending.get(key);
    if (entry) entry.busy--;
    pending.delete(key);
    tileMs.push(m.ms);
    if (tileMs.length > 50) tileMs.shift();
    cache.set(key, m.rgba);
    while (cache.size > CACHE_TILES) {
      const oldest = cache.keys().next().value;
      if (want && inWindow(want, oldest)) break;
      cache.delete(oldest);
    }
    refresh();
  }

  function inWindow(win, key) {
    const [ti, tj] = key.split(',').map(Number);
    return ti >= win.ti0 && ti < win.ti0 + RING && tj >= win.tj0 && tj < win.tj0 + RING;
  }

  function request(ti, tj) {
    const key = tileKey(ti, tj);
    if (cache.has(key) || pending.has(key)) return;
    const entry = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
    entry.busy++;
    pending.set(key, entry);
    // px only when it is not the worker's default, so the classic renderer's messages stay as they were
    entry.w.postMessage(tilePx === POOL_TILE_PX ? { type: 'tile', id: nextId++, ti, tj } : { type: 'tile', id: nextId++, ti, tj, px: tilePx });
  }

  function upload(ti, tj, rgba) {
    tileTex.image.data.set(rgba);
    tileTex.needsUpdate = true;
    dst.set(mod(ti) * tilePx, mod(tj) * tilePx);
    renderer.copyTextureToTexture(tileTex, ring, null, dst);
    slots.set(`${mod(ti)},${mod(tj)}`, tileKey(ti, tj));
  }

  const rectOf = (w) => [w.ti0 * POOL_TILE_M, w.tj0 * POOL_TILE_M, (w.ti0 + RING) * POOL_TILE_M, (w.tj0 + RING) * POOL_TILE_M];

  /** Put the window's cached tiles into the ring and choose what to show. */
  function refresh() {
    if (!want) return;
    if (!active) { missed = true; return; } // shown when the lamps come on again (update)
    let complete = true;
    for (let j = 0; j < RING; j++) {
      for (let i = 0; i < RING; i++) {
        const ti = want.ti0 + i, tj = want.tj0 + j, key = tileKey(ti, tj);
        if (slots.get(`${mod(ti)},${mod(tj)}`) === key) continue;
        const rgba = cache.get(key);
        if (!rgba) { complete = false; continue; }
        if (!ring.__uploaded) { renderer.initTexture(ring); ring.__uploaded = true; }
        upload(ti, tj, rgba);
      }
    }
    let rect = null;
    if (complete) { lastComplete = want; rect = rectOf(want); } else if (lastComplete) {
      // the part of the last complete window whose slots still hold its tiles
      const a = rectOf(lastComplete), b = rectOf(want);
      const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
      if (r[2] > r[0] && r[3] > r[1]) {
        let ok = true;
        for (let y = r[1]; y < r[3] && ok; y += POOL_TILE_M) {
          for (let x = r[0]; x < r[2]; x += POOL_TILE_M) {
            const ti = Math.round(x / POOL_TILE_M), tj = Math.round(y / POOL_TILE_M);
            if (slots.get(`${mod(ti)},${mod(tj)}`) !== tileKey(ti, tj)) { ok = false; break; }
          }
        }
        if (ok) rect = r;
      }
    }
    shown = rect;
    if (rect) rectV.set(rect[0], rect[1], rect[2], rect[3]);
    else rectV.set(0, 0, 0, 0);
    if (complete) release();
  }

  /**
   * The lux the shown map holds at map (x, y) per channel, read from the cached tile as the GPU's bilinear filter
   * would (texel centres), or null when that tile is not in the window: for tests and probes.
   */
  function channelsAt(x, y) {
    if (!shown || x < shown[0] || y < shown[1] || x >= shown[2] || y >= shown[3]) return null;
    const cell = POOL_TILE_M / tilePx;
    const fx = x / cell - 0.5, fy = y / cell - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const out = [0, 0, 0, 0];
    for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const gx = ix + dx, gy = iy + dy, ti = Math.floor(gx / tilePx), tj = Math.floor(gy / tilePx);
      const rgba = cache.get(tileKey(ti, tj));
      if (!rgba) return null;
      const o = ((gy - tj * tilePx) * tilePx + (gx - ti * tilePx)) * 4;
      for (let c = 0; c < 4; c++) out[c] += w * fromHalf(rgba[o + c]);
    }
    return out;
  }

  return {
    ring, rect: rectV, spec: specV, weights: weightsV, tilePx,

    /** Follow the car (map metres). Off, nothing is requested and the term draws nothing. */
    update(x, y, on) {
      active = !!on;
      specV.z = active ? 1 : 0;
      if (!active) { release(); return; } // off, there is nothing to wait for
      const w = poolWindow(x, y);
      if (want && w.key === want.key) {
        // tiles that came back while the lamps were off are put in now (else the window would never complete)
        if (missed) { missed = false; refresh(); }
        return;
      }
      missed = false;
      want = w;
      // nearest tiles first
      const order = [];
      for (let j = 0; j < RING; j++) for (let i = 0; i < RING; i++) order.push([w.ti0 + i, w.tj0 + j]);
      const cx = x / POOL_TILE_M - 0.5, cy = y / POOL_TILE_M - 0.5;
      order.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
      for (const [ti, tj] of order) request(ti, tj);
      refresh();
    },

    /** Channel weights, each [r, g, b] (what a channel's lux becomes: the renderer's term decides the units). */
    setWeights(weights) { weights.forEach((w, i) => weightsV[i].set(w[0], w[1], w[2])); },
    channelsAt,

    whenSettled() {
      if (!active || !want || (shown && lastComplete === want)) return Promise.resolve();
      return new Promise((r) => waiters.push(r));
    },
    stats() {
      const sorted = [...tileMs].sort((a, b) => a - b);
      return { tiles: cache.size, pending: pending.size, shown: !!shown, complete: !!(want && lastComplete === want), tileMsP50: sorted[Math.floor(sorted.length / 2)] ?? null };
    },
    dispose() {
      disposed = true;
      for (const p of pool) p.w.terminate?.();
      ring.dispose();
      tileTex.dispose();
      release();
    },
  };
}

/** Half bits to a number. */
function fromHalf(u) {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

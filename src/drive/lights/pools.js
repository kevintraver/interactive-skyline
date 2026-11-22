// The lamp pool map around the car (plan 02, D5.4; section 7.8), and its term on the drive's surfaces.
//
// A ring texture of RING x RING tiles (POOL_TILE_M metres, POOL_TILE_PX texels each: 2048 m at 2 m per texel),
// RGBA half floats in lux, one channel per light class and switching slice (poolTile.js). Tile (ti, tj) always sits
// in ring slot (ti mod RING, tj mod RING), so the texture is read with repeat wrapping at map / (RING x tile) and
// moving the window only replaces the tiles that left it. The window is RING x RING tiles centred on the car's
// position snapped to the tile grid, so what is drawn is a function of where the car is, not of the way it came.
// Tiles are splatted in workers (pools.worker.js) and kept in a small cache; a window shows once all its tiles are
// in, and until then the part of the last complete window that the new one shares.
//
// The surface term (surfaceLight.js) adds albedo x E / pi with E = sum over channels of lux x weight, where each
// weight is the colour of the class x the lit share of the slice x the warm-up flux x lighting.units.lux x the dusk
// fade, worked out per frame on the CPU (setWeights). Buildings take a share on walls (WALL) and roofs (ROOF):
// the map holds illuminance on level ground.

import * as THREE from 'three';
import { POOL_TILE_M, POOL_TILE_PX } from './poolTile.js';
import { addSurfaceTerm } from './surfaceLight.js';

export const RING = 4;
const RING_M = RING * POOL_TILE_M;
const CACHE_TILES = 40;
/** Fade at the window's edge, metres. */
const EDGE_M = 120;
const WALL = 0.5, ROOF = 0.35;

const defaultWorker = () => new Worker(new URL('./pools.worker.js', import.meta.url), { type: 'module' });

/** The window's tile range for a car at map (x, y): [ti0, tj0], RING tiles each way. Pure. */
export function poolWindow(x, y) {
  const ti0 = Math.round(x / POOL_TILE_M) - RING / 2, tj0 = Math.round(y / POOL_TILE_M) - RING / 2;
  return { ti0, tj0, key: `${ti0},${tj0}` };
}

const TERM_HEAD = /* glsl */ `
uniform sampler2D uLampPool;
uniform vec4 uLampPoolRect;   // x0, y0, x1, y1 of the shown window (map metres)
uniform vec4 uLampPoolSpec;   // 1 / ring size (m), edge fade (m), on (0/1), unused
uniform vec3 uLampPoolW[4];   // weight of each channel (colour x lit share x warm-up x units x fade)`;

const termBody = (surface) => /* glsl */ `
if ( uLampPoolSpec.z > 0.5 ) {
  vec2 slMap = vec2( slWorld.x, -slWorld.z );
  vec2 slIn = min( slMap - uLampPoolRect.xy, uLampPoolRect.zw - slMap );
  float slFade = clamp( min( slIn.x, slIn.y ) / uLampPoolSpec.y, 0.0, 1.0 );
  if ( slFade > 0.0 ) {
    vec4 slP = texture( uLampPool, slMap * uLampPoolSpec.x );
    vec3 slPool = slP.r * uLampPoolW[0] + slP.g * uLampPoolW[1] + slP.b * uLampPoolW[2] + slP.a * uLampPoolW[3];
    ${surface === 'building' ? `slPool *= mix( ${WALL.toFixed(2)}, ${ROOF.toFixed(2)}, smoothstep( 0.5, 0.9, slNormal.y ) );` : 'slPool *= clamp( slNormal.y * 1.5, 0.0, 1.0 );'}
    slE += slPool * slFade;
  }
}`;

/**
 * @param {{ renderer: THREE.WebGLRenderer, pack: object, createWorker?: () => Worker, workers?: number }} opts
 *   pack: the decoded lamp product (pack.js), sent to the workers once
 */
export function createPools({ renderer, pack, createWorker = defaultWorker, workers = 2 }) {
  const size = RING * POOL_TILE_PX;
  const ring = new THREE.DataTexture(new Uint16Array(size * size * 4), size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  ring.wrapS = ring.wrapT = THREE.RepeatWrapping;
  ring.minFilter = ring.magFilter = THREE.LinearFilter;
  ring.generateMipmaps = false;
  ring.flipY = false;
  ring.needsUpdate = true;
  const tileTex = new THREE.DataTexture(new Uint16Array(POOL_TILE_PX * POOL_TILE_PX * 4), POOL_TILE_PX, POOL_TILE_PX, THREE.RGBAFormat, THREE.HalfFloatType);
  tileTex.minFilter = tileTex.magFilter = THREE.NearestFilter;
  tileTex.generateMipmaps = false;
  tileTex.flipY = false;
  const dst = new THREE.Vector2();

  const uniforms = {
    uLampPool: { value: ring },
    uLampPoolRect: { value: new THREE.Vector4(0, 0, 0, 0) },
    uLampPoolSpec: { value: new THREE.Vector4(1 / RING_M, EDGE_M, 0, 0) },
    uLampPoolW: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
  };
  const terms = {
    ground: { id: 'lampPools', key: 'ground-v1', uniforms, head: TERM_HEAD, body: termBody('ground') },
    building: { id: 'lampPools', key: 'building-v1', uniforms, head: TERM_HEAD, body: termBody('building') },
  };

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
    entry.w.postMessage({ type: 'tile', id: nextId++, ti, tj });
  }

  function upload(ti, tj, rgba) {
    tileTex.image.data.set(rgba);
    tileTex.needsUpdate = true;
    dst.set(mod(ti) * POOL_TILE_PX, mod(tj) * POOL_TILE_PX);
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
    if (rect) uniforms.uLampPoolRect.value.set(rect[0], rect[1], rect[2], rect[3]);
    else uniforms.uLampPoolRect.value.set(0, 0, 0, 0);
    if (complete) release();
  }

  return {
    uniforms, terms, ring,
    /** Add the pool term to a material: surface 'ground' (road, terrain) or 'building'. Returns a remover. */
    attach(material, surface = 'ground') { return addSurfaceTerm(material, terms[surface] || terms.ground); },

    /** Follow the car (map metres). Off, nothing is requested and the term draws nothing. */
    update(x, y, on) {
      active = !!on;
      uniforms.uLampPoolSpec.value.z = active ? 1 : 0;
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

    /** Channel weights (scene irradiance per lux), each [r, g, b]. */
    setWeights(weights) { weights.forEach((w, i) => uniforms.uLampPoolW.value[i].set(w[0], w[1], w[2])); },

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

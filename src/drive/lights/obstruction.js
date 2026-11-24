// The `obstruction` drive part (plan 02, D5.6): red obstruction lights on every building above 61 m (200 ft; the
// threshold is ASSUMED, after FAA AC 70/7460-1M), by rule from the building list, as light sprites (sprites.js).
//
// Which buildings: the app's removable towers (src/city/buildings.js `tall`: { data, mesh, offset }), and the
// drive corridor's tall set (public/data/<city>/corridor/tall.bin, every building of 20 m or more along the
// routes). A tower's lights are attached to it: hiding it removes them and moving it moves them, following the
// app's edit events ('buildings:changed', 'buildings:rebuilt'; src/app/events.js), which the drive's context carries
// (index.js contextOf). Corridor buildings cannot be edited. A context without the bus falls back to checking the
// towers before each draw.
//
// Where: at the top of the building's highest volume. A roof up to 30 m across gets one lamp at its middle; a
// larger one a lamp at each of its two to four outline corners farthest apart (the advisory circular asks for
// lights at the corners of wide structures). A landmark model drawn lower than its footprint data gets one lamp
// at the model's highest point.
//
// What: up to 151 m (500 ft), steady red L-810 lamps (32.5 cd). Above it the lamps flash together as an L-864
// beacon (2,000 cd at night) at 30 flashes a minute, 0.5 s on: 0.5 Hz, far inside the comfort limit of section
// 4.11 (no flashing above 3 Hz). A building's flash phase is a hash of its id, so the beacons of a skyline do not
// blink in step, and the flash is a pure function of simulation time.
//
// When: from dusk, by the look's `lights` (0 by day, 1 by night, as the street lamps), scaled into the scene by
// env.js's units like every light source of the drive.
//
// Plan 01's renderer (third stretch, decisions 2 and 6): the same part with sprites.node.js, picked by ctx.legacy. The
// lamps are their candela there (photometry.node.js: the pre-exposure and the lights-out slider); the look's `lights`
// still says when they are on, but no longer fades them in the shipped look (display.js).

import { curveDrop } from '../../world/frame.js';
import { decodeCell } from '../corridor/format.js';
import { groundUnder } from '../corridor/mesher.js';
import { displayFade, displayOfSearch } from './display.js';
import { createTimings } from '../timing.js';

/** Buildings taller than this (metres above their ground) carry obstruction lights. */
export const OBSTRUCTION_M = 61;
/** Above this the lamps flash (an L-864 beacon); below it they burn steady (L-810). */
export const FLASH_FROM_M = 151;
export const STEADY_CD = 32.5;
export const FLASH_CD = 2000;
/** Flashes per minute and the time a flash is on. */
export const FLASH_PER_MIN = 30;
export const FLASH_ON_S = 0.5;
/** A roof wider than this gets corner lamps instead of one in its middle. */
export const CORNER_FROM_M = 30;
/** How far above the roof the lamp's centre sits. */
const LAMP_ABOVE_M = 0.6;
/** Red, linear sRGB with luminance 1 (sprites.js colours): an aviation-red filter, x 0.69, y 0.31 ASSUMED. */
export const RED = (() => { const c = [1, 0.035, 0.01]; const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return c.map((v) => v / l); })();

/** FNV-1a over the id's text: a stable 32-bit hash. */
export function hash32(id) {
  const s = String(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** The building's flash phase, 0..1 of a period. */
export const flashPhase = (id) => hash32(id) / 4294967296;

/** 1 while building `id`'s beacon is lit at simulation time simMs, else 0. */
export function flashOn(id, simMs) {
  const period = 60000 / FLASH_PER_MIN;
  const t = (((simMs / period + flashPhase(id)) % 1) + 1) % 1;
  return t * period < FLASH_ON_S * 1000 ? 1 : 0;
}

/**
 * Lamp points (map metres, [x, y]) on a roof outline given as a flat [x0, y0, x1, y1, ...] ring: its middle when it
 * is at most CORNER_FROM_M across, else 2 to 4 corners chosen farthest apart.
 */
export function roofPoints(flat) {
  const n = flat.length / 2;
  if (n < 1) return [];
  let cx = 0, cy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = flat[2 * i], y = flat[2 * i + 1];
    cx += x; cy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const span = Math.hypot(x1 - x0, y1 - y0);
  if (span <= CORNER_FROM_M) return [[cx / n, cy / n]];
  const want = span > 3 * CORNER_FROM_M ? 4 : span > 2 * CORNER_FROM_M ? 3 : 2;
  // farthest-point sampling from the corner farthest from the middle
  const d = (i, p) => Math.hypot(flat[2 * i] - p[0], flat[2 * i + 1] - p[1]);
  let first = 0;
  for (let i = 1; i < n; i++) if (d(i, [cx / n, cy / n]) > d(first, [cx / n, cy / n])) first = i;
  const out = [[flat[2 * first], flat[2 * first + 1]]];
  while (out.length < Math.min(want, n)) {
    let best = -1, bestD = -1;
    for (let i = 0; i < n; i++) {
      const m = Math.min(...out.map((p) => d(i, p)));
      if (m > bestD) { bestD = m; best = i; }
    }
    if (bestD < 1) break;
    out.push([flat[2 * best], flat[2 * best + 1]]);
  }
  return out;
}

/**
 * The obstruction lights of one of the app's towers, or null below the threshold: { id, height, flashing,
 * points: [[x, y]] (map metres), top (scene y of the roof) }. Its highest volume carries them.
 * @param {{ data: { id: string, ground: number, v: { o: number[], t: number }[] } }} entry  @param {number} base
 */
export function towerLights(entry, base) {
  const b = entry.data;
  if (!b?.v?.length) return null;
  let top = b.v[0];
  for (const v of b.v) if (v.t > top.t) top = v;
  const height = top.t - b.ground;
  if (!(height > OBSTRUCTION_M)) return null;
  // a landmark model may stand lower than the footprint data says: the lamps go on what is drawn
  // (one lamp at the model's highest point, a spire's tip)
  const pos = entry.mesh?.geometry?.attributes?.position;
  if (pos) {
    let k = 0;
    for (let i = 1; i < pos.count; i++) if (pos.getY(i) > pos.getY(k)) k = i;
    if (pos.getY(k) < top.t - base - 1) {
      return { id: b.id, height, flashing: height > FLASH_FROM_M, points: [[pos.getX(k), -pos.getZ(k)]], top: pos.getY(k) };
    }
  }
  return { id: b.id, height, flashing: height > FLASH_FROM_M, points: roofPoints(top.o), top: top.t - base };
}

/**
 * The obstruction lights of the corridor's tall set (a decoded tall.bin): [{ id, height, flashing, points, top }],
 * tops on the drawn ground (heightAt) with the scene's curvature drop at the building.
 */
export function corridorLights(cell, heightAt, base) {
  const out = [];
  const { groundMean } = groundUnder(cell, heightAt);
  const [cx, cy] = cell.origin, u = cell.unit, P = cell.points;
  for (let k = 0; k < cell.count; k++) {
    const h = cell.height[k] / 10; // decimetres (corridor/format.js)
    if (!(h > OBSTRUCTION_M)) continue;
    const r = cell.ringStart[k], a = cell.pointStart[r], e = cell.pointStart[r + 1];
    const flat = [];
    for (let p = a; p < e; p++) flat.push(cx + P[2 * p] / u, cy + P[2 * p + 1] / u);
    const pts = roofPoints(flat);
    const [mx, my] = pts[0];
    out.push({ id: `corridor:${k}:${Math.round(mx)}:${Math.round(my)}`, height: h, flashing: h > FLASH_FROM_M, points: pts,
      top: groundMean[k] + h - base - curveDrop(mx, my) });
  }
  return out;
}

/** @param {object} ctx the part context (parts.js) */
export async function createObstructionPart(ctx) {
  const { app, env, base } = ctx;
  const { renderer, camera } = app;
  const tall = app.tall || [];
  const legacy = ctx.legacy !== false;
  const { createSpriteLayer } = await (legacy ? import('./sprites.js') : import('./sprites.node.js'));
  const display = legacy ? 'classic' : displayOfSearch(globalThis.location?.search);

  // the corridor's tall buildings (fixed); missing data leaves just the towers
  let corridor = [];
  try {
    const index = await ctx.optional('corridor/index.json');
    if (index?.tall?.file) {
      const buf = await ctx.get(`corridor/${index.tall.file}`).then((r) => r.arrayBuffer());
      corridor = corridorLights(decodeCell(buf), ctx.terrain.surfaceAt, base);
    }
  } catch (err) {
    console.warn('obstruction: no corridor lights', err);
  }

  let towers = [];
  const scan = () => { towers = tall.map((e) => ({ entry: e, lights: towerLights(e, base) })).filter((t) => t.lights); };
  scan();
  const capacity = Math.max(64, (corridor.reduce((a, c) => a + c.points.length, 0) + 4 * tall.length + 64));
  const layer = createSpriteLayer({ capacity, name: 'obstruction-lights', minPx: 1.2, ...(legacy ? {} : { photometry: { nodes: env.nodes } }) });
  layer.mesh.visible = false;
  ctx.group.add(layer.mesh);

  // the instances: rewritten when a tower is hidden, shown or moved, or when the beacons' flash changes
  let count = 0, lights = 0, on = false, dirty = true, lastFlash = '';
  const flashers = []; // [instance, id] of flashing lamps
  const timings = createTimings();
  const pos = [0, 0, 0];
  function write(simMs) {
    count = 0; flashers.length = 0;
    const put = (id, x, y, top, flashing, lit) => {
      if (count >= capacity) return;
      pos[0] = x; pos[1] = top + LAMP_ABOVE_M; pos[2] = -y;
      layer.set(count, { position: pos, color: RED, intensity: flashing ? FLASH_CD * lit : STEADY_CD, pattern: 0, diameter: 0.3 });
      if (flashing) flashers.push([count, id]);
      count++;
    };
    for (const { entry, lights: l } of towers) {
      if (!entry.mesh.visible) continue; // hidden: no lights
      const o = entry.offset; // moved: the lights go with it (offset.y follows the ground at the new place)
      const lit = l.flashing ? flashOn(l.id, simMs) : 1;
      for (const [x, y] of l.points) put(l.id, x + o.x, y - o.z, l.top + o.y, l.flashing, lit);
    }
    for (const c of corridor) {
      const lit = c.flashing ? flashOn(c.id, simMs) : 1;
      for (const [x, y] of c.points) put(c.id, x, y, c.top, c.flashing, lit);
    }
    layer.commitRows(count);
    dirty = false;
  }
  const flashKey = (simMs) => { let k = ''; for (const [, id] of flashers) k += flashOn(id, simMs); return k; };

  // The edit events (every hide, show, move and put-back emits 'buildings:changed'; the height cutoff
  // 'buildings:rebuilt'). Without the bus, a check of the towers' visibility and offsets before each draw (a
  // hundred-odd numbers) does the same a frame later.
  const events = app.events;
  const offChanged = events?.on('buildings:changed', () => { dirty = true; app.invalidate?.(); });
  let lastEdit = '', lastTall = tall.length;
  const editKey = () => { let k = ''; for (const { entry: e } of towers) k += e.mesh.visible ? `${e.offset.x},${e.offset.y},${e.offset.z};` : 'h;'; return k; };
  const offRebuilt = events?.on('buildings:rebuilt', () => { scan(); dirty = true; app.invalidate?.(); });
  /** Without the bus: notice a rebuild or an edit by looking. */
  function poll() {
    if (tall.length !== lastTall || (tall.length && towers.length && !tall.includes(towers[0].entry))) { lastTall = tall.length; scan(); dirty = true; } // the height cutoff rebuilt the towers
    const ek = editKey();
    if (ek !== lastEdit) { lastEdit = ek; dirty = true; }
  }
  let simMs = 0;

  return {
    name: 'obstruction',
    update(frame) {
      simMs = frame.simMs;
    },
    setLook(look) {
      lights = look.lights ?? (look.night ? 1 : 0);
      on = lights > 0;
      layer.mesh.visible = on;
    },
    beforeRender() {
      if (!on) return;
      const t0 = performance.now();
      if (!events) poll();
      if (dirty) { write(simMs); lastFlash = flashKey(simMs); } else if (flashers.length) {
        const k = flashKey(simMs);
        if (k !== lastFlash) { lastFlash = k; for (const [i, id] of flashers) layer.data[0][i * 4 + 3] = FLASH_CD * flashOn(id, simMs); layer.commitRows(count); }
      }
      layer.setFrame({
        camera, renderer, ...(legacy ? { gain: env.lighting.units.nit * lights } : { fade: displayFade({ legacy, display, fade: lights }) }),
        visibility: env.weather.state().visibilityM || 80000,
      });
      timings.add(performance.now() - t0);
    },
    stats() {
      const t = timings.summary();
      return { on, lights, renderer: legacy ? 'classic' : 'node', display, lamps: count, towers: towers.length, corridor: corridor.length, flashing: flashers.length, sprites: on ? layer.drawn : 0, js: { mean: t.mean, p95: t.p95 } };
    },
    /** For tests: the lamps as drawn, [{ x, y, z, intensity }]. */
    lamps() {
      if (!events) poll();
      if (dirty) write(simMs);
      const a = layer.data[0];
      return Array.from({ length: count }, (_, i) => ({ x: a[4 * i], y: a[4 * i + 1], z: a[4 * i + 2], intensity: a[4 * i + 3] }));
    },
    dispose() { offChanged?.(); offRebuilt?.(); layer.dispose(); },
  };
}

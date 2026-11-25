// The regional terrain of a flight (plan 03, sections 7.9, 7.14 and 9; F4.7, F6.1): region, approaches and valley
// from terrain.json, drawn under and around the map's near and far grids out to the horizon, and one height function
// over all of them. Replaces, while flying, the drive's wide grid and the plain virtual ground of src/flight/world.js.
//
//   const region = createRegionTerrain({ meta, baseUrl: '/data/lv', frame, terrain, nodes: fe.nodes, quality: app.quality });
//   scene.add(region.group);
//   // every frame, after the camera is placed:
//   region.update({ camera, position: state.position, height: renderer.getDrawingBufferSize(v).y });
//   const y = region.surfaceY(x, north);    // scene Y of the ground as drawn
//   await region.whenSettled();             // nothing loading
//   region.dispose();
//
// Loading follows the camera: the grids the eye can see (nested.js needed(): as far as the horizon plus a summit
// beyond it, no further than the far plane) are fetched coarsest first, decoded (decode.js), drawn as they arrive
// (meshes.js), and their textures and meshes are released once they have not been needed for a while; their heights
// stay (2 MB each) so heightAt never changes under the aircraft.
//
// What the module does not own: the map's near and far meshes (the map draws them, and valley is cut and sunk under
// far), the sky, the far plane (src/flight/view/layers.js nearFar), and the fog (the scene's).

import { Group, Vector2 } from 'three';
import { altitudeOf } from '../../core/earth.js';
import { decodeGrid } from './decode.js';
import { createNested, NESTED_ORDER, extentOf } from './nested.js';
import {
  createGridMeshes, createOuterGround, gridTexture, setPhoto, chooseStrides, cameraFrustum, boxInFrustum, beyondHorizon,
  BUDGET, SINK, TARGET_PX,
} from './meshes.js';

/** A grid not needed for this long (ms) has its meshes and texture released. */
export const RELEASE_AFTER_MS = 20000;

/** Whether grid `inner`'s edges lie on `outer`'s posts (then the two share an edge and nothing need be sunk). */
const onPosts = (outer, inner) => [inner.x0 - outer.x0, inner.x1 - outer.x0, inner.y0 - outer.y0, inner.y1 - outer.y0]
  .every((v) => Math.abs(v / outer.step - Math.round(v / outer.step)) < 1e-6);

/**
 * @param {{ meta: object, baseUrl: string, frame: { base: number }, terrain: object, nodes?: object,
 *           quality?: { level?: string }, fetch?: typeof fetch,
 *           loadImage?: (url: string, opts: { half: boolean }) => Promise<ImageBitmap | null>, anisotropy?: number,
 *           names?: string[], now?: () => number }} o
 *   meta: terrain.json. baseUrl: the folder its files are in. frame: the city's frame (src/world/frame.js createFrame:
 *   its base). terrain: the app's provider (src/world/terrain/index.js createTerrain), whose near and far grids answer
 *   heights first and whose far grid valley is cut under. nodes: the environment's nodes (env.nodes), for aerial
 *   perspective. quality: app.quality, for the triangle budget and, on Low, images at half size. fetch: for the grids'
 *   heights. loadImage: how an image becomes an ImageBitmap decoded flipped (the default fetches it and calls
 *   createImageBitmap); returning null draws the grid plain. names: which nested grids to serve (all three by default).
 */
export function createRegionTerrain({
  meta, baseUrl, frame, terrain, nodes = null, quality = null, fetch: fetchFn = globalThis.fetch?.bind(globalThis),
  loadImage = null, anisotropy = 8, names = NESTED_ORDER, now = () => (globalThis.performance ? performance.now() : Date.now()),
}) {
  const base = frame.base;
  const entries = Object.fromEntries(names.filter((n) => meta.grids[n]).map((n) => [n, meta.grids[n]]));
  const order = NESTED_ORDER.filter((n) => entries[n]);
  const extents = Object.fromEntries(order.map((n) => [n, extentOf(entries[n])]));
  const nested = createNested({ terrain, base, extents });
  const far = terrain.grid('far');
  const farExtent = far ? extentOf(far) : null;
  const level = quality?.level ?? 'high';
  const half = level === 'low';
  const url = (f) => `${baseUrl.replace(/\/$/, '')}/${f}`;
  const fetchImage = loadImage ?? (async (u, { half: h }) => {
    const r = await fetchFn(u);
    if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
    const blob = await r.blob();
    const o = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    if (h) {
      const full = await createImageBitmap(blob);
      const w = Math.max(1, full.width >> 1), hh = Math.max(1, full.height >> 1);
      full.close?.();
      return createImageBitmap(blob, { ...o, resizeWidth: w, resizeHeight: hh, resizeQuality: 'high' });
    }
    return createImageBitmap(blob, o);
  });

  const group = new Group();
  group.name = 'flight-region-terrain';
  /** name -> { state: 'heights' | 'loading' | 'ready' | 'failed', meshes, lastNeeded, error, decodeMs, imageMs, buildMs } */
  const grids = new Map(order.map((n) => [n, { state: 'idle', meshes: null, lastNeeded: -Infinity, error: null }]));
  /** name -> promise of the heights, once asked for */
  const heightLoads = new Map();
  let outer = null, imagery = true, lastStats = null, settledOnce = null;

  /** The holes in grid `name`: the next finer grid that is drawn (its extent), else far (sunk under it). */
  function holesFor(name) {
    const e = extents[name];
    for (const finer of order.slice(order.indexOf(name) + 1)) {
      if (grids.get(finer).state === 'ready') {
        const f = extents[finer];
        return [{ ...f, sink: onPosts(entries[name], f) ? 0 : SINK }];
      }
    }
    return farExtent && farExtent.x0 >= e.x0 && farExtent.x1 <= e.x1 && farExtent.y0 >= e.y0 && farExtent.y1 <= e.y1
      ? [{ ...farExtent, sink: SINK, curtain: far }] : [];
  }
  const sameHoles = (a, b) => a && b && a.length === b.length && a.every((h, k) => ['x0', 'x1', 'y0', 'y1', 'sink'].every((p) => h[p] === b[k][p]));
  /** Re-cut every drawn grid whose holes changed (a finer grid arrived or was released). */
  function relayer() {
    for (const n of order) {
      const g = grids.get(n);
      if (g.state !== 'ready') continue;
      const h = holesFor(n);
      if (!sameHoles(h, g.meshes.holes)) g.meshes.setHoles(h);
    }
  }

  /** Fetch and decode a grid's heights once; heightAt answers from it as soon as it is in. */
  function loadHeights(name) {
    if (!heightLoads.has(name)) {
      const e = entries[name];
      const p = (async () => {
        const r = await fetchFn(url(e.file));
        if (!r.ok) throw new Error(`${e.file}: HTTP ${r.status}`);
        const d = await decodeGrid(await r.arrayBuffer(), e);
        const gf = nested.add(name, d);
        grids.get(name).decodeMs = d.decodeMs;
        return gf;
      })();
      heightLoads.set(name, p);
      p.catch(() => heightLoads.delete(name));
      nested.track(name, p);
    }
    return heightLoads.get(name);
  }

  /** Fetch a grid's heights and image, and build its meshes. */
  function loadGrid(name) {
    const g = grids.get(name);
    if (g.state === 'loading' || g.state === 'ready') return g.promise;
    g.state = 'loading';
    g.error = null;
    const e = entries[name];
    g.promise = (async () => {
      const t0 = now();
      const [gf, bitmap] = await Promise.all([
        loadHeights(name),
        e.image?.file ? fetchImage(url(e.image.file), { half }).catch((err) => { g.imageError = String(err); return null; }) : null,
      ]);
      g.imageMs = now() - t0;
      if (g.state !== 'loading') { bitmap?.close?.(); return; } // released or disposed meanwhile
      const t1 = now();
      const map = bitmap ? gridTexture(bitmap, anisotropy) : null;
      g.meshes = createGridMeshes({ name, grid: gf, base, map, holes: holesFor(name), nodes });
      setPhoto(g.meshes.material, imagery);
      g.buildMs = now() - t1;
      g.state = 'ready';
      group.add(g.meshes.group);
      if (name === order[0] && !outer && e.edgeColor) {
        outer = createOuterGround({ region: gf, base, color: e.edgeColor.linear, nodes });
        group.add(outer);
      }
      relayer();
    })().catch((err) => { g.state = 'failed'; g.error = String(err?.message ?? err); throw err; });
    nested.track(name, g.promise);
    return g.promise;
  }

  /** Release a grid's meshes and texture (its heights stay). */
  function release(name) {
    const g = grids.get(name);
    if (g.state === 'loading') { g.state = 'idle'; return; }
    if (g.state !== 'ready') return;
    group.remove(g.meshes.group);
    g.meshes.dispose();
    g.meshes = null;
    g.state = 'idle';
    if (name === order[0] && outer) { group.remove(outer); outer.geometry.dispose(); outer.material.dispose(); outer = null; }
    relayer();
  }

  const _size = new Vector2();
  return {
    /** Add to the scene; holds every grid's chunks and the ground beyond region. */
    group,
    /** Metres above sea level: near, far, valley, approaches, region, the finest loaded that covers the point. */
    heightAt: nested.heightAt,
    /** Scene Y of heightAt (base removed, the datum's curve applied). */
    groundY: nested.groundY,
    /** Scene Y of the ground as drawn (the map's surface inside far, a grid's triangles beyond it). */
    surfaceY: nested.surfaceY,
    /** The grid that answers a height at a map point ('near', 'far', 'valley', 'approaches', 'region'). */
    sourceAt: nested.sourceAt,
    /** A grid's surface by name ('near', 'far' or a loaded nested grid; nested.js gridField), or null. */
    grid: nested.grid,
    /** Which grids a camera needs (nested.js needed). */
    needed: nested.needed,
    /**
     * Every frame while flying: load what the eye can see, release what it has not needed for RELEASE_AFTER_MS, cull
     * chunks against the frustum and the horizon, and choose each chunk's stride within the triangle budget.
     * @param {{ camera: import('three').PerspectiveCamera, position?: { x: number, y: number, z: number },
     *           height?: number, renderer?: object }} o  position: where the loads are judged from (the aircraft;
     *   default the camera); height: the drawing buffer's height in pixels (or a renderer to read it from)
     */
    update({ camera, position = null, height = null, renderer = null }) {
      const t = now();
      camera.updateMatrixWorld();
      const p = position ?? camera.position;
      const altitude = altitudeOf(p, { base });
      const want = nested.needed({ x: p.x, y: -p.z, altitude, far: camera.far });
      for (const n of want) {
        const g = grids.get(n);
        g.lastNeeded = t;
        if (g.state === 'idle') loadGrid(n).catch(() => {});
      }
      for (const n of order) if (!want.includes(n) && t - grids.get(n).lastNeeded > RELEASE_AFTER_MS) release(n);
      const px = height ?? (renderer ? renderer.getDrawingBufferSize(_size).y : 1080);
      const focalPx = (px / (2 * Math.tan((camera.fov * Math.PI) / 360))) * (camera.zoom || 1);
      const frustum = cameraFrustum(camera);
      const eye = [camera.position.x, camera.position.y, camera.position.z];
      const eyeAlt = altitudeOf(camera.position, { base });
      const all = [], owner = [];
      for (const n of order) {
        const g = grids.get(n);
        if (g.state !== 'ready') continue;
        for (const c of g.meshes.chunks) { all.push(c); owner.push(n); }
      }
      const visible = all.map((c) => boxInFrustum(frustum, c.box) && !beyondHorizon(eye, eyeAlt, c));
      const budget = BUDGET[level] ?? BUDGET.high;
      const pick = chooseStrides(all, { eye, focalPx, budget, targetPx: TARGET_PX, visible });
      let k = 0;
      for (const n of order) {
        const g = grids.get(n);
        if (g.state !== 'ready') continue;
        const m = g.meshes.chunks.length;
        g.meshes.apply(pick.strides.slice(k, k + m));
        k += m;
      }
      const perGrid = {};
      all.forEach((c, i) => {
        const s = pick.strides[i];
        const o = (perGrid[owner[i]] ??= { chunks: 0, drawn: 0, triangles: 0, strides: {} });
        o.chunks++;
        if (!s) return;
        const r = c.ranges.find((x) => x.stride === s);
        o.drawn++;
        o.triangles += r.surface + r.skirt;
        o.strides[s] = (o.strides[s] || 0) + 1;
      });
      lastStats = {
        needed: want, triangles: pick.triangles, targetPx: +pick.targetPx.toFixed(2),
        // the chunks drawn, the ground beyond region, and the curtain under far's edge (when they are in view)
        drawCalls: pick.strides.filter(Boolean).length + (outer ? 1 : 0) + order.reduce((n, name) => n + (grids.get(name).meshes?.curtains.length ?? 0), 0),
        budget, focalPx: +focalPx.toFixed(1), grids: perGrid, cpuMs: +(now() - t).toFixed(3),
        curtains: order.reduce((n, name) => n + (grids.get(name).meshes?.curtains.length ?? 0), 0),
      };
      return lastStats;
    },
    /** Load the grids a position needs now and resolve when they are drawn (for a flight's first frame). */
    preload({ x, y, altitude, far: farPlane }) {
      const want = nested.needed({ x, y, altitude, far: farPlane });
      const t = now();
      return Promise.allSettled(want.map((n) => { grids.get(n).lastNeeded = t; return loadGrid(n); }));
    },
    /** Resolves once nothing is loading. */
    whenSettled: () => nested.whenSettled(),
    /** Resolves when the first grids asked for have been drawn (or failed). */
    get ready() { return settledOnce ??= nested.whenSettled(); },
    /** The aerial images on or off (the map's imagery setting); off draws the plain ground colour. */
    setImagery(on) {
      imagery = !!on;
      for (const g of grids.values()) if (g.meshes) setPhoto(g.meshes.material, imagery);
    },
    /** What was drawn at the last update, and what is loaded. */
    stats() {
      const loaded = {};
      for (const [n, g] of grids) {
        loaded[n] = {
          state: g.state, error: g.error, imageError: g.imageError ?? null, chunks: g.meshes?.chunks.length ?? 0,
          decodeMs: g.decodeMs != null ? +g.decodeMs.toFixed(1) : null, imageMs: g.imageMs != null ? +g.imageMs.toFixed(1) : null,
          buildMs: g.buildMs != null ? +g.buildMs.toFixed(1) : null,
          heights: nested.has(n),
          holes: g.meshes?.holes.map(({ x0, x1, y0, y1, sink, curtain }) => ({ x0, x1, y0, y1, sink, ...(curtain ? { curtain: true } : {}) })) ?? null,
        };
      }
      return { ...(lastStats ?? {}), loaded, outer: !!outer };
    },
    /** Release everything on the GPU; heights go with the module. */
    dispose() {
      for (const n of order) release(n);
      for (const g of grids.values()) g.state = 'idle';
      if (outer) { group.remove(outer); outer.geometry.dispose(); outer.material.dispose(); outer = null; }
      group.removeFromParent();
    },
  };
}

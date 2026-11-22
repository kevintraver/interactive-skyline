// The terrain provider: heights for everything that stands on the ground. Pure, no three.js.
//
// Today it serves three fixed grids from public/data/<city>/: near and far, which main.js has
// already downloaded, and the coarse wide grid that reaches the drive routes, fetched on demand;
// and the drive's patches (terrain.json's "patches"): small finer grids inside the wide one where
// its posts lose the shape of the land (Black Canyon at Hoover Dam), fetched on demand too. A height
// comes from the finest loaded grid or patch that contains the point. A patch's edges lie on wide
// posts and its heights ease into the wide grid's there (scripts/build_terrain.py), so a height is
// continuous across its edge.
// The interface is the one the deferred tile pyramid will keep (plan 02, sections 5.5 and 11.2),
// so setViews, prefetchAlong and update are accepted and do nothing yet.

import { curveDrop } from '../frame.js';
import { heightField } from './heightfield.js';

export { heightField };

/**
 * @param {{ meta: object, buffers: { near: ArrayBuffer, far: ArrayBuffer }, base: number,
 *           fetchBinary: (file: string) => Promise<ArrayBuffer> }} opts
 *   meta is terrain.json; fetchBinary loads a file next to it, for grids loaded later.
 */
export function createTerrain({ meta, buffers, base, fetchBinary }) {
  const near = heightField(buffers.near, meta.grids.near);
  const far = heightField(buffers.far, meta.grids.far);
  let wide = null;
  let wideLoad = null;
  const patchMeta = meta.patches || {};
  /** id -> heightField, once loaded */
  const patches = new Map();
  let patchLoad = null;
  const inFlight = new Set();
  // every loaded grid and patch, finest first; the last one answers outside them all (its clamped edge)
  let layers = [];
  const relayer = () => {
    layers = [near, ...patches.values(), far, ...(wide ? [wide] : [])].sort((a, b) => a.step - b.step);
  };
  relayer();

  /** Height above sea level: the finest loaded grid that contains the point; outside them all, the coarsest one's edge. */
  const heightAt = (x, y) => {
    const n = layers.length - 1;
    for (let k = 0; k < n; k++) if (layers[k].contains(x, y)) return layers[k].sample(x, y);
    return layers[n].sample(x, y);
  };

  const track = (p) => {
    inFlight.add(p);
    const done = () => inFlight.delete(p);
    p.then(done, done);
    return p;
  };

  return {
    apiVersion: 1,
    heightAt,
    /** Scene Y of the ground. Inside near or far this is exactly main.js's groundY. */
    groundY: (x, y) => heightAt(x, y) - base - curveDrop(x, y),
    /** Inside the detailed (near) grid: where buildings may be placed and moved, as place() in main.js requires. */
    inBuildArea: (x, y, inset = 0) => near.contains(x, y, inset),
    /** A grid by name ('near', 'far', 'wide') or a patch by its id; null until it is loaded. */
    grid: (name) => ({ near, far, wide })[name] ?? patches.get(name) ?? null,
    hasWide: Boolean(meta.grids.wide),
    /** The ids of this city's patches, loaded or not. */
    patchIds: Object.keys(patchMeta),
    /** A patch's entry in terrain.json (file, image, water, extents), or null. */
    patchInfo: (id) => patchMeta[id] ?? null,
    /** Fetch the wide grid once. Resolves null for a city without one. A failed fetch can be retried. */
    loadWide() {
      if (!meta.grids.wide) return Promise.resolve(null);
      if (!wideLoad) {
        wideLoad = track(fetchBinary(meta.grids.wide.file).then((buf) => { wide = heightField(buf, meta.grids.wide); relayer(); return wide; }));
        wideLoad.catch(() => { wideLoad = null; });
      }
      return wideLoad;
    },
    /**
     * Fetch every patch once (drive-only data). Resolves to [{ id, grid, info }] (empty for a city without
     * patches); heightAt answers from them as soon as this resolves. A failed fetch can be retried.
     */
    loadPatches() {
      const ids = Object.keys(patchMeta);
      if (!patchLoad) {
        patchLoad = track(Promise.all(ids.map(async (id) => {
          const grid = patches.get(id) ?? heightField(await fetchBinary(patchMeta[id].file), patchMeta[id]);
          return { id, grid, info: patchMeta[id] };
        })).then((list) => {
          for (const p of list) patches.set(p.id, p.grid);
          relayer();
          return list;
        }));
        patchLoad.catch(() => { patchLoad = null; });
      }
      return patchLoad;
    },
    /** Resolves once no grid is loading. */
    async whenSettled() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    // the tile pyramid's hooks, accepted and ignored until it exists
    setViews() {},
    prefetchAlong() { return { cancel() {}, done: Promise.resolve() }; },
    update() {},
    stats() {
      const loaded = [['near', near], ['far', far], ['wide', wide], ...patches].filter(([, g]) => g);
      return { grids: loaded.map(([n]) => n), bytes: loaded.reduce((s, [, g]) => s + g.raw.byteLength, 0) };
    },
  };
}

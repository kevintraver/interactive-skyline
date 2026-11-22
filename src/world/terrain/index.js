// The terrain provider: heights for everything that stands on the ground. Pure, no three.js.
//
// Today it serves three fixed grids from public/data/<city>/: near and far, which main.js has
// already downloaded, and the coarse wide grid that reaches the drive routes, fetched on demand.
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
  const inFlight = new Set();

  /** Height above sea level: the finest loaded grid that contains the point; outside them all, the coarsest one's edge. */
  const heightAt = (x, y) => {
    if (near.contains(x, y)) return near.sample(x, y);
    if (far.contains(x, y) || !wide) return far.sample(x, y);
    return wide.sample(x, y);
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
    /** @param {'near'|'far'|'wide'} name */
    grid: (name) => ({ near, far, wide })[name] ?? null,
    hasWide: Boolean(meta.grids.wide),
    /** Fetch the wide grid once. Resolves null for a city without one. A failed fetch can be retried. */
    loadWide() {
      if (!meta.grids.wide) return Promise.resolve(null);
      if (!wideLoad) {
        wideLoad = track(fetchBinary(meta.grids.wide.file).then((buf) => (wide = heightField(buf, meta.grids.wide))));
        wideLoad.catch(() => { wideLoad = null; });
      }
      return wideLoad;
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
      const loaded = [['near', near], ['far', far], ['wide', wide]].filter(([, g]) => g);
      return { grids: loaded.map(([n]) => n), bytes: loaded.reduce((s, [, g]) => s + g.raw.byteLength, 0) };
    },
  };
}

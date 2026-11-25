/**
 * Worker around meshChunk. Create it with
 *   new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' })
 *
 * Messages in:
 *   { type: 'init', roads, base, earthR }   roads as decodeRoadNet gives them (structured-cloned)
 *   { type: 'mesh', id, road, s0, s1, lod, split?, origin? }   road is an index into `roads`
 *   { type: 'mesh', id, parts: [{ road, s0, s1, group }], groups, lod, origin? }   several stretches
 *                                           in one set of buffers, one index range per group
 * Messages out:
 *   { id, mesh }   the meshChunk result, its buffers transferred
 *   { id, error }  when meshing failed
 */
import { meshChunk, meshParts, transferablesOf } from './mesher.js';

/** The message handler, separate from `self` so a synchronous stand-in can reuse it. */
export function createMesherHandler(post) {
  let roads = [], base = 0, earthR = 1;
  return (msg) => {
    if (msg.type === 'init') { ({ roads, base, earthR } = msg); return; }
    if (msg.type !== 'mesh') return;
    try {
      const mesh = msg.parts
        ? meshParts({ parts: msg.parts, groups: msg.groups, lod: msg.lod, origin: msg.origin, base, earthR, roads })
        : meshChunk({ road: roads[msg.road], s0: msg.s0, s1: msg.s1, lod: msg.lod, split: msg.split, origin: msg.origin, base, earthR, roads });
      post({ id: msg.id, mesh }, transferablesOf(mesh));
    } catch (err) {
      post({ id: msg.id, error: String(err?.stack || err) }, []);
    }
  };
}

// In a real worker, wire the handler to the message port.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  const handle = createMesherHandler((data, transfer) => self.postMessage(data, transfer));
  self.onmessage = (e) => handle(e.data);
}

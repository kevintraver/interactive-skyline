/**
 * Worker around meshCell. Create it with
 *   new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' })
 *
 * Messages in:
 *   { type: 'mesh', id, buf, groundMin, groundMean, base, earthR, origin?, only? }   see meshCell
 * Messages out:
 *   { id, mesh, ms }   the meshCell result, its buffers transferred; ms the time it took
 *   { id, error }      when meshing failed
 */
import { meshCell, transferablesOf } from './mesher.js';

/** The message handler, separate from `self` so a synchronous stand-in can reuse it. */
export function createCorridorHandler(post) {
  return (msg) => {
    if (msg.type !== 'mesh') return;
    try {
      const t0 = performance.now();
      const mesh = meshCell(msg);
      post({ id: msg.id, mesh, ms: performance.now() - t0 }, transferablesOf(mesh));
    } catch (err) {
      post({ id: msg.id, error: String(err?.stack || err) }, []);
    }
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  const handle = createCorridorHandler((data, transfer) => self.postMessage(data, transfer));
  self.onmessage = (e) => handle(e.data);
}

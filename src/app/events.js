// A tiny emitter: the seam other subsystems subscribe to (plan 01, section 5.4, AppEvents).
//   'buildings:changed'  { hidden: Set<id>, moved: Map<id, {dx, dz}> }  after hide, show or move (interaction/edits.js)
//   'buildings:rebuilt'  { tall }                                        after the height cutoff rebuilt the towers
export function createEmitter() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    /** Call every listener of `type`. `payload` may be a function, called only when someone is listening. */
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set || !set.size) return;
      const e = typeof payload === 'function' ? payload() : payload;
      for (const fn of [...set]) fn(e);
    },
  };
}

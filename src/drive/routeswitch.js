// Which route the drive session is on, and the switch from one route to another (plan 02, D9.4). A route's
// "kit" is what the session builds for it: its RoadNet's road chunks, its signs and its barriers. The switch
// loads the next route's data (load: plain data, nothing on the GPU), builds its kit (build), disposes of the
// old kit, then tells the listeners (the session, which tells the parts through setRoute). One switch is
// current at a time: a later use() supersedes an earlier one still loading, whose data is dropped unbuilt, so
// switching back and forth quickly builds only the route that is asked for last.
//
// No three.js and no DOM here, so the switch is unit-tested with fakes (tests/unit/drive/routeswitch.test.js).

/**
 * @template Data, Kit
 * @param {{ load: (id: string) => Promise<Data>, build: (data: Data) => Kit & { id: string, dispose(): void } }} opts
 */
export function createRouteSwitch({ load, build }) {
  let kit = null, token = 0, pendingId = null, pending = null, disposed = false;
  const listeners = [];
  // one promise per swap, shared by every waiter (whenSettled runs every frame; nothing piles up)
  let swapped, resolveSwap;
  const nextSwap = () => { swapped = new Promise((r) => { resolveSwap = r; }); };
  nextSwap();

  const api = {
    /** The current kit, or null before the first route is in. */
    get kit() { return kit; },
    /** The current route's id, or null. */
    get id() { return kit ? kit.id : null; },
    /** The route being loaded, or null. */
    get switching() { return pendingId; },
    /** The load in progress (resolves when it is current or superseded), or null. */
    get pending() { return pending; },
    /**
     * Make route `id` current. Resolves to its kit once it is current, or to null when a later use() superseded
     * this one; rejects when its data fails to load (the current kit stays).
     */
    use(id) {
      if (disposed) return Promise.reject(new Error('the route switch is disposed'));
      if (pendingId === id) return pending;
      if (kit && kit.id === id) {
        // back to the current route before another one loaded: that load is dropped
        token++;
        pendingId = null; pending = null;
        return Promise.resolve(kit);
      }
      const my = ++token;
      pendingId = id;
      pending = (async () => {
        let data;
        try {
          data = await load(id);
        } catch (err) {
          if (my === token) { pendingId = null; pending = null; }
          throw err;
        }
        if (my !== token || disposed) return null;
        const next = build(data);
        const old = kit;
        kit = next;
        pendingId = null; pending = null;
        old?.dispose();
        for (const fn of listeners) fn(next, old);
        const resolve = resolveSwap;
        nextSwap();
        resolve();
        return next;
      })();
      return pending;
    },
    /** fn(kit, old) after each switch, with the new kit current and the old one disposed. */
    onSwap(fn) { listeners.push(fn); },
    /**
     * Resolves once settled(kit) resolves for the kit that is current then. A switch in the meantime starts the
     * wait again on the new kit (a disposed kit's own promises may never resolve); a switch that is loading is
     * waited for first.
     * @param {(kit: Kit) => Promise<unknown>|unknown} settled
     */
    async whenSettled(settled) {
      for (;;) {
        if (pending) await pending.catch(() => null);
        const k = kit;
        if (!k || disposed) return;
        const swap = swapped;
        const done = await Promise.race([Promise.resolve(settled(k)).then(() => true), swap.then(() => false)]);
        if (done && kit === k && !pending) return;
      }
    },
    /** Dispose of the current kit; the switch is unusable after this. */
    dispose() {
      disposed = true;
      token++;
      pendingId = null; pending = null;
      kit?.dispose();
      kit = null;
      resolveSwap();
    },
  };
  return api;
}

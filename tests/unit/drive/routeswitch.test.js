// The session's route switching (src/drive/routeswitch.js), with fake loads and kits: which kit is current,
// what is disposed and when, superseded switches, failures, and whenSettled across a switch. The session builds
// its kits (road chunks, signs) on this; the browser half is tests/e2e/routes.spec.js.
import { describe, it, expect } from 'vitest';
import { createRouteSwitch } from '../../../src/drive/routeswitch.js';

/** A switch over fake routes: load resolves when release(id) is called; kits record their disposal. */
function fake({ fail = [] } = {}) {
  const gates = new Map(), built = [], disposed = [], events = [];
  const gate = (id) => {
    if (!gates.has(id)) { let open; const p = new Promise((r) => { open = r; }); gates.set(id, { p, open }); }
    return gates.get(id);
  };
  const sw = createRouteSwitch({
    load: async (id) => {
      await gate(id).p;
      gates.delete(id);
      if (fail.includes(id)) throw new Error(`no ${id}`);
      return { id, roadnet: `net-${id}` };
    },
    build: (d) => {
      const kit = { id: d.id, roadnet: d.roadnet, settle: null, dispose() { disposed.push(d.id); events.push(`dispose ${d.id}`); } };
      built.push(d.id);
      events.push(`build ${d.id}`);
      return kit;
    },
  });
  sw.onSwap((k, old) => events.push(`swap ${old ? old.id : '-'}>${k.id}`));
  const release = async (id) => { gate(id).open(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { sw, built, disposed, events, release };
}

describe('route switch', () => {
  it('loads, builds and makes a route current, then disposes of the old one before telling the listeners', async () => {
    const { sw, built, disposed, events, release } = fake();
    const a = sw.use('i15n');
    expect(sw.switching).toBe('i15n');
    expect(sw.kit).toBe(null);
    await release('i15n');
    expect((await a).id).toBe('i15n');
    expect(sw.id).toBe('i15n');
    expect(sw.switching).toBe(null);

    const b = sw.use('us93');
    expect(sw.id).toBe('i15n'); // the old route stays current while the next loads
    await release('us93');
    await b;
    expect(sw.id).toBe('us93');
    expect(built).toEqual(['i15n', 'us93']);
    expect(disposed).toEqual(['i15n']);
    expect(events).toEqual(['build i15n', 'swap ->i15n', 'build us93', 'dispose i15n', 'swap i15n>us93']);
  });

  it('switching back and forth disposes of every kit but the current one', async () => {
    const { sw, built, disposed, release } = fake();
    for (const id of ['i15n', 'us93', 'i15s', 'i15n', 'us93', 'i15n']) {
      const p = sw.use(id);
      await release(id);
      await p;
    }
    expect(built).toEqual(['i15n', 'us93', 'i15s', 'i15n', 'us93', 'i15n']);
    expect(disposed).toEqual(['i15n', 'us93', 'i15s', 'i15n', 'us93']);
    expect(built.length - disposed.length).toBe(1);
    expect(sw.id).toBe('i15n');
  });

  it('a later switch supersedes one still loading, whose data is dropped unbuilt', async () => {
    const { sw, built, release } = fake();
    const first = sw.use('i15n'); await release('i15n'); await first;
    const a = sw.use('us93');
    const b = sw.use('i15s');
    expect(sw.switching).toBe('i15s');
    await release('us93');
    expect(await a).toBe(null);
    expect(sw.id).toBe('i15n');
    await release('i15s');
    expect((await b).id).toBe('i15s');
    expect(built).toEqual(['i15n', 'i15s']);
  });

  it('asking for the current route again drops a switch still loading', async () => {
    const { sw, built, release } = fake();
    const first = sw.use('i15n'); await release('i15n'); await first;
    const away = sw.use('us93');
    const back = sw.use('i15n');
    expect(sw.switching).toBe(null);
    expect((await back).id).toBe('i15n');
    await release('us93');
    expect(await away).toBe(null);
    expect(built).toEqual(['i15n']);
  });

  it('the same route asked twice while loading is one load', async () => {
    const { sw, built, release } = fake();
    const a = sw.use('us93'), b = sw.use('us93');
    expect(a).toBe(b);
    await release('us93');
    await a;
    expect(built).toEqual(['us93']);
  });

  it('a route that fails to load leaves the current route current', async () => {
    const { sw, disposed, release } = fake({ fail: ['i15s'] });
    const first = sw.use('i15n'); await release('i15n'); await first;
    const p = sw.use('i15s');
    await release('i15s');
    await expect(p).rejects.toThrow('no i15s');
    expect(sw.id).toBe('i15n');
    expect(sw.switching).toBe(null);
    expect(disposed).toEqual([]);
  });

  it('whenSettled follows a switch: it waits for the new kit, never for a disposed one', async () => {
    const { sw, release } = fake();
    const first = sw.use('i15n'); await release('i15n'); const a = await first;
    a.settle = new Promise(() => {}); // a disposed kit's own promise never resolves
    let done = false;
    const waiting = sw.whenSettled((k) => k.settle).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    let settle;
    sw.onSwap((k) => { if (k.id === 'us93') k.settle = new Promise((r) => { settle = r; }); });
    const p = sw.use('us93');
    await release('us93');
    await p;
    await Promise.resolve(); await Promise.resolve();
    expect(done).toBe(false);
    settle();
    await waiting;
    expect(done).toBe(true);
  });

  it('whenSettled waits for a switch that is loading', async () => {
    const { sw, release } = fake();
    const first = sw.use('i15n'); await release('i15n'); await first;
    sw.use('us93');
    const seen = [];
    const waiting = sw.whenSettled((k) => { seen.push(k.id); });
    await Promise.resolve();
    expect(seen).toEqual([]);
    await release('us93');
    await waiting;
    expect(seen).toEqual(['us93']);
  });

  it('dispose lets the current kit go and refuses further switches', async () => {
    const { sw, disposed, release } = fake();
    const first = sw.use('i15n'); await release('i15n'); await first;
    sw.dispose();
    expect(disposed).toEqual(['i15n']);
    expect(sw.kit).toBe(null);
    await expect(sw.use('us93')).rejects.toThrow(/disposed/);
    await sw.whenSettled(() => new Promise(() => {})); // resolves at once: nothing to wait for
  });
});

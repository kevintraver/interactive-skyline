// The simulation clock, the ephemeris and the environment, wired into the app (plan 01, sections 5.5 and 5.6).
//   frame step 0   clock.advance(dtWall)            (the clock votes for its tier: idle when paused)
//   frame step 40  env.update(): the state at the clock's time, then the legacy sky follows it
// The app opens pinned (decision 4 after review): the clock is paused and nothing here changes a pixel until the
// clock state is entered, from #sky, the time keys, a ?t= link or env.freeze().
import { createSimClock, parseTimeParam, formatTimeParam } from '../sim/clock.js';
import { createEphemeris } from '../sky/ephemeris.js';
import { createEnvironment } from '../env/environment.js';
import { createTimeline } from '../sim/timeline.js';
import { clockDemand } from '../render/frameLoop.js';
import { testJourney } from '../sim/testJourney.js';

export function initSim(app) {
  const { city, settings, loop, invalidate } = app;
  const params = new URLSearchParams(location.search);
  const clock = createSimClock({ zone: city.tz });
  const ephemeris = createEphemeris({ lat: city.origin.lat, lon: city.origin.lon, elevationM: city.base });
  const seed = params.has('seed') && Number.isFinite(Number(params.get('seed'))) ? Number(params.get('seed')) : null;
  const env = createEnvironment({ city, clock, ephemeris, settings, seed });
  env.update();

  for (const type of ['seek', 'state', 'rate']) clock.on(type, () => invalidate());
  const timeline = createTimeline({ clock });
  loop.add({ update: (f) => clock.advance(f.dtWallMs), demand: () => (env.mode === 'clock' ? clockDemand(clock) : 'idle') }, 0);
  loop.add(timeline, 10);
  loop.add({
    update: () => {
      if (env.mode !== 'clock') return;
      env.update();
      app.sky.update(env.state);
    },
  }, 40);

  env.on('mode', () => {
    app.sky.setMode(env.mode, env.state);
    app.applySettings('night');
    syncAddress();
    invalidate();
  });
  env.on('night', () => app.applySettings('night'));
  // the blue of removable towers follows the blended look (T1.4)
  app.sky.onTint = () => { if (app.tall) app.tall.forEach(app.paint); };

  // the view tiles follow the sky once it settles (not on every frame of a scrub)
  let tiles = null;
  const refreshTiles = () => {
    clearTimeout(tiles);
    tiles = setTimeout(() => {
      syncAddress();
      if (app.views) { app.views.stale = true; invalidate(); }
    }, 400);
  };
  clock.on('seek', refreshTiles);
  clock.on('state', () => { refreshTiles(); syncAddress(); });

  /** ?t= round-trips to the address bar: the instant while paused, `now` while live, nothing when pinned. */
  function syncAddress() {
    const url = new URL(location.href);
    const before = url.search;
    if (env.mode !== 'clock') url.searchParams.delete('t');
    else if (clock.live) url.searchParams.set('t', 'now');
    else if (!clock.playing) url.searchParams.set('t', formatTimeParam(clock.timeMs, clock.zone));
    else return;
    if (url.search !== before) history.replaceState(history.state, '', url);
  }

  /** Enter the clock state (any time control does). */
  app.enterClock = () => env.enterClock();
  Object.assign(app, { clock, ephemeris, env, timeline, syncAddress });
}

/** Apply ?t= (and ?rate=) once the interface is up: any t enters the clock state (section 4.1). */
export function applyTimeParams(app) {
  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'drive') return; // drive seam: a drive link's ?t= is the drive's own moment (src/drive/url.js)
  const t = parseTimeParam(params.get('t'), app.clock.zone);
  const { clock, env } = app;
  if (params.get('journey') === 'test') {
    clock.set(Date.now());
    app.transport.attachJourney(testJourney(app));
  }
  if (!t) return;
  if (t.live) clock.goLive(); else clock.set(t.timeMs);
  const rate = params.has('rate') ? Number(params.get('rate')) : null;
  if (rate !== null && Number.isFinite(rate)) {
    if (rate === 0) clock.pause();
    else { clock.setRate(rate); clock.play(); }
  }
  env.enterClock();
}

// Fly mode's entry point (plan 03, section 5.1 principle 4): the only flight file in the main bundle, joined to the app
// by one call in main.js (initFlight) and the `app.fly` seam. It offers Fly in #modes for a city whose cities.json
// entry has an `airport` and whose flights/index.json lists at least one flight, reads ?mode=flight, installs
// window.__skyline.flight, and import()s everything else (mode.js, session.js and what they use) on first entry.
//
// The seam (lines marked "flight seam" in main.js, interaction/picking.js, interaction/focus.js and
// interaction/edits.js): while app.fly.active the frame loop leaves the camera to the flight (which places it at
// loop order 20) and takes no viewpoint snapshots, removable buildings are painted in their natural colours with no
// edge lines, focusOn calls fly.focus (Look at), and picking asks fly.blocked whether the cabin or the airframe stops
// a click.
//
// Map, Drive and Fly are one switch. Fly is drawn by plan 01's renderer only: under ?renderer=legacy it is not offered;
// on the classic renderer the drive brought up (?mode=drive), Fly reloads the page into the new one, as Drive does the
// other way.
import { createTerrain } from '../world/terrain/index.js';
import { createFlightEnv } from './env.js';

/** Parameters of the address that belong to the flight (src/flight/url.js FLIGHT_KEYS) or to the drive. */
const MODE_KEYS = ['mode', 'flight', 'at', 'seat', 'yaw', 'pitch', 'lens', 'frame', 't', 'route', 's', 'view', 'rain',
  'orbit', 'alt', 'r', 'phase', 'c', 'on', 'out', 'ias'];

/**
 * @param {object} app the shared application context, with the city, terrain and buildings loaded, and app.fly
 * @param {{ terrainData: { meta: object, near: ArrayBuffer, far: ArrayBuffer } }} loaded terrain.json and the grids main.js downloaded
 */
export function initFlight(app, { terrainData }) {
  const { city, cityId } = app;
  const seam = app.fly;
  const DATA = `/data/${cityId}`;
  const hooks = window.__skyline || (window.__skyline = {});
  const params = new URLSearchParams(location.search);
  const btn = document.querySelector('#modes button[data-mode="flight"]');
  const modes = document.getElementById('modes');
  let flights = [], mode = null, loading = null;

  const not = (why) => {
    const no = () => Promise.reject(new Error(why));
    hooks.flight = { ready: Promise.resolve(false), list: () => [], active: () => false, start: no, orbit: no, whenSettled: no, seek: no, exit() {},
      state: () => null, stats: () => null, visible: () => false, why };
    return hooks.flight;
  };
  if (!city.airport) return not(`${city.name} has no airport in cities.json`);
  if (params.get('renderer') === 'legacy') return not('Fly is drawn by the new renderer, not ?renderer=legacy');
  const legacy = app.rendererKind === 'legacy';

  const showMode = (m) => modes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  const terrain = legacy ? null : createTerrain({
    meta: terrainData.meta, buffers: { near: terrainData.near, far: terrainData.far }, base: city.base,
    fetchBinary: async (file) => {
      const r = await fetch(`${DATA}/${file}`);
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return r.arrayBuffer();
    },
  });

  /** The controller, loaded and built once. */
  function load() {
    if (mode) return Promise.resolve(mode);
    if (!loading) {
      btn.setAttribute('aria-busy', 'true');
      loading = import('./mode.js')
        .then(({ createFlightMode }) => (mode = createFlightMode({ app, fe: createFlightEnv(app), terrain, meta: terrainData.meta, flights, data: DATA, seam, showMode })))
        .catch((err) => { loading = null; throw err; })
        .finally(() => btn.removeAttribute('aria-busy'));
    }
    return loading;
  }
  /** On the classic renderer: the same address with mode=flight, on the new renderer. */
  function reloadIntoFlight(id, { orbit = false } = {}) {
    const q = new URLSearchParams(location.search);
    for (const k of MODE_KEYS) q.delete(k);
    q.set('mode', 'flight');
    if (orbit) q.set('orbit', '1');
    else if (id) q.set('flight', id);
    location.assign(`${location.pathname}?${q}`);
    return new Promise(() => {});
  }
  /** The entry in progress (from the button, the address or a hook), so whenSettled() can wait for its fade too. */
  let entering = Promise.resolve();
  const enter = (id, o) => {
    if (legacy) return reloadIntoFlight(id);
    const p = load().then((m) => m.enter(id, o));
    entering = p.catch(() => {});
    return p;
  };
  /** A removable building by id, and the orbit's centre and label for it (where it stands now, moved or not). */
  const building = (id) => app.tall.find((e) => e.data.id === id) ?? null;
  const centreOf = (entry) => ({ x: entry.data.c[0] + (entry.offset?.x ?? 0), n: entry.data.c[1] - (entry.offset?.z ?? 0) });
  /** Enter an orbit: decodeOrbitState's fields, `on` resolved to the building's centre and name when it exists. */
  const enterOrbit = (o = {}) => {
    if (legacy) return reloadIntoFlight(null, { orbit: true });
    const b = o.on ? building(o.on) : null;
    const resolved = b ? { ...o, center: centreOf(b), centerLabel: app.format.label(b.data) } : { ...o, on: undefined };
    const p = load().then((m) => m.enterOrbit(resolved));
    entering = p.catch(() => {});
    return p;
  };

  const ready = fetch(`${DATA}/flights/index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((index) => {
      flights = (index?.flights || []).filter((f) => f && typeof f.id === 'string');
      if (!flights.length || !btn) return false;
      btn.hidden = false;
      modes.hidden = false;
      // leaving Fly comes first when another mode is chosen (caught on the way down, before that mode's own handler)
      modes.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (b && b.dataset.mode !== 'flight' && seam.active) mode.exit();
      }, true);
      btn.addEventListener('click', () => {
        btn.blur(); // Space plays and pauses while flying; it must not press this button again
        if (seam.active) { mode.cards.setOpen(!mode.cards.state.open); return; }
        const remembered = mode?.memory;
        if (remembered?.kind === 'orbit' && remembered.orbit) { enterOrbit({ ...remembered.orbit, play: !!remembered.playing }).catch(() => {}); return; }
        enter(remembered?.id, { picker: !remembered?.at[remembered.id], play: !!remembered?.playing }).catch(() => {});
      });
      // ?mode=flight opens straight into the flight, paused on its moment
      if (params.get('mode') === 'flight' && !legacy) {
        Promise.all([import('./url.js'), import('./orbitUrl.js')]).then(([{ decodeFlightState }, { decodeOrbitState }]) => {
          // ?orbit=1 opens the orbit of the link, on its circle at its phase, paused (4.10)
          const o = decodeOrbitState(location.search);
          if (o.orbit) return enterOrbit(o);
          const s = decodeFlightState(location.search);
          const id = flights.some((f) => f.id === s.id) ? s.id : undefined;
          return enter(id, { ...s, picker: !id });
        }).catch((err) => console.warn('Fly could not open the address.', err));
      }
      return true;
    });

  const need = () => { if (!mode || !seam.active || !mode.session) throw new Error('Fly is not active'); return mode; };
  hooks.flight = {
    /** Resolves true once Fly is offered (flights/index.json read), false when it is not. */
    ready,
    list: () => flights.map((f) => ({ ...f })),
    active: () => !!seam.active,
    /**
     * Enter Fly on a flight; resolves when the first frame has settled. Plays unless `play: false`.
     * @param {string} id  @param {{ at?: number, seat?: string, pace?: boolean, rate?: number, frame?: boolean, hud?: boolean, play?: boolean, yaw?: number, pitch?: number, lens?: number }} [o]
     */
    async start(id, o = {}) {
      await ready;
      if (legacy) throw new Error('Fly is drawn by the new renderer');
      const m = await load();
      await enter(id, { ...o, play: o.play !== false });
      if (typeof o.hud === 'boolean') m.setHud(o.hud);
    },
    exit: () => (mode ? mode.exit() : undefined),
    play() { need(); app.clock.play(); app.invalidate(); },
    pause() { need(); app.clock.pause(); need().writeAddress(); app.invalidate(); },
    /** { at } seconds from the start, or { chapter } an event id ('touchdown', 'gear', ...). Resolves when settled. */
    async seek({ at, chapter } = {}) {
      const m = need(), s = m.session;
      const t = chapter !== undefined ? s.track.events.find((e) => e.id === chapter)?.t : at;
      if (!Number.isFinite(t)) throw new Error(`no ${chapter !== undefined ? `chapter "${chapter}"` : 'time'} to seek to (${s.track.events.map((e) => e.id).join(', ')})`);
      s.seek(t);
      m.writeAddress();
      await s.whenSettled();
    },
    /** Any of yaw, pitch, lens, lean, slide, rise (clamped by the head rig). */
    look(l) { const m = need(); m.session.look(l); m.writeAddress(); },
    /** Turn the head to a removable building, as Look at does: { yaw, pitch, inView, where }. */
    lookAtBuilding(id) {
      const m = need(), entry = app.tall.find((e) => e.data.id === id);
      if (!entry) throw new Error(`no removable building "${id}"`);
      return seam.focus(entry);
    },
    /**
     * The aircraft and the view now. Units: metres and metres per second (x, y, z scene metres: x east, y up, z south;
     * altMsl, heightAboveGround of the main wheels over the ground as drawn; gs, tas, ias, vs); angles in DEGREES:
     * headingDeg clockwise from grid north (0 to 360), pitchDeg nose up positive, rollDeg right wing down positive
     * (the attitude of the track, before the ground attitude: groundPitchDeg); t, durationS, touchdownT seconds from
     * the start of the flight; simMs UTC milliseconds. look: the head rig's (yaw, pitch degrees; lens mm).
     */
    state() {
      if (!mode?.session?.track || !seam.active) return null; // entering: the track is not in yet
      const s = mode.session, st = s.sampleAt(s.progressS), l = s.rig.state;
      const deg = (r) => (r * 180) / Math.PI;
      const orbit = s.kind === 'orbit' ? {
        id: 'orbit', kind: 'orbit', phaseDeg: s.track.phaseAt(s.progressS), orbit: { ...s.track.orbit, center: { ...s.track.orbit.center }, wind: { ...s.track.orbit.wind } },
        bankDeg: deg(st.roll), joinT: s.track.joinT, lapS: s.track.lapS, steadyBankDeg: s.track.bankDeg, lastChange: mode.lastOrbitChange,
        fromCentreM: Math.hypot(st.position.x - s.track.orbit.center.x, -st.position.z - s.track.orbit.center.n), on: mode.memory.orbitOn,
      } : { kind: 'flight' };
      return {
        id: mode.memory.id, runway: s.track.meta.runway, t: st.t, s: st.s, x: st.position.x, y: st.position.y, z: st.position.z,
        headingDeg: ((deg(st.heading) % 360) + 360) % 360, pitchDeg: deg(st.pitch), rollDeg: deg(st.roll),
        altMsl: st.altMsl, gs: st.gs, tas: st.tas, ias: st.ias, vs: st.vs,
        flap: st.flap, slat: st.slat, gear: st.gear, speedbrake: st.speedbrake, groundSpoiler: st.groundSpoiler, reverser: st.reverser,
        lights: st.lights, onGround: st.onGround, heightAboveGround: st.position.y - s.groundY(st.position.x, -st.position.z),
        playing: app.clock.playing, rate: app.clock.rate, pace: s.pace, seat: s.seat.id, look: l, frame: mode.frame, hud: mode.hud,
        durationS: s.track.durationS, touchdownT: s.track.touchdownT, simMs: app.clock.timeMs,
        groundPitchDeg: (s.groundPitch * 180) / Math.PI, airframeModel: !!s.airframe.model,
        ...orbit,
      };
    },
    /** A scene point on the screen: { x, y, onScreen, throughWindow }. */
    project: (x, y, z) => need().session.project(x, y, z),
    /** Resolves once an entry in progress has faded in, the ground and the aircraft are in, and a frame is drawn. */
    async whenSettled() { await ready; await entering; return need().session.whenSettled(); },
    /** Line of sight from the eye through the window to a removable building's top. */
    visible(id) { const entry = app.tall.find((e) => e.data.id === id); return !!entry && need().session.visible(entry); },
    /** { frame, hud }: the cabin frame (off is the clean view, key C) and the status chip (key H). */
    options(o = {}) {
      const m = need();
      if (typeof o.frame === 'boolean') m.setFrame(o.frame);
      if (typeof o.hud === 'boolean') m.setHud(o.hud);
      return { frame: m.frame, hud: m.hud };
    },
    stats: () => (mode?.session ? { ...mode.session.stats(), active: !!seam.active } : null),
    /** Scene Y of the ground as drawn while flying at map (x east, n north): pavement, the airport's ground, the
     * regional terrain. Before Fly is first entered, the map's provider. */
    groundY: (x, n) => (mode?.session ? mode.session.groundY(x, n) : terrain.surfaceY(x, n)),
    /** Change seat ('23F', '12A'...): the cabin and the eye move, the address follows. Returns the seat's id. */
    setSeat(id) { const m = need(); const st = m.setSeat(id); return st.id; },
    /**
     * The window's glass (F5.7, the window panel): any of glass, frost, rain, scratches, reflections (booleans) and
     * focus ('far' | 'pane', key F); `override`: the pane's condition for a check ({ frost, fog, wet, mist, rainRateMmH,
     * inCloud }, null to follow the journey again). Returns the state now, with the pane's own stats.
     */
    window(o = {}) {
      const m = need(), st = m.setWindow(o);
      // a debug override of the pane's condition (frost, fog, wet, mist, rainRateMmH, inCloud), null to follow the journey
      if ('override' in o) m.session.pane.setOverride(o.override);
      // any of the pane's own effects directly (transmission too, which the panel does not offer), for checks
      if (o.effects) m.session.pane.setEffects(o.effects);
      // for measurements: `stage: false` leaves the cabin stage idle (no cabin, no glass) without moving the eye
      if (typeof o.stage === 'boolean') m.session.setStageOff(!o.stage);
      // the material's debug views (window/paneMaterial.js: 1 ice, 2 the frost front, 3 the growth map, 4 drops,
      // 5 scratch density; 0 off)
      if (Number.isFinite(o.debug) && m.session.pane.uniforms) m.session.pane.uniforms.debug.value = o.debug;
      app.invalidate();
      return { ...st, pane: m.session.pane.stats() };
    },
    /** The own window's shade, 0 open to 1 closed (it slides there while the clock plays; at once when asked twice). */
    shade(v) { const m = need(); m.session.cabin.setShade(v); app.invalidate(); return m.session.cabin.shade; },
    /**
     * The light at a point of the screen (NDC, -1..1), before exposure, cd/m^2: { outside, cabin, cabinAlpha, composed }.
     * outside: the world behind (the scene pass, plan 01's probe); cabin: what the cabin layer adds there (premultiplied:
     * 0 where it draws nothing) and its coverage; composed: outside x (1 - coverage) + cabin.
     */
    async luminance({ x = 0, y = 0 } = {}) {
      const m = need(), k = app.env?.nodes?.exposure?.value ?? 1;
      const outside = await app.pipeline.probe(x, y);
      const cabin = await m.session.cabinStage.probe(x, y, k);
      return { outside: outside.luminanceCdM2, cabin: cabin.luminanceCdM2, cabinAlpha: cabin.alpha,
        composed: outside.luminanceCdM2 * (1 - cabin.alpha) + cabin.luminanceCdM2, exposure: k };
    },
    /**
     * Enter Fly in an orbit (4.6, 7.12) on its circle at its phase; resolves when the first frame has settled. Plays
     * unless `play: false`. center: { x, n } metres east and north of the city origin, or a removable building's id
     * ("Orbit this"); the Strip by default. seat chooses the direction (right-hand seats clockwise); outward reverses it.
     * @param {{ altitudeFt?: number, radiusKm?: number, center?: { x: number, n: number } | string, seat?: string,
     *   phaseDeg?: number, outward?: boolean, iasKt?: number, play?: boolean, yaw?: number, pitch?: number, lens?: number }} [o]
     */
    async orbit({ altitudeFt, radiusKm, center, seat, phaseDeg, outward, iasKt, play, yaw, pitch, lens } = {}) {
      await ready;
      if (legacy) throw new Error('Fly is drawn by the new renderer');
      const byId = typeof center === 'string';
      if (byId && !building(center)) throw new Error(`no removable building "${center}"`);
      await enterOrbit({ altFt: altitudeFt, radiusKm, phaseDeg, outward, iasKt, seat, yaw, pitch, lens,
        center: byId ? undefined : center, on: byId ? center : undefined, play: play !== false });
    },
    /**
     * Change the orbit as the panel does: any of altFt, radiusKm, center ({ x, n } or a building id), outward, seat,
     * iasKt, direction; `cut: true` cuts as a preset does. Resolves after the change (a cut's fade included) with
     * { params, cut, unchanged }.
     */
    async orbitChange(change = {}, { cut = false } = {}) {
      const m = need();
      if (typeof change.center === 'string') {
        const b = building(change.center);
        if (!b) throw new Error(`no removable building "${change.center}"`);
        return pick(await m.orbitThis(b));
      }
      return pick(await m.changeOrbit(change, { cut }));
    },
  };
  /** What a hook hands back of a planned orbit change. */
  function pick(plan) { return { params: plan.params, cut: plan.cut, unchanged: !!plan.unchanged, flownS: plan.flownS ?? null, estimateS: plan.estimateS }; }
  return hooks.flight;
}

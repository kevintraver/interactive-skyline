// Fly mode's controller (plan 03, F1.4 and F1.6), loaded with the session the first time Fly is entered: entering
// and leaving (a 500 ms fade through black; the map's camera, controls, clock and look saved and given back exactly),
// the picker and the flight's bar, the keys, the address, and what-if from the air (Look at, and the clock held for
// the length of a building drag). The scene work is session.js's.
//
// Orbit (4.6, 7.12; F7.2): the Orbit entry beside the flight cards enters it, the orbit panel (ui/orbitPanel.js) sits
// under the top bar on the right while orbiting, and "Orbit this" on a selected building's card re-centres it. A
// change is flown when it is short and cut when it is long (orbit.js planChange; presets always cut): a cut fades
// through black as entering does, and the aircraft is on the new circle when the picture comes back. No journey, no
// condensed pace and no seeking: Space plays and pauses the clock, and plan 01's time controls change the hour under it.
import { createFlightSession } from './session.js';
import { createFlightCards, defaultFlight, ORBIT_ID } from './ui/cards.js';
import { createFlightBar } from './ui/bar.js';
import { createSeatMap } from './ui/seatMap.js';
import { createWindowPanel, paneSettings, WINDOW_DEFAULTS } from './ui/windowPanel.js';
import { encodeFlightState, clearFlightState } from './url.js';
import { playOptions, playStart } from './pace.js';
import { whereText } from './lookAt.js';
import { createState } from './track.js';
import { flightJourney } from './journey.js';
import { PRESETS } from './orbit.js';
import { encodeOrbitState, orbitLinkState, orbitInput } from './orbitUrl.js';
import { createOrbitPanel } from './ui/orbitPanel.js';
import { createAboutPanel } from './ui/about.js';

/** Each airport's published approaches (F2.6, scripts/fetch_cifp.py), for "About this flight": a few kilobytes. */
const CIFP = import.meta.glob('../../data/flights/*/cifp-*.json', { eager: true, import: 'default' });

/** The first-visit hint while flying (main.js keeps its own text for the map; the map's bold line about blue buildings
 * is hidden in style.css, since the settings panel rewrites it whenever the settings apply). */
export const FLY_HINT = 'Drag to look around. Scroll to zoom. Space to pause. Click a building through the window to hide or move it.';
/** At most one address write a second while the clock plays. */
const WRITE_EVERY_MS = 1000;
/** Each half of the fade through black (section 4.1: 500 ms in all). */
export const FADE_MS = 250;
/** The rates `[` and `]` step through (section 4.4: 1x to 8x). */
const RATES = [1, 2, 4, 8];
/** A departure this far from the recorded one counts as retimed (an address's t is rounded to the second). */
const RETIMED_MS = 30000;

/** The Strip's centre, the default orbit's (4.6): the mean of the 49 towers in data/flights/lv/strip.json, 316 m east
 * and 415 m north of the city origin. That file is not served, so its centre is kept here. */
export const STRIP_CENTERS = Object.freeze({ lv: Object.freeze({ x: 316, n: 415 }) });
/** The preset the Orbit entry's primary button flies, and the orbit the Fly button's first visit starts on. */
const ORBIT_DEFAULT = 'valley';

const typing = (t) => !!t && typeof t.matches === 'function' && t.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/**
 * @param {{ app: object, fe: object, terrain: object, meta: object, flights: object[], data: string, seam: object, showMode: (m: string) => void }} o
 *   meta: terrain.json
 */
export function createFlightMode({ app, fe, terrain, meta, flights, data, seam, showMode }) {
  const { camera, controls, settings, city, canvas, cityId } = app;
  const stripCenter = STRIP_CENTERS[cityId] ?? { x: 0, n: 0 };
  const { clock } = fe;
  const $ = (id) => document.getElementById(id);
  const el = { views: document.querySelector('.views'), night: $('night'), hint: $('hint').querySelector('span'), compass: $('compass'), tools: $('tools'),
    center: document.querySelector('#card [data-act="center"]'), orbitThis: document.querySelector('#card [data-act="orbit"]'),
    speed: document.querySelector('#transport .speed') };
  const fadeEl = Object.assign(document.createElement('div'), { id: 'fly-fade', hidden: true });
  fadeEl.setAttribute('aria-hidden', 'true');
  document.body.append(fadeEl);

  const cards = createFlightCards({ parent: $('top'), flights, tz: city.tz || 'UTC', data, onPlay: (id, key) => play(id, key).catch(() => {}),
    orbit: { presets: Object.entries(PRESETS).map(([key, p]) => ({ key, ...p })), primary: ORBIT_DEFAULT,
      onPlay: (key) => {
        const p = { altFt: PRESETS[key].altFt, radiusKm: PRESETS[key].radiusKm };
        // already orbiting: the preset as the panel's (a cut through black); else into the orbit, playing
        (seam.active && session?.kind === 'orbit' ? changeOrbit(p, { cut: true }) : enterOrbit({ ...p, play: true })).catch(() => {});
      } },
    onAbout: (id, button) => toggleAbout(id, button) });
  const bar = createFlightBar({ slot: $('transport-slot'), units: () => settings.units, onPace: () => setPace(!session?.pace), onFrame: () => setFrame(!frameOn), onSeat: () => toggleSeatMap(), onWindow: () => toggleWindowPanel(),
    onAbout: (button) => toggleAbout(memory.id, button) });
  let seatMap = null, windowPanel = null, orbitPanel = null, aboutPanel = null;
  /** The orbit's changes, one at a time (a cut's fade must finish before the next is planned). */
  let orbitQueue = Promise.resolve();
  /** How the last orbit change was made: 'flown', 'cut' or 'none' (another seat on the same side). */
  let lastOrbitChange = null;
  /** The window's glass switches and focus (F5.7), kept for the visit. */
  let windowState = { ...WINDOW_DEFAULTS };
  let session = null, loading = null, token = 0, saved = null, hud = true, frameOn = true, lastWrite = 0, dragPaused = false, compassDeg = null;
  /** What the mode remembers for the visit (section 4.1): flight, seat, look and time, and whether it was playing. */
  const memory = { id: defaultFlight(flights).id, seat: null, look: null, at: {}, playing: false, pace: true,
    /** 'flight' or 'orbit': what Fly was showing; orbit: the last orbit as a link has it (orbitLinkState); orbitOn and
     * orbitLabel: the building circled ("Orbit this"), for the link and the panel */
    kind: 'flight', orbit: null, orbitOn: null, orbitLabel: null };

  const fade = (on) => new Promise((resolve) => {
    if (on) fadeEl.hidden = false;
    requestAnimationFrame(() => {
      fadeEl.classList.toggle('on', on);
      setTimeout(() => { if (!on) fadeEl.hidden = true; resolve(); }, FADE_MS);
    });
  });

  function loadSession() {
    if (session) return Promise.resolve(session);
    if (!loading) {
      loading = createFlightSession({ app, fe, terrain, meta, data, onFrame, onLook: writeAddress })
        .then((s) => (session = s))
        .catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  // ---------------------------------------------------------------- entering and leaving
  /** Save what the map had and take the camera, the controls and the clock (before the session takes the camera). */
  function activate() {
    app.stopFlight(); // the map's camera glide (src/interaction/focus.js) ends where it is
    saved = {
      target: controls.target.clone(), enabled: controls.enabled, time: fe.saveMapTime(), width: innerWidth, height: innerHeight,
      hint: el.hint.textContent, center: el.center?.textContent, compass: el.compass.firstElementChild.style.rotate, compassTitle: el.compass.title,
      speed: el.speed?.value,
    };
    controls.enabled = false;
    fe.enterClock();
    seam.active = true;
    seam.focus = lookAtEntry;
    seam.blocked = (ray, distance) => session.blocked(ray, distance);
    el.views.hidden = true;
    el.night.hidden = true; // the pinned look's switch: the clock state's light is the flight's
    el.hint.textContent = FLY_HINT;
    if (el.center) el.center.textContent = 'Look at';
    setCompassTitle('Look out of the window');
    document.body.classList.add('flying');
    app.tall.forEach(app.paint);
  }

  /**
   * Enter Fly on a flight, or change flight while flying. Resolves once the first frame is settled.
   * @param {string} id
   * @param {{ at?: number, seat?: string, yaw?: number, pitch?: number, lens?: number, frame?: boolean, t?: number,
   *           pace?: boolean, rate?: number, play?: boolean, picker?: boolean }} [o]
   */
  async function enter(id = memory.id, o = {}) {
    const entry = flights.find((f) => f.id === id);
    if (!entry) throw new Error(`no flight "${id}" (${flights.map((f) => f.id).join(', ')})`);
    const my = ++token;
    const wasActive = seam.active;
    showMode('flight');
    cards.show(true);
    cards.setCurrent(id);
    cards.setLoading(true);
    if (o.picker) cards.setOpen(true);
    bar.show(true);
    bar.setNote(session ? 'Loading the flight…' : 'Loading Fly…');
    const fail = async (text, err) => {
      if (my === token) {
        cards.setLoading(false);
        bar.setNote(null);
        app.showToast(text, false);
        if (!wasActive) { if (seam.active) await leave(); else { cards.show(false); bar.show(false); showMode('map'); } }
      }
      console.warn(text, err);
      throw err;
    };
    try { await loadSession(); } catch (err) { return fail('Fly could not be loaded.', err); }
    if (my !== token) return;
    if (!wasActive) await fade(true);
    if (my !== token) { await fade(false); return; }
    if (!seam.active) activate();
    const startMs = Number.isFinite(o.t) && Number.isFinite(o.at) ? o.t - o.at * 1000 : undefined;
    let track;
    try {
      track = await session.begin(entry, { at: o.at ?? memory.at[id], startMs });
      cards.setFailed(id, false);
    } catch (err) {
      cards.setFailed(id, true);
      if (!wasActive) await fade(false);
      return fail('That flight could not be loaded.', err);
    }
    const sameFlight = memory.id === id;
    memory.id = id;
    memory.kind = 'flight';
    setKindUi('flight');
    cards.setOptions(id, playOptions(track, session.journey));
    // the transport's markers are ticks while flying (style.css); each keeps its name as a tooltip
    for (const m of document.querySelectorAll('#transport .marks span')) m.title = m.textContent;
    // the seat asked for, else the one kept for this flight, else the default on the side the Strip is on (4.3)
    session.setSeat(o.seat || (sameFlight && memory.seat) || { side: entry.badges?.stripSide === 'left' ? 'left' : 'right' });
    bar.setSeat(session.seat.id);
    if (seatMap) { seatMap.setStripSide(stripSideOf(id)); seatMap.setCurrent(session.seat.id); }
    if (memory.look && !wasActive) session.look(memory.look);
    session.look({ yaw: o.yaw, pitch: o.pitch, lens: o.lens });
    if (typeof o.frame === 'boolean') frameOn = o.frame;
    session.cleanView(!frameOn);
    applyWindow();
    setPace(o.pace ?? (Number.isFinite(o.rate) ? false : memory.pace), { write: false });
    clock.pause();
    if (Number.isFinite(o.rate) && o.rate > 0) clock.setRate(o.rate);
    session.show(true);
    writeAddress();
    await session.whenSettled();
    if (my !== token) return;
    if (!wasActive) await fade(false);
    cards.setLoading(false);
    bar.setNote(null);
    if (o.play) clock.play();
    writeAddress();
  }

  /** A way to play from a card: that flight, from that point, at that pace, playing. */
  function play(id, key) {
    return loadSession().then(async () => {
      const entry = flights.find((f) => f.id === id);
      const track = await session.trackOf(entry);
      const opt = playOptions(track, flightJourney(track, () => {})).find((x) => x.key === key);
      return enter(id, { at: opt.from, pace: opt.pace, rate: opt.pace ? undefined : 1, play: true });
    });
  }

  /**
   * Enter Fly in an orbit, or change to one while flying. Resolves once the first frame is settled.
   * @param {{ altFt?: number, radiusKm?: number, phaseDeg?: number, center?: { x: number, n: number }, on?: string,
   *   centerLabel?: string, outward?: boolean, iasKt?: number, seat?: string, yaw?: number, pitch?: number, lens?: number,
   *   frame?: boolean, play?: boolean, picker?: boolean }} [o] orbitUrl.js decodeOrbitState's fields; center is the
   *   building's when on names one (index.js resolves it), else the Strip
   */
  async function enterOrbit(o = {}) {
    const my = ++token;
    const wasActive = seam.active;
    showMode('flight');
    cards.show(true);
    cards.setCurrent(ORBIT_ID);
    cards.setLoading(true);
    if (o.picker) cards.setOpen(true);
    bar.show(true);
    bar.setNote(session ? 'Loading the orbit…' : 'Loading Fly…');
    try { await loadSession(); } catch (err) {
      if (my === token) {
        cards.setLoading(false);
        bar.setNote(null);
        app.showToast('Fly could not be loaded.', false);
        if (!wasActive) { cards.show(false); bar.show(false); showMode('map'); }
      }
      throw err;
    }
    if (my !== token) return;
    if (!wasActive) await fade(true);
    if (my !== token) { await fade(false); return; }
    if (!seam.active) activate();
    // the seat first: the direction follows its side (7.12)
    session.setSeat(o.seat || memory.seat || { side: 'right' });
    const input = orbitInput(o, { center: o.center ?? stripCenter });
    input.seat = session.seat.id;
    session.beginOrbit(input);
    memory.kind = 'orbit';
    memory.orbitOn = o.on ?? null;
    memory.orbitLabel = o.on ? o.centerLabel ?? null : null;
    setKindUi('orbit');
    bar.setSeat(session.seat.id);
    if (seatMap) seatMap.setCurrent(session.seat.id);
    if (memory.look && !wasActive) session.look(memory.look);
    session.look({ yaw: o.yaw, pitch: o.pitch, lens: o.lens });
    if (typeof o.frame === 'boolean') frameOn = o.frame;
    session.cleanView(!frameOn);
    applyWindow();
    setPace(false, { write: false });
    clock.pause();
    session.show(true);
    writeAddress();
    await session.whenSettled();
    if (my !== token) return;
    if (!wasActive) await fade(false);
    cards.setLoading(false);
    bar.setNote(null);
    if (o.play) clock.play();
    writeAddress();
  }

  /** The orbit panel under the top bar while orbiting (section 4.9's #orbit-controls), made once and kept. */
  function showOrbitPanel(on) {
    if (on && !orbitPanel) {
      orbitPanel = createOrbitPanel({ parent: document.body, params: session.track.orbit, stripCenter, units: settings.units === 'm' ? 'm' : 'ft',
        centerLabel: memory.orbitLabel ?? 'the Strip', collapsed: typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches,
        onChange: (c, info) => { changeOrbit(c, { cut: info?.kind === 'preset' }).catch(() => {}); } });
    } else if (on) orbitPanel.update(session.track.orbit, { centerLabel: memory.orbitLabel ?? undefined });
    if (orbitPanel) orbitPanel.el.hidden = !on;
  }
  /** The controls that belong to a recorded flight or to an orbit. */
  function setKindUi(kind) {
    const orbiting = kind === 'orbit';
    bar.setKind(kind);
    if (el.orbitThis) el.orbitThis.hidden = !orbiting;
    document.body.classList.toggle('orbiting', orbiting);
    if (orbiting || orbitPanel) showOrbitPanel(orbiting);
  }

  /**
   * Change the orbit (the panel, a seat on the other side, "Orbit this", the hook): flown when short, a cut through
   * black when long, a preset always cut (orbit.js planChange). Changes queue, so a cut finishes before the next.
   * @param {object} change a change for orbit.js changeOrbit
   * @param {{ cut?: boolean, label?: string, on?: string }} [o] label and on: the building circled (a centre change)
   * @returns {Promise<{ params: object, cut: boolean, unchanged?: boolean }>}
   */
  function changeOrbit(change, o = {}) {
    const run = async () => {
      if (!seam.active || session?.kind !== 'orbit') throw new Error('not orbiting');
      const plan = session.planOrbit(change, { cut: !!o.cut });
      if ('center' in change) {
        memory.orbitOn = o.on ?? null;
        memory.orbitLabel = o.label ?? null;
      }
      lastOrbitChange = plan.unchanged ? 'none' : plan.cut ? 'cut' : 'flown';
      if (plan.unchanged) { writeAddress(); return plan; }
      if (plan.cut) {
        await fade(true);
        if (!seam.active || session.kind !== 'orbit') { await fade(false); return plan; }
        session.useOrbit(plan);
        orbitPanel?.update(session.track.orbit, { centerLabel: memory.orbitLabel ?? undefined });
        writeAddress();
        await session.whenSettled();
        await fade(false);
      } else {
        session.useOrbit(plan);
        orbitPanel?.update(session.track.orbit, { centerLabel: memory.orbitLabel ?? undefined });
        writeAddress();
      }
      return plan;
    };
    const p = orbitQueue.then(run, run);
    orbitQueue = p.catch(() => {});
    return p;
  }

  /** "Orbit this" on the selected building's card: the orbit re-centred on it, the building named in the link. */
  function orbitThis(entry = app.selected) {
    if (!entry) return Promise.reject(new Error('no building selected'));
    const b = entry.data, off = entry.offset;
    const center = { x: b.c[0] + (off?.x ?? 0), n: b.c[1] - (off?.z ?? 0) };
    return changeOrbit({ center }, { label: app.format.label(b), on: b.id });
  }
  el.orbitThis?.addEventListener('click', () => { if (seam.active && session?.kind === 'orbit') orbitThis().catch(() => {}); });

  /** Leave Fly: everything the map had is given back, under the fade. */
  async function leave() {
    memory.playing = clock.playing;
    if (session.kind === 'orbit') {
      memory.orbit = orbitLinkState(session.track, session.progressS, { defaultCenter: stripCenter });
      if (memory.orbitOn) memory.orbit.on = memory.orbitOn;
    } else memory.at[memory.id] = session.progressS;
    memory.look = session.rig.state;
    memory.seat = session.seat.id;
    memory.pace = session.pace;
    clock.pause();
    await fade(true);
    seatMap?.close();
    windowPanel?.close();
    aboutPanel?.close();
    if (orbitPanel) orbitPanel.el.hidden = true;
    if (el.orbitThis) el.orbitThis.hidden = true;
    document.body.classList.remove('orbiting');
    session.show(false); // the camera back exactly (view/layers.js), the ground and the dome as the map has them
    session.end(); // the journey ends and plan 01's transport hides
    bar.show(false);
    seam.active = false;
    seam.focus = seam.blocked = null;
    fe.restoreMapTime(saved.time);
    if (el.speed && saved.speed !== undefined) el.speed.value = saved.speed;
    controls.target.copy(saved.target);
    controls.enabled = saved.enabled;
    el.views.hidden = false;
    el.night.hidden = false;
    el.hint.textContent = saved.hint;
    if (el.center) el.center.textContent = saved.center;
    el.compass.firstElementChild.style.rotate = saved.compass;
    setCompassTitle(saved.compassTitle);
    document.body.classList.remove('flying');
    app.tall.forEach(app.paint);
    // the window changed shape while flying: let the map fit its lens to it, as it always does
    if (innerWidth !== saved.width || innerHeight !== saved.height) app.views.resize();
    compassDeg = null;
    writeAddress();
    fe.invalidate();
    await fade(false);
  }

  async function exit() {
    token++;
    showMode('map');
    cards.show(false);
    cards.setLoading(false);
    if (!seam.active) { bar.show(false); return; }
    await leave();
  }

  // ---------------------------------------------------------------- the controls
  function setPace(on, { write = true } = {}) {
    if (!session) return;
    session.setPace(on);
    if (!on && clock.rate !== Number(el.speed?.value || 1)) clock.setRate(Number(el.speed?.value || 1));
    if (write) writeAddress();
    fe.invalidate();
  }
  /** Another seat (the seat map, the hook): the cabin and the eye move, the mode remembers it, the address follows. */
  function setSeat(id) {
    if (!session) throw new Error('Fly is not loaded');
    const st = session.setSeat(id);
    memory.seat = st.id;
    if (seatMap && seatMap.model.currentId !== st.id) seatMap.setCurrent(st.id);
    bar.setSeat(st.id);
    // in an orbit the direction follows the seat's side (7.12): the other side reverses it, as a cut
    if (session.kind === 'orbit') changeOrbit({ seat: st.id }).catch(() => {});
    writeAddress();
    fe.invalidate();
    return st;
  }
  const stripSideOf = (id) => (flights.find((f) => f.id === id)?.badges?.stripSide === 'left' ? 'left' : 'right');
  /** The seat map (section 4.3), a popover above the bar: made the first time it is opened, kept for the visit. */
  function toggleSeatMap(open = !(seatMap?.open)) {
    if (!session) return;
    if (!seatMap) {
      seatMap = createSeatMap({ parent: document.body, stripSide: stripSideOf(memory.id), current: session.seat.id,
        onChoose: (id) => setSeat(id), onClose: () => bar.setSeat(null, false) });
    }
    if (open) { windowPanel?.close(); seatMap.setStripSide(stripSideOf(memory.id)); seatMap.setCurrent(session.seat.id); seatMap.show(); } else seatMap.close();
    bar.setSeat(null, seatMap.open);
  }
  /** The window's glass as the panel has it: enabled, effects, focus (window/index.js). */
  function applyWindow() {
    if (!session?.pane) return;
    const p = paneSettings(windowState);
    session.pane.setEnabled(p.enabled);
    session.pane.setEffects(p.effects);
    session.pane.setFocus(p.focus);
    fe.invalidate();
  }
  /** Change any of glass, frost, rain, scratches, reflections, focus ('far' | 'pane'); returns the state now. */
  function setWindow(o = {}) {
    windowState = { ...windowState, ...Object.fromEntries(Object.entries(o).filter(([k, v]) => k in WINDOW_DEFAULTS && v !== undefined)) };
    windowPanel?.set(windowState);
    applyWindow();
    return { ...windowState };
  }
  /** "About this flight" (section 4.2, ui/about.js), from a card or the bar; again on the same flight closes it. */
  function toggleAbout(id, button) {
    if (!aboutPanel) {
      const cifp = Object.entries(CIFP).find(([file]) => file.includes(`/flights/${cityId}/`))?.[1] ?? null;
      aboutPanel = createAboutPanel({ parent: document.body, data, tz: city.tz || 'UTC', flights, cifp, onToggle: (open) => bar.setAbout(open && aboutPanel?.flight === memory.id) });
    }
    if (!aboutPanel.open || aboutPanel.flight !== id) { seatMap?.close(); windowPanel?.close(); }
    const r = aboutPanel.toggle(id, button);
    bar.setAbout(aboutPanel.open && aboutPanel.flight === memory.id);
    return r;
  }

  /** The window panel (F5.7), a popover above the bar: made the first time it is opened, kept for the visit. */
  function toggleWindowPanel(open = !(windowPanel?.open)) {
    if (!session) return;
    if (!windowPanel) {
      windowPanel = createWindowPanel({ parent: document.body, state: windowState,
        onChange: (st) => { windowState = st; applyWindow(); },
        onClose: () => { bar.setWindow(false); bar.windowButton.focus(); } });
    }
    if (open) { seatMap?.close(); windowPanel.set(windowState).show(); } else windowPanel.close();
    bar.setWindow(windowPanel.open);
  }
  function setFrame(on) {
    frameOn = !!on;
    session?.cleanView(!frameOn);
    writeAddress();
  }
  function togglePlay() {
    if (session?.kind === 'orbit' && seam.active) {
      // the orbit only plays or pauses the clock: it runs on its own time and never ends
      if (clock.playing) clock.pause(); else clock.play();
      writeAddress();
      fe.invalidate();
      return;
    }
    if (!session?.handle) return;
    if (clock.playing) clock.pause();
    else {
      // from the end, play flies it again from where playback starts
      if (session.progressS >= session.journey.durationS - 0.05) session.seek(playStart(session.track));
      clock.play();
    }
    writeAddress();
    fe.invalidate();
  }
  function stepRate(dir) {
    const i = RATES.reduce((best, r, k) => (Math.abs(r - clock.rate) < Math.abs(RATES[best] - clock.rate) ? k : best), 0);
    const r = RATES[Math.max(0, Math.min(RATES.length - 1, i + dir))];
    session.setPace(false);
    clock.setRate(r);
    if (el.speed) el.speed.value = String(r);
    fe.invalidate();
  }
  function seekBy(sec) {
    if (!session?.handle) return;
    session.seek(Math.max(0, Math.min(session.journey.durationS, session.progressS + sec)));
    writeAddress();
  }
  function setCompassTitle(text) { el.compass.title = text; el.compass.setAttribute('aria-label', text); }

  /** Look at (the card, the list's focus; section 4.8): the head turns, or a toast says where the building is. */
  function lookAtEntry(entry) {
    const l = session?.lookAt(entry);
    if (l && !l.inView) app.showToast(`${app.format.label(entry.data)} is ${whereText(l.where, session.seat)}.`, false);
    writeAddress();
    return l;
  }

  // the keys of section 4.5 that make sense now; plan 01's transport keys are caught first while flying, so the sky
  // popover's day-scale steps and speeds (60x to 3600x) do not throw the clock off the flight
  addEventListener('keydown', (ev) => {
    if (!seam.active || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || typing(ev.target)) return;
    if (seatMap?.el.contains(ev.target)) return; // the seat map's own keys (arrows, Enter, Space, Escape)
    if (windowPanel?.el.contains(ev.target)) return; // the window panel's (Tab, Space, Escape)
    if (aboutPanel?.el.contains(ev.target)) return; // "About this flight": its links and buttons, Tab and Escape
    if (orbitPanel?.el.contains(ev.target) && ev.code !== 'Space') return; // the orbit panel's sliders and buttons
    const onControl = ev.target instanceof HTMLButtonElement || (ev.target instanceof HTMLInputElement && ev.target.type === 'range');
    // in an orbit the clock moves only the light: seeking and the rate keys are plan 01's, as on the map
    if (session?.kind === 'orbit' && ['BracketLeft', 'BracketRight', 'Comma', 'Period', 'KeyN'].includes(ev.code)) return;
    const act = {
      Space: () => { if (!onControl) togglePlay(); else return false; },
      BracketLeft: () => stepRate(-1), BracketRight: () => stepRate(1),
      Comma: () => seekBy(ev.shiftKey ? -60 : -10), Period: () => seekBy(ev.shiftKey ? 60 : 10),
      KeyC: () => { if (!ev.altKey) setFrame(!frameOn); },
      KeyF: () => { if (!ev.altKey) setWindow({ focus: windowState.focus === 'pane' ? 'far' : 'pane' }); },
      KeyH: () => { if (!ev.altKey) { hud = !hud; onFrame(session); } },
      KeyN: () => {}, // "now" would move the clock off the flight; the transport's Now retimes it instead
    }[ev.code];
    if (!act || act() === false) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  // a focused button would also take Space as a click on its release
  addEventListener('keyup', (ev) => { if (seam.active && ev.code === 'Space' && !typing(ev.target)) ev.preventDefault(); });
  // choosing a speed on plan 01's transport turns the condensed pace off (section 4.4)
  el.speed?.addEventListener('change', () => { if (seam.active && session?.pace) { session.setPace(false); writeAddress(); } }, true);
  // the compass and zoom buttons fly the map's camera; while flying they reset the look and change the lens
  el.tools.addEventListener('click', (ev) => {
    const btn = seam.active && session && ev.target.closest('button');
    const act = btn && { compass: () => session.resetLook(), 'zoom-in': () => session.rig.zoomBy(1.5), 'zoom-out': () => session.rig.zoomBy(1 / 1.5) }[btn.id];
    if (!act) return;
    ev.stopPropagation();
    act();
    fe.invalidate();
    writeAddress();
  }, true);
  // pressing on a selected building to drag it holds the clock for the length of the drag (picking.js claims the
  // drag in the capture phase, so app.dragging() is already true here)
  canvas.addEventListener('pointerdown', () => {
    if (seam.active && app.dragging() && clock.playing) { clock.pause(); dragPaused = true; }
  });
  const release = () => { if (dragPaused) { dragPaused = false; if (seam.active) clock.play(); } };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);

  // ---------------------------------------------------------------- each frame, and the address
  const retimed = () => !!session?.handle && Math.abs(session.handle.startMs - session.journey.recordedStartMs) > RETIMED_MS;
  function onFrame(s) {
    if (!s?.track) return;
    const st = s.track.sample(s.progressS, scratch);
    const orbiting = s.kind === 'orbit';
    const phase = orbiting ? (st.t < s.track.joinT ? 'Changing the orbit' : 'Orbiting') : undefined;
    bar.update({ state: st, touchdownT: s.track.touchdownT, events: s.track.events, pace: s.pace, rate: clock.rate, frame: frameOn, retimed: !orbiting && retimed(), hud, phase });
    if (clock.playing && performance.now() - lastWrite > WRITE_EVERY_MS) writeAddress();
    // the compass needle shows north for the way the eye looks, as it does for the map camera
    const e = camera.matrixWorld.elements;
    const deg = Math.round((Math.atan2(e[8], e[10]) * 180) / Math.PI);
    if (deg !== compassDeg) { compassDeg = deg; el.compass.firstElementChild.style.rotate = `${deg}deg`; }
  }
  const scratch = createState();

  function writeAddress() {
    lastWrite = performance.now();
    let p;
    if (seam.active && session?.kind === 'orbit' && session.track) {
      const l = session.rig.state;
      p = encodeOrbitState(orbitLinkState(session.track, session.progressS, {
        seat: session.seat.id, on: memory.orbitOn ?? undefined, defaultCenter: stripCenter,
        look: { yaw: l.yaw, pitch: l.pitch, lens: l.lens, frame: frameOn }, simMs: clock.live ? undefined : clock.timeMs,
      }), location.search);
    } else if (seam.active && session?.handle) {
      const l = session.rig.state;
      p = encodeFlightState({ id: memory.id, at: session.progressS, seat: session.seat.id, yaw: l.yaw, pitch: l.pitch, lens: l.lens, frame: frameOn, t: retimed() ? clock.timeMs : undefined }, location.search);
    } else p = clearFlightState(location.search);
    const q = p.toString();
    const next = q ? `?${q}` : location.pathname;
    if (next !== location.search) history.replaceState(history.state, '', next);
  }

  return {
    enter, exit, play, writeAddress, togglePlay, enterOrbit, changeOrbit, orbitThis,
    get stripCenter() { return { ...stripCenter }; },
    get lastOrbitChange() { return lastOrbitChange; },
    get orbitPanel() { return orbitPanel; },
    get session() { return session; },
    get frame() { return frameOn; },
    get hud() { return hud; },
    setFrame, setHud(on) { hud = !!on; onFrame(session); }, setPace, setSeat, toggleSeatMap, setWindow, toggleWindowPanel,
    get window() { return { ...windowState }; },
    get windowPanel() { return windowPanel; },
    get aboutPanel() { return aboutPanel; }, toggleAbout,
    get seatMap() { return seatMap; },
    cards, bar, memory,
  };
}

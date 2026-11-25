// Fly mode's controller (plan 03, F1.4 and F1.6), loaded with the session the first time Fly is entered: entering
// and leaving (a 500 ms fade through black; the map's camera, controls, clock and look saved and given back exactly),
// the picker and the flight's bar, the keys, the address, and what-if from the air (Look at, and the clock held for
// the length of a building drag). The scene work is session.js's.
import { createFlightSession } from './session.js';
import { createFlightCards, defaultFlight } from './ui/cards.js';
import { createFlightBar } from './ui/bar.js';
import { createSeatMap } from './ui/seatMap.js';
import { encodeFlightState, clearFlightState } from './url.js';
import { playOptions, playStart } from './pace.js';
import { whereText } from './lookAt.js';
import { createState } from './track.js';
import { flightJourney } from './journey.js';

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

const typing = (t) => !!t && typeof t.matches === 'function' && t.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/**
 * @param {{ app: object, fe: object, terrain: object, meta: object, flights: object[], data: string, seam: object, showMode: (m: string) => void }} o
 *   meta: terrain.json
 */
export function createFlightMode({ app, fe, terrain, meta, flights, data, seam, showMode }) {
  const { camera, controls, settings, city, canvas } = app;
  const { clock } = fe;
  const $ = (id) => document.getElementById(id);
  const el = { views: document.querySelector('.views'), night: $('night'), hint: $('hint').querySelector('span'), compass: $('compass'), tools: $('tools'),
    center: document.querySelector('#card [data-act="center"]'), speed: document.querySelector('#transport .speed') };
  const fadeEl = Object.assign(document.createElement('div'), { id: 'fly-fade', hidden: true });
  fadeEl.setAttribute('aria-hidden', 'true');
  document.body.append(fadeEl);

  const cards = createFlightCards({ parent: $('top'), flights, tz: city.tz || 'UTC', data, onPlay: (id, key) => play(id, key).catch(() => {}) });
  const bar = createFlightBar({ slot: $('transport-slot'), units: () => settings.units, onPace: () => setPace(!session?.pace), onFrame: () => setFrame(!frameOn), onSeat: () => toggleSeatMap() });
  let seatMap = null;
  let session = null, loading = null, token = 0, saved = null, hud = true, frameOn = true, lastWrite = 0, dragPaused = false, compassDeg = null;
  /** What the mode remembers for the visit (section 4.1): flight, seat, look and time, and whether it was playing. */
  const memory = { id: defaultFlight(flights).id, seat: null, look: null, at: {}, playing: false, pace: true };

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

  /** Leave Fly: everything the map had is given back, under the fade. */
  async function leave() {
    memory.playing = clock.playing;
    memory.at[memory.id] = session.progressS;
    memory.look = session.rig.state;
    memory.seat = session.seat.id;
    memory.pace = session.pace;
    clock.pause();
    await fade(true);
    seatMap?.close();
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
    if (open) { seatMap.setStripSide(stripSideOf(memory.id)); seatMap.setCurrent(session.seat.id); seatMap.show(); } else seatMap.close();
    bar.setSeat(null, seatMap.open);
  }
  function setFrame(on) {
    frameOn = !!on;
    session?.cleanView(!frameOn);
    writeAddress();
  }
  function togglePlay() {
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
    const onControl = ev.target instanceof HTMLButtonElement || (ev.target instanceof HTMLInputElement && ev.target.type === 'range');
    const act = {
      Space: () => { if (!onControl) togglePlay(); else return false; },
      BracketLeft: () => stepRate(-1), BracketRight: () => stepRate(1),
      Comma: () => seekBy(ev.shiftKey ? -60 : -10), Period: () => seekBy(ev.shiftKey ? 60 : 10),
      KeyC: () => { if (!ev.altKey) setFrame(!frameOn); },
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
    bar.update({ state: st, touchdownT: s.track.touchdownT, events: s.track.events, pace: s.pace, rate: clock.rate, frame: frameOn, retimed: retimed(), hud });
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
    if (seam.active && session?.handle) {
      const l = session.rig.state;
      p = encodeFlightState({ id: memory.id, at: session.progressS, seat: session.seat.id, yaw: l.yaw, pitch: l.pitch, lens: l.lens, frame: frameOn, t: retimed() ? clock.timeMs : undefined }, location.search);
    } else p = clearFlightState(location.search);
    const q = p.toString();
    const next = q ? `?${q}` : location.pathname;
    if (next !== location.search) history.replaceState(history.state, '', next);
  }

  return {
    enter, exit, play, writeAddress, togglePlay,
    get session() { return session; },
    get frame() { return frameOn; },
    get hud() { return hud; },
    setFrame, setHud(on) { hud = !!on; onFrame(session); }, setPace, setSeat, toggleSeatMap,
    get seatMap() { return seatMap; },
    cards, bar, memory,
  };
}

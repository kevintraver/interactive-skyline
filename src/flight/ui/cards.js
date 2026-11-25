// The flight picker (plan 03, section 4.2), beside the Map | Drive | Fly switch in #top, in the map-style language of
// the drive's route cards: collapsed while flying to one chip for the flight being flown; open, one card per recorded
// flight with its title (the runway and where it came from; no airline, flight number or registration), the real date
// and local time of touchdown, its badges, and the ways to play it. First, the Orbit entry (4.6, 4.9: "Fly in | Orbit"):
// circle the city at one of the three presets' heights, changed afterwards in the orbit panel.
import { minutesText } from '../pace.js';

const LIGHT_ORDER = { day: 0, dusk: 1, night: 2 };
const SIDE = { left: 'Strip on the left', right: 'Strip on the right' };
/** Where the Strip is seen from the window over the last three minutes (the header's badges.stripView, by the bake). */
const VIEW = {
  right: 'Strip on the right', left: 'Strip on the left',
  'passes-right': 'Strip passes on the right', 'passes-left': 'Strip passes on the left',
  'ahead-right': 'Strip ahead, to the right', 'ahead-left': 'Strip ahead, to the left',
  ahead: 'Strip ahead', none: 'Strip out of sight',
};

/** The Strip badge's words: from stripView, else (a value this version does not know, or none) from stripSide. */
export const stripText = (b = {}) => VIEW[b.stripView] ?? SIDE[b.stripSide] ?? null;

/** The card's picture: `<id>.jpg` beside the flight (tests/e2e/flight/preview.gpu.spec.js renders it). Looked for by
 * convention, since scripts/bake_flights.py writes the index afresh with `preview: null`; a missing one shows none. */
export const previewUrl = (f, data) => `${String(data).replace(/\/$/, '')}/flights/${f.id}.jpg`;

/** The card's title: the runway and where the flight came from, in plain words. */
export const titleOf = (f) => f.label || `Runway ${f.runway ?? '?'}${f.badges?.from ? `, from the ${f.badges.from}` : ''}`;

/** "Sat 15 Mar 2025 · touched down 12:42 pm", in the airport's time zone. */
export function whenText(touchdownIso, tz) {
  const d = new Date(touchdownIso);
  if (!Number.isFinite(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d).replace(',', '');
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d).toLowerCase();
  return `${date} · touched down ${time}`;
}

/** The badges: the light at touchdown, the runway, the weather as flown, the Strip's side. */
export function badgesOf(f) {
  const b = f.badges || {};
  return [b.light, f.runway, b.weather, stripText(b)].filter(Boolean).map((t) => String(t).toUpperCase());
}

/** The flight Fly opens on (section 4.7): the index's first, which scripts/bake_flights.py writes in selection.json's
 * order with the default first (the dusk arrival on runway 19). */
export const defaultFlight = (flights) => flights[0];

/** The id the cards use for the orbit (setCurrent(ORBIT_ID) while orbiting). */
export const ORBIT_ID = 'orbit';
const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** "The valley · 12,000 ft". */
export const orbitPresetText = (p) => `${p.label} · ${group.format(p.altFt)} ft`;
/** The collapsed chip's words: the orbit, the flight being flown, or a prompt. */
export function chipTitle(current, flights) {
  if (current === ORBIT_ID) return 'Orbit';
  const f = flights.find((x) => x.id === current);
  return f ? titleOf(f) : 'Choose a flight';
}

/** The default first, then day, dusk, night (section 4.2), each by runway, then by id. */
export function sortFlights(list) {
  const first = list[0];
  const rest = list.slice(1).sort((a, b) => (LIGHT_ORDER[a.badges?.light] ?? 3) - (LIGHT_ORDER[b.badges?.light] ?? 3)
    || String(a.runway).localeCompare(String(b.runway)) || String(a.id).localeCompare(String(b.id)));
  return first ? [first, ...rest] : [];
}

/**
 * @param {{ parent: Element, flights: object[], tz: string, data?: string, onPlay: (id: string, key: string) => void,
 *   orbit?: { presets: { key: string, label: string, altFt: number }[], primary?: string, onPlay: (preset: string) => void },
 *   onAbout?: (id: string, button: HTMLElement) => void }} o
 *   flights are flights/index.json's entries; data the city's data folder (the previews are looked for there);
 *   setOptions fills in the ways to play once a flight's track is in; orbit adds the Orbit entry, one button a preset;
 *   onAbout opens "About this flight" (ui/about.js) from the card's About button
 */
export function createFlightCards({ parent, flights, tz, data = null, onPlay, orbit = null, onAbout = null }) {
  const box = document.createElement('section');
  box.className = 'flights';
  box.setAttribute('aria-label', 'Flights');
  box.hidden = true;
  box.innerHTML = `<button type="button" class="flight-chip" aria-expanded="false" aria-controls="flight-list" title="Choose a flight">
      <span class="name"></span>
      <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#i-chevron" /></svg>
      <span class="progress" aria-hidden="true" hidden><i></i></span>
    </button>
    <div class="flight-list" id="flight-list" role="group" aria-label="Recorded arrivals" hidden></div>`;
  parent.append(box);
  const chip = box.querySelector('.flight-chip'), chipName = chip.querySelector('.name'), progress = chip.querySelector('.progress');
  const list = box.querySelector('.flight-list');
  const cards = new Map();
  const state = { shown: false, open: false, loading: false, current: null };

  for (const f of sortFlights(flights)) {
    const card = document.createElement('article');
    card.className = 'flight-card';
    card.dataset.flight = f.id;
    card.innerHTML = `<div class="head"><b></b><span class="when"></span></div>
      <div class="badges"></div>
      <div class="plays" role="group" aria-label="Play this flight"></div>
      <p class="err" hidden>This flight could not be loaded.</p>`;
    card.querySelector('b').textContent = titleOf(f);
    if (data) {
      // the picture, when there is one: shown once it has loaded, dropped when it is missing (section 4.11)
      const img = Object.assign(document.createElement('img'), { className: 'preview', alt: '', decoding: 'async', hidden: true });
      img.addEventListener('load', () => { img.hidden = false; card.classList.add('has-preview'); }, { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = previewUrl(f, data);
      card.prepend(img);
    }
    card.querySelector('.when').textContent = whenText(f.touchdown, tz);
    const badges = card.querySelector('.badges');
    for (const t of badgesOf(f)) badges.append(Object.assign(document.createElement('span'), { textContent: t }));
    const len = Object.assign(document.createElement('span'), { className: 'len', textContent: Number.isFinite(f.duration) ? minutesText(f.duration) : '' });
    badges.append(len);
    const plays = card.querySelector('.plays');
    for (const [key, label] of [['pace', 'Play'], ['real', 'Real time'], ['final', 'Final']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.play = key;
      b.textContent = label;
      if (key === 'pace') b.className = 'primary';
      b.addEventListener('click', () => { b.blur(); setOpen(false); onPlay(f.id, key); });
      plays.append(b);
    }
    if (onAbout) {
      // the flight's provenance (section 4.2): where the track comes from, what is inferred, its quality report
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'about';
      b.dataset.about = f.id;
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-controls', 'flightabout');
      b.textContent = 'About this flight';
      b.addEventListener('click', () => onAbout(f.id, b));
      plays.append(b);
    }
    list.append(card);
    cards.set(f.id, { card, flight: f });
  }

  if (orbit) {
    const card = document.createElement('article');
    card.className = 'flight-card orbit-card';
    card.dataset.flight = ORBIT_ID;
    card.innerHTML = `<div class="head"><b>Orbit the city</b><span class="when">Circle the Strip from 4,500 to 41,000 ft; the speed follows the height</span></div>
      <div class="plays" role="group" aria-label="Orbit at"></div>`;
    const plays = card.querySelector('.plays');
    for (const p of orbit.presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.orbit = p.key;
      b.textContent = orbitPresetText(p);
      if (p.key === (orbit.primary ?? orbit.presets[0]?.key)) b.className = 'primary';
      b.addEventListener('click', () => { b.blur(); setOpen(false); orbit.onPlay(p.key); });
      plays.append(b);
    }
    list.prepend(card); // first: below the fold of six flights it would not be found
    cards.set(ORBIT_ID, { card, flight: null });
  }

  chip.addEventListener('click', () => setOpen(!state.open));
  // Escape and a press elsewhere collapse the open picker (a look-drag on the picture starts with a press too)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open && !e.target.closest?.('#flightabout')) setOpen(false); });
  // (not a press in "About this flight", opened from a card: the picker stays open behind it)
  document.addEventListener('pointerdown', (e) => { if (state.open && !box.contains(e.target) && !e.target.closest?.('#flightabout')) setOpen(false); }, true);

  function render() {
    box.hidden = !state.shown;
    list.hidden = !(state.shown && state.open);
    box.classList.toggle('open', state.shown && state.open);
    chip.setAttribute('aria-expanded', String(state.shown && state.open));
    progress.hidden = !(state.shown && state.loading);
    chipName.textContent = chipTitle(state.current, flights);
    for (const [id, c] of cards) c.card.classList.toggle('current', id === state.current);
  }
  function setOpen(open) { state.open = !!open && state.shown; render(); }

  render();
  return {
    el: box,
    state,
    show(on) { state.shown = !!on; if (!on) state.open = false; render(); },
    setOpen,
    setLoading(on) { state.loading = !!on; render(); },
    setCurrent(id) { state.current = id; render(); },
    /** The ways to play a flight once its track is in: playOptions() from pace.js. */
    setOptions(id, options) {
      const c = cards.get(id);
      if (!c) return;
      for (const o of options) {
        const b = c.card.querySelector(`[data-play="${o.key}"]`);
        if (b) b.textContent = `${o.label} (${minutesText(o.wallS)})`;
      }
    },
    /** A flight file that failed: its card says so; the others work (section 4.11). */
    setFailed(id, failed) {
      const c = cards.get(id);
      if (!c) return;
      c.card.querySelector('.err').hidden = !failed;
      c.card.classList.toggle('failed', !!failed);
    },
  };
}

// The route picker (plan 02, sections 4.2 and D9.4), beside the Map | Drive switch in #top. Two states:
//
//   collapsed  one compact chip for the route being driven: its small map, its name and a chevron that opens the
//              picker. A thin line runs under it while the drive or a route loads. This is the state while
//              driving, so the picker never covers the picture.
//   open       below the chip, one card per route: a small line map of the route across the valley (the car on the
//              current one), its name, its length and its time at the posted limits, and its start chips. Choosing a
//              card drives that route from its default start at its default moment; a chip, from that start. On a
//              phone a card folds to one row and its chevron opens the chips.
//
// The picker opens when Drive is entered (the routes show while the drive loads) and collapses once the drive is
// under way, on a choice, on Escape and on a press elsewhere. The states are a pure function of a few events
// (pickerReduce, pickerView below), unit-tested in tests/unit/drive/ui-picker.test.js.

import { routeShape, outlineShape } from './routemap.js';
import { formatDistance, formatDuration } from './format.js';

export const STARTS = [
  ['reveal', 'Before the view opens'],
  ['start', 'From the start'],
  ['city', 'Through the city'],
];
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** The picker's state before Drive is entered. */
export const PICKER_INITIAL = Object.freeze({ shown: false, open: false, loading: false, current: null });

/**
 * The picker's next state.
 * @param {{ shown: boolean, open: boolean, loading: boolean, current: string|null }} state
 * @param {{ type: 'enter'|'exit'|'underway'|'toggle'|'open'|'choose'|'dismiss'|'loading'|'current', open?: boolean, on?: boolean, route?: string }} e
 *   enter     Drive is entered: shown, and open while the drive loads
 *   exit      Drive is left: hidden
 *   underway  the drive's first frame is in (and the clock plays, or a link opened it paused): collapsed
 *   toggle    the chip was pressed;  open: set open or collapsed (a test hook)
 *   choose    a card or a start chip was chosen (route: the route chosen): collapsed, that route current
 *   dismiss   Escape, a press elsewhere, or the search box opened: collapsed
 *   loading   the thin line on (on: true) or off;  current: the route the drive is on (route)
 */
export function pickerReduce(state, e) {
  switch (e.type) {
    case 'enter': return { ...state, shown: true, open: true };
    case 'exit': return { ...state, shown: false, open: false, loading: false };
    case 'underway': return { ...state, open: false };
    case 'toggle': return state.shown ? { ...state, open: !state.open } : state;
    case 'open': return state.shown ? { ...state, open: !!e.open } : state;
    case 'choose': return { ...state, open: false, current: e.route ?? state.current };
    case 'dismiss': return state.open ? { ...state, open: false } : state;
    case 'loading': return { ...state, loading: !!e.on };
    case 'current': return { ...state, current: e.route ?? state.current };
    default: return state;
  }
}

/** What the DOM shows for a state: the whole picker, the chip, the cards, the chip's aria-expanded, the thin line. */
export function pickerView(s) {
  return { box: s.shown, chip: s.shown, list: s.shown && s.open, expanded: String(s.shown && s.open), progress: s.shown && s.loading };
}

/**
 * @param {{ parent: Element, routes: { id: string, label: string, from?: string, to?: string }[], units: () => 'ft'|'m',
 *           onStart: (key: string, routeId: string) => void, onRoute: (id: string) => void }} opts
 *   parent is #top (the picker joins it after the Map | Drive switch); routes are the city's (cities.json), known
 *   before anything is downloaded; setInfo adds each route's facts and outline (routes.json), setRoute the road
 */
export function createRouteCards({ parent, routes, units, onStart, onRoute }) {
  const box = document.createElement('section');
  box.className = 'routes';
  box.setAttribute('aria-label', 'Drives');
  box.hidden = true;
  box.innerHTML = `<button type="button" class="route-chip" aria-expanded="false" aria-controls="route-list" title="Choose a drive">
      <svg class="map" viewBox="0 0 64 64" aria-hidden="true"></svg>
      <span class="name"></span>
      <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#i-chevron" /></svg>
      <span class="progress" aria-hidden="true" hidden><i></i></span>
    </button>
    <div class="route-list" id="route-list" role="group" aria-label="Routes" hidden></div>`;
  parent.append(box);
  const chip = box.querySelector('.route-chip'), chipName = chip.querySelector('.name'), chipMap = chip.querySelector('.map');
  const chipProgress = chip.querySelector('.progress');
  const list = box.querySelector('.route-list');
  const many = routes.length > 1;
  const cards = new Map();
  let state = { ...PICKER_INITIAL, current: routes[0]?.id ?? null };

  for (const r of routes) {
    const card = document.createElement('article');
    card.className = 'route-card';
    card.dataset.route = r.id;
    const headTag = many ? 'button' : 'div';
    card.innerHTML = `<div class="head">
        <${headTag} class="pick"${many ? ' type="button" aria-pressed="false"' : ''}>
          <svg class="map" viewBox="0 0 64 64" aria-hidden="true"></svg>
          <span class="what"><b></b><span class="facts"></span></span>
        </${headTag}>
        <button type="button" class="more" aria-expanded="false" aria-label="Where to start">
          <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use href="#i-chevron" /></svg>
        </button>
      </div>
      <div class="starts" role="group" aria-label="Start"></div>`;
    card.querySelector('b').textContent = r.label || r.id;
    if (r.from && r.to) {
      card.querySelector('.facts').textContent = `${r.from} to ${r.to}`;
      card.querySelector('.pick').title = `${r.from} to ${r.to}`;
    }
    card.querySelector('.starts').id = `starts-${r.id}`;
    card.querySelector('.more').setAttribute('aria-controls', `starts-${r.id}`);
    const starts = card.querySelector('.starts');
    for (const [key, text] of STARTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.start = key;
      b.textContent = text;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { b.blur(); dispatch({ type: 'choose', route: r.id }); onStart(key, r.id); });
      starts.append(b);
    }
    if (many) card.querySelector('.pick').addEventListener('click', () => { dispatch({ type: 'choose', route: r.id }); onRoute(r.id); });
    const more = card.querySelector('.more');
    more.addEventListener('click', () => {
      const open = !card.classList.contains('open');
      card.classList.toggle('open', open);
      more.setAttribute('aria-expanded', String(open));
    });
    list.append(card);
    cards.set(r.id, { card, route: r, info: null, shape: null, car: null, shown: {} });
  }

  chip.addEventListener('click', () => dispatch({ type: 'toggle' }));
  // Escape and a press elsewhere collapse the open picker (a look-drag on the picture starts with a press too)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) dispatch({ type: 'dismiss' }); });
  document.addEventListener('pointerdown', (e) => { if (state.open && !box.contains(e.target)) dispatch({ type: 'dismiss' }); }, true);

  function dispatch(e) {
    const next = pickerReduce(state, e);
    if (next === state) return;
    const was = state;
    state = next;
    if (next.current !== was.current) markCurrent();
    render();
  }
  function render() {
    const v = pickerView(state);
    box.hidden = !v.box;
    list.hidden = !v.list;
    box.classList.toggle('open', v.list);
    chip.setAttribute('aria-expanded', v.expanded);
    chipProgress.hidden = !v.progress;
    box.classList.toggle('loading', v.progress);
  }
  function markCurrent() {
    for (const [rid, c] of cards) {
      c.card.classList.toggle('current', rid === state.current);
      if (many) c.card.querySelector('.pick').setAttribute('aria-pressed', String(rid === state.current));
    }
    const c = cards.get(state.current);
    chipName.textContent = c ? (c.route.label || c.route.id) : '';
    chip.setAttribute('aria-label', c ? `Drive: ${c.route.label || c.route.id}. Choose a drive` : 'Choose a drive');
    drawChip();
  }
  function drawChip() {
    const c = cards.get(state.current);
    if (!c?.shape) { chipMap.replaceChildren(); return; }
    chipMap.replaceChildren(svgEl('path', { class: 'line', d: c.shape.d }));
  }

  /** Draw a card's map from a shape (routemap.js), with the city, the reveal and the car. */
  function drawCard(c, shape) {
    const svg = c.card.querySelector('.map');
    const [cx, cy] = shape.mark(0, 0);
    const kids = [svgEl('path', { class: 'line', d: shape.d }), svgEl('circle', { class: 'city', cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2.2 })];
    if (c.info?.reveal) {
      const [rx, ry] = shape.at(c.info.reveal.s);
      kids.push(svgEl('circle', { class: 'reveal', cx: rx.toFixed(1), cy: ry.toFixed(1), r: 2 }));
    }
    c.car = svgEl('circle', { class: 'car', r: 3.2, cx: -10, cy: -10 });
    kids.push(c.car);
    svg.replaceChildren(...kids);
    c.shape = shape;
    c.shown.car = null;
    if (c.route.id === state.current) drawChip();
  }
  function writeFacts(c) {
    const u = units();
    if (!c.info || !Number.isFinite(c.info.length) || c.shown.units === u) return;
    c.shown.units = u;
    c.card.querySelector('.facts').textContent = `${formatDistance(c.info.length, u)} · ${formatDuration(c.info.postedSeconds)} at the limits`;
  }

  /** A route's facts and outline from routes.json: { length, postedSeconds, s0, s1, reveal?, outline? }. */
  function setInfo(id, info) {
    const c = cards.get(id);
    if (!c || !info) return;
    c.info = { ...c.info, ...info };
    c.shown.units = null;
    writeFacts(c);
    if (info.outline?.length > 1 && !c.fromRoad) drawCard(c, outlineShape(info.outline, { s0: info.s0 ?? 0, s1: info.s1 ?? info.length }));
  }

  /** The route the drive is on, with its road once loaded (the map is then drawn from the road itself). */
  function setRoute(id, info) {
    dispatch({ type: 'current', route: id });
    markCurrent();
    const c = cards.get(id);
    if (!c || !info) return;
    setInfo(id, info);
    if (info.road) { c.fromRoad = true; drawCard(c, routeShape(info.road, { s0: info.s0, s1: info.s1 })); }
  }

  markCurrent();
  render();
  return {
    el: box,
    get state() { return { ...state }; },
    /** Drive entered (open while it loads) or left. */
    show(on) { dispatch({ type: on ? 'enter' : 'exit' }); },
    /** The drive is under way: out of the way. */
    underway() { dispatch({ type: 'underway' }); },
    /** Open or collapse the picker (the chip does it for the visitor). */
    setOpen(on) { dispatch({ type: 'open', open: on }); },
    dismiss() { dispatch({ type: 'dismiss' }); },
    /** The thin line under the chip while the drive or a route loads. */
    setLoading(on) { dispatch({ type: 'loading', on }); },
    setInfo,
    setRoute,
    /** The car on the current card's map, the chosen chip and the units; writes only what changed. */
    update({ s, startKey }) {
      for (const c of cards.values()) writeFacts(c);
      const c = cards.get(state.current);
      if (!c) return;
      if (startKey !== c.shown.start) {
        c.shown.start = startKey;
        for (const b of c.card.querySelectorAll('.starts button')) b.setAttribute('aria-pressed', String(b.dataset.start === startKey));
        for (const o of cards.values()) if (o !== c) { o.shown.start = null; for (const b of o.card.querySelectorAll('.starts button')) b.setAttribute('aria-pressed', 'false'); }
      }
      if (c.shape && c.car && Number.isFinite(s)) {
        const [x, y] = c.shape.at(s);
        const key = `${x.toFixed(1)},${y.toFixed(1)}`;
        if (key !== c.shown.car) {
          c.shown.car = key;
          c.car.setAttribute('cx', x.toFixed(1));
          c.car.setAttribute('cy', y.toFixed(1));
        }
      }
    },
  };
}

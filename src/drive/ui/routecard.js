// Route cards, shown in Drive where the viewpoint chips are in Map: one card per route with a small
// line map of the route across the valley (the car on it), the route's name, its length and its time
// at the posted limits, and the three start chips. A thin line runs under the card while the drive
// loads. On a phone the card folds to one row; its chevron opens the chips.

import { routeShape } from './routemap.js';
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

/**
 * @param {{ after: Element, routes: { id: string, label: string }[], units: () => 'ft'|'m',
 *           onStart: (key: string) => void, onRoute: (id: string) => void }} opts
 *   routes are the city's (cities.json), known before anything is downloaded; the rest arrives with setRoute
 */
export function createRouteCards({ after, routes, units, onStart, onRoute }) {
  const box = document.createElement('section');
  box.className = 'routes';
  box.setAttribute('aria-label', 'Drives');
  box.hidden = true;
  after.after(box);
  const many = routes.length > 1;
  const cards = new Map();

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
      <div class="starts" role="group" aria-label="Start"></div>
      <div class="progress" aria-hidden="true" hidden><i></i></div>`;
    card.querySelector('b').textContent = r.label || r.id;
    if (r.from && r.to) card.querySelector('.facts').textContent = `${r.from} to ${r.to}`;
    card.querySelector('.starts').id = `starts-${r.id}`;
    card.querySelector('.more').setAttribute('aria-controls', `starts-${r.id}`);
    const starts = card.querySelector('.starts');
    for (const [key, text] of STARTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.start = key;
      b.textContent = text;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { b.blur(); onStart(key); });
      starts.append(b);
    }
    if (many) card.querySelector('.pick').addEventListener('click', () => onRoute(r.id));
    const more = card.querySelector('.more');
    more.addEventListener('click', () => {
      const open = !card.classList.contains('open');
      card.classList.toggle('open', open);
      more.setAttribute('aria-expanded', String(open));
    });
    box.append(card);
    cards.set(r.id, { card, info: null, shape: null, car: null, shown: {} });
  }

  let current = routes[0]?.id;

  /** Facts and the line map, once routes.json and the road have loaded. */
  function setRoute(id, info) {
    current = id;
    for (const [rid, c] of cards) {
      c.card.classList.toggle('current', rid === id);
      if (many) c.card.querySelector('.pick').setAttribute('aria-pressed', String(rid === id));
    }
    const c = cards.get(id);
    if (!c || !info) return;
    c.info = info;
    c.shown = {};
    if (info.road) {
      const shape = routeShape(info.road, { s0: info.s0, s1: info.s1 });
      const svg = c.card.querySelector('.map');
      const [cx, cy] = shape.mark(0, 0);
      const parts = [
        svgEl('path', { class: 'line', d: shape.d }),
        svgEl('circle', { class: 'city', cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2.2 }),
      ];
      if (info.reveal) {
        const [rx, ry] = shape.at(info.reveal.s);
        parts.push(svgEl('circle', { class: 'reveal', cx: rx.toFixed(1), cy: ry.toFixed(1), r: 2 }));
      }
      c.car = svgEl('circle', { class: 'car', r: 3.2, cx: -10, cy: -10 });
      parts.push(c.car);
      svg.replaceChildren(...parts);
      c.shape = shape;
    }
  }

  return {
    el: box,
    show(on) { box.hidden = !on; },
    /** The thin line under the card while the drive's data loads. */
    setLoading(on) {
      for (const c of cards.values()) c.card.querySelector('.progress').hidden = !(on && c.card.dataset.route === current);
      box.classList.toggle('loading', on);
    },
    setRoute,
    /** The car on the map, the chosen chip and the units; writes only what changed. */
    update({ s, startKey }) {
      const c = cards.get(current);
      if (!c) return;
      const u = units();
      if (c.info && c.shown.units !== u) {
        c.shown.units = u;
        const facts = `${formatDistance(c.info.length, u)} · ${formatDuration(c.info.postedSeconds)} at the limits`;
        c.card.querySelector('.facts').textContent = facts;
      }
      if (startKey !== c.shown.start) {
        c.shown.start = startKey;
        for (const b of c.card.querySelectorAll('.starts button')) b.setAttribute('aria-pressed', String(b.dataset.start === startKey));
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

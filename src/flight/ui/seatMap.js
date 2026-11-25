// The seat map (plan 03, section 4.3; F3.6): a top-down SVG of the cabin with the wing drawn to scale beside it,
// every seat selectable by pointer or keyboard, each window a tick on the fuselage edge at its true station (a blank
// panel a grey bar), the side that sees the Strip on this flight marked, the default seat marked, and three
// shortcuts: ahead of, over and behind the wing on the Strip's side.
//
// Two halves: the pure model (seatMapModel, describeSeat, nextSeatId: geometry, words and keyboard movement, unit
// tested without a DOM) and createSeatMap, which draws the model into a popover (.pop, like #sky) and returns the
// chosen seat through onChoose or the promise of choose(). Its styles are injected once as a <style id="seatmap-style">
// so the app's stylesheet needs nothing new.
//
// Drawn nose to the left, seen from above: the right side (D E F) is at the top, the left side (A B C) at the bottom.

import { allSeats, seat as seatOf, windowStations, defaultSeat, seatFor, rowFront, seatCentreX, parseSeat, ROWS, LETTERS } from '../cabin/lopa.js';
import { FUSELAGE, WING, CABIN, ENGINE } from '../aircraft/dimensions.js';

/** Drawing scale, SVG units (px at 1:1) per metre. */
export const SCALE = 24;
/** The stretch of fuselage drawn, metres aft of the nose, and how far out the wing is drawn from the centre line. */
export const FROM = 3.6, TO = 32.4, OUT = 6.2;

const sx = (station) => (station - FROM) * SCALE;
/** Up the map is the aircraft's right: y grows downward in SVG, so the right side is negative. */
const sy = (out) => (OUT - out) * SCALE;
const r1 = (v) => Math.round(v * 10) / 10;

const PLACE = { ahead: 'ahead of the wing', over: 'over the wing', behind: 'behind the wing' };
const SEAT_KIND = ['window seat', 'middle seat', 'aisle seat'];

/** "12 cm ahead of" / "level with" / "30 cm behind": where a window is against the eye. */
function offsetText(ahead) {
  const cm = Math.round(Math.abs(ahead) * 100);
  if (cm <= 3) return 'level with your shoulder';
  return `${cm} cm ${ahead > 0 ? 'ahead of' : 'behind'} your shoulder`;
}

/**
 * The words for a seat (plan 4.3): "22F · right · behind the wing · window 12 cm ahead of your shoulder".
 * @param {ReturnType<typeof seatOf>} s
 * @param {{ stripSide?: 'left'|'right' }} [o]
 */
export function describeSeat(s, { stripSide } = {}) {
  const parts = [s.id, s.side, PLACE[s.wing]];
  const n = s.nearest[0];
  if (s.window) {
    if (s.blankWall) {
      const next = s.nearest.find((w) => !w.blank);
      parts.push(`no window: a blank wall${next ? `, the nearest window ${Math.round(Math.abs(next.ahead) * 100)} cm ${next.ahead > 0 ? 'ahead' : 'behind'}` : ''}`);
    } else parts.push(`window ${offsetText(n.ahead)}`);
  } else parts.push(`${SEAT_KIND[s.fromWindow]}, ${s.fromWindow === 1 ? 'one seat' : 'two seats'} from the window`);
  if (stripSide && s.side === stripSide) parts.push('the Strip side');
  return parts.join(' · ');
}

/**
 * Everything the map draws, in SVG units, for a flight whose Strip is on `stripSide`.
 * @param {{ stripSide?: 'left'|'right', current?: string }} [o]
 */
export function seatMapModel({ stripSide = 'right', current } = {}) {
  const side = stripSide === 'left' ? 'left' : 'right';
  const def = defaultSeat(side);
  const cur = parseSeat(current) ? seatOf(current).id : def.id;
  const half = FUSELAGE.width / 2, trim = FUSELAGE.cabinWidth / 2;
  const seats = allSeats().map((s) => {
    const depth = CABIN.cushionDepth + CABIN.backThickness;
    return {
      id: s.id, row: s.row, letter: s.letter, side: s.side, window: s.window, blankWall: s.blankWall, wing: s.wing,
      strip: s.side === side, isDefault: s.id === def.id, current: s.id === cur,
      x: r1(sx(s.front)), y: r1(sy(seatCentreX(s.letter) + CABIN.seatWidth / 2)),
      w: r1(depth * SCALE), h: r1(CABIN.seatWidth * SCALE),
      label: describeSeat(s, { stripSide: side }),
    };
  });
  const ticks = [];
  for (const sd of ['right', 'left']) {
    const sign = sd === 'right' ? 1 : -1;
    for (const w of windowStations(sd)) ticks.push({ side: sd, blank: w.blank, station: w.station, x: r1(sx(w.station)), y: r1(sy(sign * half)) });
  }
  // the wing's planform to scale from the fuselage side out to the map's edge, each side; the nacelle under it
  const wingSide = (sign) => {
    const outs = [half, 3.2, 4.4, OUT];
    const le = outs.map((o) => [sx(WING.le(o)), sy(sign * o)]);
    const te = outs.slice().reverse().map((o) => [sx(WING.te(o)), sy(sign * o)]);
    return [...le, ...te].map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
  };
  const nacelle = (sign) => ({ x: r1(sx(ENGINE.inlet)), y: r1(sy(sign * ENGINE.out + ENGINE.width / 2)), w: r1(4.2 * SCALE), h: r1(ENGINE.width * SCALE) });
  // the fuselage outline: the plan view's half width (a constant section with tapered ends inside the drawn stretch)
  const body = { x: 0, y: r1(sy(half)), w: r1((TO - FROM) * SCALE), h: r1(2 * half * SCALE) };
  const cabin = { x: 0, y: r1(sy(trim)), w: r1((TO - FROM) * SCALE), h: r1(2 * trim * SCALE) };
  const rows = Array.from({ length: ROWS }, (_, i) => ({ row: i + 1, x: r1(sx(rowFront(i + 1) + 0.3)), yTop: r1(sy(half) - 6), yBottom: r1(sy(-half) + 14) }));
  return {
    width: r1((TO - FROM) * SCALE), height: r1(2 * OUT * SCALE),
    stripSide: side, defaultId: def.id, currentId: cur,
    shortcuts: { ahead: seatFor('ahead', side).id, over: seatFor('over', side).id, behind: seatFor('behind', side).id },
    seats, ticks, rows, body, cabin,
    wing: { right: wingSide(1), left: wingSide(-1) },
    nacelles: { right: nacelle(1), left: nacelle(-1) },
  };
}

/**
 * Keyboard movement over the map (drawn nose left, right side up): ArrowLeft toward the nose, ArrowRight toward the
 * tail, ArrowUp toward F, ArrowDown toward A, Home and End the first and last row, PageUp and PageDown five rows.
 * Returns the seat id moved to (the same id at an edge), or null for a key that does not move.
 * @param {string} id  @param {string} key
 */
export function nextSeatId(id, key) {
  const p = parseSeat(id);
  if (!p) return null;
  let { row } = p;
  let li = LETTERS.indexOf(p.letter);
  switch (key) {
    case 'ArrowLeft': row -= 1; break;
    case 'ArrowRight': row += 1; break;
    case 'ArrowUp': li += 1; break;
    case 'ArrowDown': li -= 1; break;
    case 'Home': row = 1; break;
    case 'End': row = ROWS; break;
    case 'PageUp': row -= 5; break;
    case 'PageDown': row += 5; break;
    default: return null;
  }
  row = Math.min(ROWS, Math.max(1, row));
  li = Math.min(LETTERS.length - 1, Math.max(0, li));
  return `${row}${LETTERS[li]}`;
}

// ---------------------------------------------------------------- the DOM

const STYLE_ID = 'seatmap-style';
const STYLE = `
.seatmap { width: min(calc(100vw - 2 * var(--gap, 12px)), 760px); max-height: calc(100vh - 140px); overflow: auto; padding: 10px 12px 12px; color: var(--ink, #1d2329); }
.seatmap .sm-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 8px; }
.seatmap .sm-title { font-weight: 650; margin-right: auto; }
.seatmap .sm-strip { color: var(--muted, #5b6570); font-size: 12.5px; flex-basis: 100%; }
.seatmap .sm-short { padding: 5px 10px; border-radius: 8px; background: var(--fill, rgba(0,0,0,.06)); font-weight: 600; }
.seatmap .sm-short:hover, .seatmap .sm-short:focus-visible { background: var(--fill-strong, rgba(0,0,0,.12)); }
.seatmap .sm-close { padding: 5px 9px; border-radius: 8px; color: var(--muted, #5b6570); }
.seatmap .sm-close:hover { background: var(--fill, rgba(0,0,0,.06)); }
.seatmap svg { display: block; width: 100%; height: auto; touch-action: manipulation; }
.seatmap .sm-body { fill: var(--surface-strong, #fff); stroke: var(--line, rgba(0,0,0,.18)); }
.seatmap .sm-cabin { fill: var(--fill, rgba(0,0,0,.04)); }
.seatmap .sm-wing { fill: var(--fill-strong, rgba(0,0,0,.10)); stroke: var(--line, rgba(0,0,0,.18)); }
.seatmap .sm-nacelle { fill: var(--fill-strong, rgba(0,0,0,.12)); }
.seatmap .sm-tick { stroke: var(--ink, #1d2329); stroke-width: 3; stroke-linecap: round; }
.seatmap .sm-tick.blank { stroke: var(--faint, #9aa3ab); stroke-width: 5; stroke-linecap: butt; }
.seatmap .sm-row { fill: var(--faint, #9aa3ab); font: 600 7px system-ui, sans-serif; text-anchor: middle; }
.seatmap .sm-seat rect { fill: color-mix(in srgb, var(--blue, #2f6fdb) 30%, transparent); stroke: none; rx: 2px; cursor: pointer; }
.seatmap .sm-seat.window rect { fill: var(--blue, #2f6fdb); }
.seatmap .sm-seat.window.strip rect { fill: var(--accent, #e0862d); }
.seatmap .sm-seat.blank rect { fill: var(--faint, #9aa3ab); }
.seatmap .sm-seat:hover rect, .seatmap .sm-seat:focus rect { stroke: var(--ink, #1d2329); stroke-width: 1.5px; }
.seatmap .sm-seat:focus { outline: none; }
.seatmap .sm-seat[aria-selected="true"] rect { stroke: var(--ink, #1d2329); stroke-width: 2.5px; }
.seatmap .sm-default { fill: none; stroke: var(--ink, #1d2329); stroke-width: 1; stroke-dasharray: 2 1.5; pointer-events: none; }
.seatmap .sm-say { min-height: 1.4em; margin-top: 6px; font-size: 12.5px; color: var(--muted, #5b6570); font-variant-numeric: tabular-nums; }
.seatmap .sm-key { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 11.5px; color: var(--muted, #5b6570); }
.seatmap .sm-key i { display: inline-block; width: 10px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
@media (prefers-reduced-motion: no-preference) { .seatmap .sm-seat rect { transition: fill .12s; } }
`;

function injectStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE;
  doc.head.append(st);
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The SVG for a model: seats as role=gridcell groups in role=row groups (one per row), with a roving tabindex. */
export function seatMapSvg(m) {
  const pad = 4;
  const ticks = m.ticks.map((t) => {
    const dy = t.side === 'right' ? -2.5 : 2.5;
    return t.blank
      ? `<line class="sm-tick blank" x1="${t.x - 4}" y1="${t.y + dy}" x2="${t.x + 4}" y2="${t.y + dy}"><title>${t.side} side, ${t.station.toFixed(2)} m: blank panel</title></line>`
      : `<line class="sm-tick" x1="${t.x - 3}" y1="${t.y + dy}" x2="${t.x + 3}" y2="${t.y + dy}" />`;
  }).join('');
  const byRow = new Map();
  for (const s of m.seats) { if (!byRow.has(s.row)) byRow.set(s.row, []); byRow.get(s.row).push(s); }
  const rows = [...byRow].map(([row, list]) => `<g role="row" aria-label="Row ${row}">${list.map((s) => {
    const cls = ['sm-seat', s.window && 'window', s.strip && 'strip', s.blankWall && 'blank'].filter(Boolean).join(' ');
    const ring = s.isDefault ? `<rect class="sm-default" x="${s.x - 2}" y="${s.y - 2}" width="${s.w + 4}" height="${s.h + 4}" />` : '';
    return `<g class="${cls}" role="gridcell" data-seat="${s.id}" tabindex="${s.current ? 0 : -1}" aria-selected="${s.current}" aria-label="${esc(s.label)}${s.isDefault ? ' (default)' : ''}"><rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" />${ring}</g>`;
  }).join('')}</g>`).join('');
  const labels = m.rows.map((r) => `<text class="sm-row" x="${r.x}" y="${r.yTop}">${r.row}</text>`).join('');
  const n = m.nacelles;
  return `<svg viewBox="${-pad} 0 ${m.width + 2 * pad} ${m.height}" role="grid" aria-label="Seats, nose to the left: right side above, left side below" aria-rowcount="${m.rows.length}">
    <polygon class="sm-wing" points="${m.wing.right}" /><polygon class="sm-wing" points="${m.wing.left}" />
    <rect class="sm-nacelle" x="${n.right.x}" y="${n.right.y}" width="${n.right.w}" height="${n.right.h}" rx="6" />
    <rect class="sm-nacelle" x="${n.left.x}" y="${n.left.y}" width="${n.left.w}" height="${n.left.h}" rx="6" />
    <rect class="sm-body" x="${m.body.x}" y="${m.body.y}" width="${m.body.w}" height="${m.body.h}" rx="8" />
    <rect class="sm-cabin" x="${m.cabin.x}" y="${m.cabin.y}" width="${m.cabin.w}" height="${m.cabin.h}" />
    ${ticks}${labels}${rows}
  </svg>`;
}

/**
 * The seat map as a popover. Choosing a seat (click, tap, Enter or Space, or a shortcut) calls onChoose(id) and
 * resolves a pending choose(); Escape or the close button resolves it with null.
 * @param {{ parent?: HTMLElement, stripSide?: 'left'|'right', current?: string, onChoose?: (id: string) => void,
 *   onClose?: () => void, doc?: Document }} o
 */
export function createSeatMap({ parent, stripSide = 'right', current, onChoose = () => {}, onClose = () => {}, doc = globalThis.document } = {}) {
  injectStyle(doc);
  const el = doc.createElement('div');
  el.id = 'seatmap';
  el.className = 'pop seatmap';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Seat map');
  el.hidden = true;
  (parent || doc.body).append(el);
  let model = seatMapModel({ stripSide, current });
  let focusId = model.currentId;
  let pending = null;

  const render = () => {
    const sideWord = model.stripSide;
    el.innerHTML = `<div class="sm-head"><span class="sm-title">Choose a seat</span>
        <button type="button" class="sm-short" data-go="ahead">Ahead of the wing</button>
        <button type="button" class="sm-short" data-go="over">Over the wing</button>
        <button type="button" class="sm-short" data-go="behind">Behind the wing</button>
        <button type="button" class="sm-close" aria-label="Close">✕</button>
        <span class="sm-strip">The Strip is on the <b>${sideWord}</b> on this flight: its window seats are marked. The default seat, ${model.defaultId}, is ringed.</span></div>
      ${seatMapSvg(model)}
      <div class="sm-say" aria-live="polite"></div>
      <div class="sm-key"><span><i style="background:var(--accent,#e0862d)"></i>window, Strip side</span><span><i style="background:var(--blue,#2f6fdb)"></i>window</span><span><i style="background:var(--faint,#9aa3ab)"></i>blank wall</span><span><i style="background:color-mix(in srgb,var(--blue,#2f6fdb) 30%,transparent)"></i>middle and aisle</span></div>`;
    for (const b of el.querySelectorAll('.sm-short')) {
      const id = model.shortcuts[b.dataset.go];
      b.title = `${id}: ${model.seats.find((s) => s.id === id).label}`;
    }
  };
  const cell = (id) => el.querySelector(`[data-seat="${id}"]`);
  const say = (id) => { const s = model.seats.find((x) => x.id === id); el.querySelector('.sm-say').textContent = s ? s.label : ''; };
  const focusSeat = (id) => {
    const prev = cell(focusId);
    if (prev) prev.setAttribute('tabindex', '-1');
    focusId = id;
    const c = cell(id);
    if (c) { c.setAttribute('tabindex', '0'); c.focus?.(); }
    say(id);
  };
  const finish = (id) => {
    const p = pending;
    pending = null;
    if (p) p(id);
  };
  const choose = (id) => {
    api.setCurrent(id);
    onChoose(id);
    finish(id);
  };

  el.addEventListener('click', (ev) => {
    const t = ev.target;
    const g = t.closest?.('[data-seat]');
    if (g) { choose(g.dataset.seat); return; }
    const short = t.closest?.('[data-go]');
    if (short) { choose(model.shortcuts[short.dataset.go]); return; }
    if (t.closest?.('.sm-close')) api.close();
  });
  el.addEventListener('pointerover', (ev) => { const g = ev.target.closest?.('[data-seat]'); if (g) say(g.dataset.seat); });
  el.addEventListener('focusin', (ev) => { const g = ev.target.closest?.('[data-seat]'); if (g) { focusId = g.dataset.seat; say(focusId); } });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); api.close(); return; }
    const g = ev.target.closest?.('[data-seat]');
    if (!g) return;
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); choose(g.dataset.seat); return; }
    const next = nextSeatId(g.dataset.seat, ev.key);
    if (next) { ev.preventDefault(); ev.stopPropagation(); focusSeat(next); }
  });

  const api = {
    el,
    get open() { return !el.hidden; },
    get model() { return model; },
    /** Show the map with focus on the current seat. */
    show() { render(); el.hidden = false; focusSeat(model.currentId); return api; },
    close() { if (el.hidden) return api; el.hidden = true; onClose(); finish(null); return api; },
    /** Mark a seat as the current one (without choosing it). */
    setCurrent(id) { model = seatMapModel({ stripSide: model.stripSide, current: id }); focusId = model.currentId; if (!el.hidden) { render(); focusSeat(focusId); } return api; },
    /** The side the Strip is on for the flight now chosen. */
    setStripSide(side) { model = seatMapModel({ stripSide: side, current: model.currentId }); if (!el.hidden) { render(); focusSeat(focusId); } return api; },
    /** Open the map and resolve with the chosen seat id, or null if it is closed without a choice. */
    choose() { finish(null); return new Promise((resolve) => { pending = resolve; api.show(); }); },
    dispose() { finish(null); el.remove(); },
  };
  return api;
}

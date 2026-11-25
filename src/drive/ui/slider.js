// The route bar's track: the whole route as a rail with a tick for every exit and named place, a mark
// for the reveal, and a thumb that moves the car. The thumb is the slider (role="slider"); the rail
// around it takes presses and drags. One floating label names the tick under the pointer, the tick
// nearest the thumb while it is dragged or focused, so bunched exits in the city never overlap.

import { layoutTicks, tickAtPixel, nearestTick, placeText } from './track.js';

/** Thumb keys, metres: arrows, Shift+arrows, Page Up/Down. */
const STEP = 1000, BIG = 5000;
/** Pixels a press may wander and still count as a tap (which snaps to a tick under it). */
const TAP_PX = 4;

/**
 * @param {{ units: () => 'ft'|'m', onSeek: (s: number, done: boolean) => void }} opts
 *   onSeek runs while the thumb is dragged (done false) and once when it is let go or a key moves it (done true)
 */
export function createTrack({ units, onSeek }) {
  const el = document.createElement('div');
  el.className = 'track';
  el.innerHTML = '<div class="rail"><div class="done"></div></div><div class="ticks" aria-hidden="true"></div>'
    + '<div class="thumb" role="slider" tabindex="0" aria-label="Place on the route" aria-valuemin="0"></div>'
    + '<div class="ticktip" aria-hidden="true" hidden></div>';
  const done = el.querySelector('.done'), tickBox = el.querySelector('.ticks');
  const thumb = el.querySelector('.thumb'), tip = el.querySelector('.ticktip');
  let route = null, ticks = [], s = 0, drag = null, hoverTick = null, focused = false;
  const shown = { at: null, text: null };

  const span = () => Math.max(1, route.s1 - route.s0);
  const sAtX = (clientX) => {
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    return route.s0 + f * span();
  };

  function setRoute(r) {
    route = r;
    ticks = layoutTicks(r);
    tickBox.replaceChildren(...ticks.map((t) => {
      const i = document.createElement('i');
      i.className = t.kind;
      i.style.left = `${(t.at * 100).toFixed(3)}%`;
      return i;
    }));
    thumb.setAttribute('aria-valuemin', String(Math.round(r.s0)));
    thumb.setAttribute('aria-valuemax', String(Math.round(r.s1)));
    shown.at = shown.text = null;
    place(s, true);
  }

  /** The label over one tick, or hidden. */
  function showTip(t) {
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.label;
    tip.hidden = false;
    // keep the label inside the track's box: pinned to an end near the ends, centred elsewhere
    const w = el.clientWidth, x = t.at * w, half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(x, half), Math.max(half, w - half))}px`;
  }
  function refreshTip() {
    if (!route) return;
    if (drag?.moved || focused) {
      const w = el.clientWidth;
      const near = drag ? tickAtPixel(ticks, ((s - route.s0) / span()) * w, w, 14) : nearestTick(ticks, s);
      showTip(near);
    } else showTip(hoverTick);
  }

  /** Move the thumb to s; writes the DOM only when what it shows changed. */
  function place(next, force = false) {
    s = next;
    if (!route) return;
    const at = Math.round(((s - route.s0) / span()) * 10000) / 100;
    if (force || at !== shown.at) {
      shown.at = at;
      thumb.style.left = `${at}%`;
      done.style.width = `${at}%`;
    }
    const text = placeText({ s, s0: route.s0, s1: route.s1, ticks, units: units() });
    if (force || text !== shown.text) {
      shown.text = text;
      thumb.setAttribute('aria-valuenow', String(Math.round(s)));
      thumb.setAttribute('aria-valuetext', text);
    }
    if (drag || focused) refreshTip();
  }

  el.addEventListener('pointerdown', (ev) => {
    if (!route || ev.button !== 0) return;
    ev.preventDefault();
    // no focus moves to the thumb: after a drag, Space and the arrows still work the transport
    el.setPointerCapture?.(ev.pointerId);
    drag = { id: ev.pointerId, x: ev.clientX, moved: false, touch: ev.pointerType !== 'mouse' };
    el.classList.add('dragging');
    const target = sAtX(ev.clientX);
    place(target);
    onSeek(target, false);
  });
  el.addEventListener('pointermove', (ev) => {
    if (!route) return;
    if (drag && drag.id === ev.pointerId) {
      if (Math.abs(ev.clientX - drag.x) > TAP_PX) drag.moved = true;
      const target = sAtX(ev.clientX);
      place(target);
      onSeek(target, false);
      return;
    }
    if (ev.pointerType === 'mouse') {
      const r = el.getBoundingClientRect();
      hoverTick = tickAtPixel(ticks, ev.clientX - r.left, r.width);
      refreshTip();
    }
  });
  const end = (ev) => {
    if (!drag || drag.id !== ev.pointerId) return;
    let target = sAtX(ev.clientX);
    if (!drag.moved) {
      // a tap on a tick goes to that exit, not a few hundred metres either side of it
      const r = el.getBoundingClientRect();
      const t = tickAtPixel(ticks, ev.clientX - r.left, r.width, drag.touch ? 14 : 6);
      if (t) target = t.s;
    }
    const wasTouch = drag.touch;
    drag = null;
    el.classList.remove('dragging');
    place(target);
    onSeek(target, true);
    if (wasTouch) {
      // touch has no hover: the tapped point's name stays a moment
      showTip(nearestTick(ticks, target));
      clearTimeout(end.timer);
      end.timer = setTimeout(() => { if (!drag && !focused) showTip(null); }, 1600);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { hoverTick = null; if (!drag) refreshTip(); });

  thumb.addEventListener('focus', () => { focused = true; refreshTip(); });
  thumb.addEventListener('blur', () => { focused = false; showTip(null); });
  thumb.addEventListener('keydown', (ev) => {
    if (!route) return;
    const k = ev.key;
    const step = ev.shiftKey ? BIG : STEP;
    const moves = {
      ArrowRight: s + step, ArrowUp: s + step, ArrowLeft: s - step, ArrowDown: s - step,
      PageUp: s + BIG, PageDown: s - BIG, Home: route.s0, End: route.s1,
    };
    if (!(k in moves)) return;
    ev.preventDefault();
    const target = Math.min(route.s1, Math.max(route.s0, moves[k]));
    focused = true;
    place(target);
    onSeek(target, true);
  });

  return {
    el,
    setRoute,
    /** The car's place, from the session; ignored while the visitor drags the thumb. */
    update(next) { if (!drag) place(next); },
    get dragging() { return !!drag; },
    /** Units changed: rewrite the readable value. */
    refresh() { if (route) place(s, true); },
  };
}

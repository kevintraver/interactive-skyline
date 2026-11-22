// The time-of-day popover, opened from the route bar's clock: a 24-hour slider for the city's local
// time and three jumps (Dusk, Noon, Night). The jumps always keep the car where it is; the slider
// obeys the hold-position lock. Opens and closes like the app's other popovers: from its button,
// on Escape and on a press outside, with aria-expanded on the button.

import { formatMinutes, localParts } from './format.js';

/**
 * @param {{ button: HTMLButtonElement, tz: string, onTime: (minutes: number, done: boolean) => void,
 *           onJump: (which: 'dusk'|'noon'|'night') => void, state: () => { simMs: number, locked: boolean } }} opts
 *   onTime runs while the slider moves (done false) and when it is let go (done true)
 */
export function createTimePop({ button, tz, onTime, onJump, state }) {
  const el = document.createElement('div');
  el.id = 'drive-time';
  el.className = 'pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Time of day');
  el.hidden = true;
  el.innerHTML = `<label class="field">
      <span class="row"><span>Time of day</span><output></output></span>
      <input type="range" min="0" max="1439" step="1" aria-label="Local time of day" />
    </label>
    <div class="jumps" role="group" aria-label="Jump to">
      <button type="button" data-jump="dusk" title="The default moment for this place">Dusk</button>
      <button type="button" data-jump="noon">Noon</button>
      <button type="button" data-jump="night" title="3 a.m.">Night</button>
    </div>
    <p class="note"></p>`;
  document.body.append(el);
  const range = el.querySelector('input'), out = el.querySelector('output'), note = el.querySelector('.note');
  let sliding = false, lastLocked = null;

  function place() {
    // above its button, inside the window
    const r = button.getBoundingClientRect();
    const w = el.offsetWidth, gap = 8;
    el.style.left = `${Math.round(Math.min(Math.max(gap, r.left + r.width / 2 - w / 2), innerWidth - w - gap))}px`;
    el.style.bottom = `${Math.round(innerHeight - r.top + gap)}px`;
  }
  function open(on) {
    el.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (on) { api.update(state()); place(); }
  }

  button.addEventListener('click', () => open(el.hidden));
  range.addEventListener('pointerdown', () => { sliding = true; });
  range.addEventListener('pointerup', () => { sliding = false; });
  range.addEventListener('input', () => {
    out.textContent = formatMinutes(+range.value);
    onTime(+range.value, false);
  });
  range.addEventListener('change', () => { sliding = false; onTime(+range.value, true); });
  el.querySelector('.jumps').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) onJump(b.dataset.jump);
  });
  // a press outside closes it; caught on the way down, as main.js does for its own popovers
  addEventListener('pointerdown', (ev) => {
    if (!el.hidden && !el.contains(ev.target) && !button.contains(ev.target)) open(false);
  }, true);
  // Escape closes it, and goes no further: main.js would clear the selected building on the same key
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || el.hidden) return;
    ev.stopPropagation();
    open(false);
    button.focus();
  }, true);
  addEventListener('resize', () => { if (!el.hidden) place(); });

  const api = {
    el,
    open,
    get isOpen() { return !el.hidden; },
    /** Follow the clock while open; the slider is left alone while the visitor holds it. */
    update({ simMs, locked }) {
      if (el.hidden) return;
      if (!sliding) {
        const m = Math.floor(localParts(simMs, tz).minutes);
        if (+range.value !== m) range.value = String(m);
        out.textContent = formatMinutes(m);
      }
      if (locked !== lastLocked) {
        lastLocked = locked;
        note.textContent = locked ? 'Holding position: the car stays here as the time changes.' : 'The car drives on as the time changes. Hold position to stay here.';
      }
    },
  };
  return api;
}

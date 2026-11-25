// The window panel (plan 03, F5.7): a small popover above the flight's bar with a switch for each of the glass's
// effects and the focus pull (key F). Native checkboxes in labels, so it is used with Tab, Space and Escape like any
// form; Escape closes it and gives focus back to the bar's Window button.
//
// Two halves: the pure model (WINDOW_SWITCHES, paneSettings: what each switch does to the pane, unit tested without
// a DOM) and createWindowPanel, which draws it into a `.pop` and reports changes through onChange.

/** The switches, in order: id, label, and the pane's effects each one drives (window/index.js setEffects). */
export const WINDOW_SWITCHES = Object.freeze([
  { id: 'glass', label: 'Glass', title: 'The window\'s panes; off shows the view with no glass at all' },
  { id: 'frost', label: 'Frost and mist', effects: ['frost', 'condensation'], title: 'Ice and condensation between the panes' },
  { id: 'rain', label: 'Rain', effects: ['droplets'], title: 'Drops and streaks on the outer pane' },
  { id: 'scratches', label: 'Scratches', effects: ['scratches'], title: 'Fine scratches and dirt that catch the Sun and bright lights' },
  { id: 'reflections', label: 'Reflections', effects: ['reflections'], title: 'The lit cabin mirrored in the glass' },
]);

/** Every switch on, focused far: the default. */
export const WINDOW_DEFAULTS = Object.freeze({ glass: true, frost: true, rain: true, scratches: true, reflections: true, focus: 'far' });

/**
 * What the pane is told for a panel state: { enabled, effects, focus }. Pure.
 * @param {{ glass?: boolean, frost?: boolean, rain?: boolean, scratches?: boolean, reflections?: boolean, focus?: 'far'|'pane' }} s
 */
export function paneSettings(s) {
  const v = { ...WINDOW_DEFAULTS, ...(s || {}) };
  const effects = {};
  for (const sw of WINDOW_SWITCHES) for (const e of sw.effects || []) effects[e] = !!v[sw.id];
  return { enabled: !!v.glass, effects, focus: v.focus === 'pane' ? 'pane' : 'far' };
}

/**
 * @param {{ parent: HTMLElement, state: object, onChange: (state: object) => void, onClose?: () => void }} o
 */
export function createWindowPanel({ parent, state = WINDOW_DEFAULTS, onChange, onClose = () => {} }) {
  let current = { ...WINDOW_DEFAULTS, ...state };
  const el = document.createElement('div');
  el.id = 'flightwindow';
  el.className = 'pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Window');
  el.hidden = true;
  el.innerHTML = `<div class="fw-head"><b>Window</b><button type="button" class="fw-close" aria-label="Close">✕</button></div>
    <div class="fw-list">${WINDOW_SWITCHES.map((s) => `<label title="${s.title}"><input type="checkbox" data-switch="${s.id}"> ${s.label}</label>`).join('')}</div>
    <label class="fw-focus" title="Pull focus to the glass: scratches sharp, the view soft (F)"><input type="checkbox" data-switch="focus"> Focus on the glass <kbd>F</kbd></label>`;
  parent.append(el);
  const boxes = [...el.querySelectorAll('input[data-switch]')];
  const paint = () => {
    for (const b of boxes) {
      const id = b.dataset.switch;
      b.checked = id === 'focus' ? current.focus === 'pane' : !!current[id];
      // the effects mean nothing without the glass
      b.disabled = id !== 'glass' && !current.glass;
    }
  };
  paint();
  el.addEventListener('change', (ev) => {
    const b = ev.target.closest?.('input[data-switch]');
    if (!b) return;
    const id = b.dataset.switch;
    current = { ...current, [id]: id === 'focus' ? (b.checked ? 'pane' : 'far') : b.checked };
    paint();
    onChange({ ...current });
  });
  el.addEventListener('click', (ev) => { if (ev.target.closest?.('.fw-close')) api.close(); });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); api.close(); }
  });

  const api = {
    el,
    get open() { return !el.hidden; },
    get state() { return { ...current }; },
    /** Another state from outside (key F, the hook): the boxes follow, onChange is not called. */
    set(next) { current = { ...current, ...next }; paint(); return api; },
    show() { paint(); el.hidden = false; boxes[0]?.focus(); return api; },
    close() { if (el.hidden) return api; el.hidden = true; onClose(); return api; },
    dispose() { el.remove(); },
  };
  return api;
}

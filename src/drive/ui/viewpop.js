// The view popover, opened from the route bar's car button: Cabin or Clean, the mirror glances (for touch
// and mouse; the keyboard has 1-4), and the drive's own Reduce motion. Opens and closes like the time
// popover: from its button, on Escape and on a press outside, with aria-expanded on the button.

/**
 * @param {{ button: HTMLButtonElement, onView: (view: 'cabin'|'clean') => void, onGlance: (name: string) => void,
 *           onReduceMotion: (on: boolean) => void, state: () => { view: string, reduceMotion: boolean } }} opts
 */
export function createViewPop({ button, onView, onGlance, onReduceMotion, state }) {
  const el = document.createElement('div');
  el.id = 'drive-view';
  el.className = 'pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'View');
  el.hidden = true;
  el.innerHTML = `<div class="seg" role="radiogroup" aria-label="View">
      <label title="The car around you (C)"><input type="radio" name="drive-view" value="cabin" /><span>Cabin</span></label>
      <label title="No car: the eye 1.2 m above the road (C)"><input type="radio" name="drive-view" value="clean" /><span>Clean</span></label>
    </div>
    <p class="note view-note"></p>
    <div class="glances" role="group" aria-label="Glance at">
      <button type="button" data-glance="left" title="Left mirror (2)">Left mirror</button>
      <button type="button" data-glance="center" title="Rear-view mirror (4)">Rear-view</button>
      <button type="button" data-glance="right" title="Right mirror (3)">Right mirror</button>
    </div>
    <label class="check"><input type="checkbox" name="reduce-motion" /><span>Reduce motion</span></label>
    <p class="note">C switches the view. 1 looks ahead, 2 3 4 glance at the mirrors. Double-click or R looks ahead again.</p>`;
  document.body.append(el);
  const radios = [...el.querySelectorAll('input[name="drive-view"]')];
  const reduce = el.querySelector('input[name="reduce-motion"]');
  const viewNote = el.querySelector('.view-note');

  function place() {
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
  for (const r of radios) r.addEventListener('change', () => { if (r.checked) onView(r.value); });
  reduce.addEventListener('change', () => onReduceMotion(reduce.checked));
  el.querySelector('.glances').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) onGlance(b.dataset.glance);
  });
  addEventListener('pointerdown', (ev) => {
    if (!el.hidden && !el.contains(ev.target) && !button.contains(ev.target)) open(false);
  }, true);
  addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || el.hidden) return;
    ev.stopPropagation();
    open(false);
    button.focus();
  }, true);
  addEventListener('resize', () => { if (!el.hidden) place(); });

  const shown = { view: null, reduce: null };
  const api = {
    el,
    open,
    get isOpen() { return !el.hidden; },
    update({ view, reduceMotion }) {
      if (view !== shown.view) {
        shown.view = view;
        for (const r of radios) r.checked = r.value === view;
        el.querySelector('.glances').hidden = view !== 'cabin';
        viewNote.textContent = view === 'cabin'
          ? 'From the driver’s seat, 28 mm lens.'
          : 'No car: the eye 1.2 m above the road, 50 mm lens, for the skyline at true scale.';
      }
      if (reduceMotion !== shown.reduce) { shown.reduce = reduceMotion; reduce.checked = reduceMotion; }
    },
  };
  return api;
}

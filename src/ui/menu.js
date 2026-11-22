// The right-click menu on a building.
import { isHidden, isMoved } from '../interaction/edits.js';

export function initMenu(app) {
  const { tall, controls, format: { label, details } } = app;
  const menu = document.getElementById('menu');
  const tip = document.getElementById('tip');
  const visibleTaller = (e) => tall.filter((t) => !isHidden(t) && t.data.h > e.data.h);

  function openMenu(entry, x, y) {
    const { apply, moveBack, select, focusOn, showToast } = app;
    const b = entry.data, hidden = isHidden(entry);
    const items = [];
    if (hidden) {
      items.push(['Show', () => apply([entry], false)]);
      const n = tall.filter(isHidden).length;
      if (n > 1) items.push([`Show all ${n} hidden`, () => apply(tall, false)]);
    } else {
      items.push(['Hide', () => apply([entry], true)]);
      const taller = visibleTaller(entry);
      if (taller.length) items.push([`Hide this and ${taller.length} taller`, () => apply([entry, ...taller], true)]);
      if (entry !== app.selected) items.push(['Move', () => { select(entry); showToast('Drag the orange building to move it.', false); }]);
    }
    if (isMoved(entry)) items.push(['Put back', () => moveBack([entry])]);
    items.push(['Zoom to', () => { focusOn(entry); select(entry); }]);
    menu.replaceChildren();
    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = '<b></b><span></span>';
    head.querySelector('b').textContent = label(b);
    head.querySelector('span').textContent = hidden ? `${details(b)} · hidden` : details(b);
    menu.append(head);
    for (const [text, run] of items) {
      const btn = document.createElement('button');
      btn.setAttribute('role', 'menuitem');
      btn.textContent = text;
      btn.addEventListener('click', () => { closeMenu(); run(); });
      menu.append(btn);
    }
    menu.hidden = false;
    tip.hidden = true;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    menu.querySelector('button').focus();
  }
  function closeMenu() { menu.hidden = true; }
  controls.addEventListener('start', closeMenu);
  Object.assign(app, { openMenu, closeMenu });
}

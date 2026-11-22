// The list of removable buildings behind the search box: open while the search box is in use, giving way to the
// map once a building is chosen.
import { isHidden, isMoved } from '../interaction/edits.js';

export function initList(app) {
  const { tall, settings, format: { SOURCE, fmt, label, details } } = app;
  const list = document.getElementById('list');
  const results = document.getElementById('results');
  const search = document.getElementById('search');
  const empty = document.getElementById('empty');

  function syncRow(e) {
    const hidden = isHidden(e);
    e.row.classList.toggle('off', hidden);
    const act = e.row.querySelector('.act');
    act.querySelector('use').setAttribute('href', hidden ? '#i-eye-off' : '#i-eye');
    act.title = hidden ? 'Show' : 'Hide';
    act.setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} ${label(e.data)}`);
    e.row.querySelector('.back').hidden = !isMoved(e);
  }

  function buildList() {
    list.replaceChildren();
    tall.forEach((entry, i) => {
      const b = entry.data;
      const li = document.createElement('li');
      const est = b.src === 'osm-levels' || b.src === 'guess';
      li.innerHTML = `<button class="go"><span class="rank">${i + 1}</span><span class="name"></span><span class="ht">${est ? '~' : ''}${fmt(b.h)}</span></button><button class="back" hidden>Put back</button><button class="act"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><use /></svg></button>`;
      li.querySelector('.name').textContent = label(b);
      const go = li.querySelector('.go');
      go.title = `${label(b)}: ${details(b)}. Height ${SOURCE[b.src]}.`;
      go.addEventListener('click', () => goTo(entry));
      li.querySelector('.act').addEventListener('click', () => app.apply([entry], !isHidden(entry)));
      li.querySelector('.back').addEventListener('click', () => app.moveBack([entry]));
      li.addEventListener('pointerenter', () => app.setHover(entry));
      li.addEventListener('pointerleave', () => app.setHover(null));
      entry.row = li;
      list.append(li);
      syncRow(entry);
    });
    filterList();
  }
  function matches() {
    const q = search.value.trim().toLowerCase();
    return tall.filter((e) => !q || label(e.data).toLowerCase().includes(q));
  }
  function filterList() {
    const shown = new Set(matches());
    for (const e of tall) e.row.hidden = !shown.has(e);
    empty.hidden = shown.size > 0;
    empty.textContent = `No building over ${fmt(settings.cutoff)} is called "${search.value.trim()}".`;
  }
  /** The list is open while the search box is in use, and gives way to the map once a building is chosen. */
  function browse(open) {
    results.hidden = !open;
    document.body.classList.toggle('browsing', open);
  }
  function goTo(entry) {
    browse(false);
    search.value = '';
    filterList();
    search.blur();
    app.focusOn(entry);
    app.select(entry);
  }
  search.addEventListener('focus', () => browse(true));
  search.addEventListener('input', () => { browse(true); filterList(); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { const first = matches()[0]; if (first) goTo(first); }
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      if (search.value) { search.value = ''; filterList(); } else { browse(false); search.blur(); }
    }
  });
  Object.assign(app, { syncRow, buildList, browse });
}

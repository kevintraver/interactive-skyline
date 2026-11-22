// The card for the selected building: name, height and source, and its actions.
import { isMoved } from '../interaction/edits.js';

export function initCard(app) {
  const { tall, city, format: { SOURCE, label, details } } = app;
  const card = document.getElementById('card');

  function updateCard() {
    const { selected } = app;
    if (!selected) return;
    const b = selected.data, rank = tall.indexOf(selected) + 1;
    card.querySelector('h2').textContent = label(b);
    card.querySelector('.meta').textContent = `${details(b)} · ${rank === 1 ? `tallest in ${city.name}` : `no. ${rank} by height`}`;
    card.querySelector('.src').textContent = `Height ${SOURCE[b.src]}`;
    card.querySelector('.how').textContent = isMoved(selected) ? 'Moved from where it really stands.' : 'Drag the building to move it.';
    card.querySelector('[data-act="back"]').hidden = !isMoved(selected);
  }

  card.querySelector('[data-act="hide"]').addEventListener('click', () => app.selected && app.apply([app.selected], true));
  card.querySelector('[data-act="center"]').addEventListener('click', () => app.selected && app.focusOn(app.selected));
  card.querySelector('[data-act="back"]').addEventListener('click', () => app.selected && app.moveBack([app.selected]));
  card.querySelector('.x').addEventListener('click', () => app.select(null));
  app.updateCard = updateCard;
}

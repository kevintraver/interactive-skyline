import { isHidden } from './edits.js';

// The building under the pointer (hovered) and the one chosen (selected, shown on the card and draggable).
export function initSelection(app) {
  const { canvas, invalidate } = app;
  const card = document.getElementById('card');
  app.hovered = null;
  app.selected = null;

  function setHover(entry) {
    if (app.hovered === entry) return;
    const prev = app.hovered;
    app.hovered = entry;
    if (prev) { app.paint(prev); prev.row.classList.remove('hover'); }
    if (entry) { app.paint(entry); entry.row.classList.add('hover'); }
    canvas.classList.toggle('hot', !!entry);
    invalidate();
  }

  function select(entry) {
    const prev = app.selected;
    app.selected = entry && !isHidden(entry) ? entry : null;
    const { selected } = app;
    if (prev) { app.paint(prev); prev.row.classList.remove('selected'); }
    card.hidden = !selected;
    document.body.classList.toggle('selecting', !!selected);
    if (selected) {
      app.paint(selected);
      selected.row.classList.add('selected');
      selected.row.scrollIntoView({ block: 'nearest' });
      app.hideToast();
      app.dismissHint();
      app.updateCard();
    }
    invalidate();
  }
  Object.assign(app, { setHover, select });
}

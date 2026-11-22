// Transient messages in the dock: the undo toast, and the first-visit hint.
const HINTED = 'slc-skyline-hinted';

export function initToast(app) {
  const toast = document.getElementById('toast');
  const hint = document.getElementById('hint');
  let toastTimer = 0;
  function showToast(text, undoable) {
    toast.querySelector('span').textContent = text;
    toast.querySelector('button').hidden = !undoable;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }
  function hideToast() { toast.hidden = true; clearTimeout(toastTimer); }
  toast.querySelector('button').addEventListener('click', () => app.undo());

  // the hint stays until the visitor has selected a building once, on any visit
  function dismissHint() {
    if (hint.hidden) return;
    hint.hidden = true;
    try { localStorage.setItem(HINTED, '1'); } catch { /* private window: the hint returns next visit */ }
  }
  Object.assign(app, { showToast, hideToast, dismissHint });
}

/** Show the hint unless this visitor has already used the app. Called once the rest of the interface is set up. */
export function initHint(app) {
  const hint = document.getElementById('hint');
  hint.querySelector('.x').addEventListener('click', app.dismissHint);
  try { hint.hidden = !!localStorage.getItem(HINTED); } catch { hint.hidden = false; }
}

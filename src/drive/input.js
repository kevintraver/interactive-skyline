// Looking around while driving. The map's own pointer handlers stay in charge of buildings (hover,
// click to select, drag a selected one to move it); these listeners only turn the head, zoom the lens,
// switch the view, glance and run the transport keys, and only while Drive is active. Registered after
// main.js's, so they run after its handlers on the same element and can see a building drag it has
// claimed (canvas.grabbing).
//
// The inputs of plan 02, section 4.4, by device:
//   look        drag (mouse or one finger); W A S D (5 degrees a press)
//   zoom        wheel, pinch, the zoom buttons; + and -
//   look ahead  double-click, double-tap, R, the compass button
//   glances     1 ahead, 2 left mirror, 3 right mirror, 4 rear-view mirror (held: stays); the view popover's buttons
//   view        C; the view popover
//   transport   Space, the arrow keys, comma and full stop (and the route bar)

const DRAG_PX = 5; // main.js's rule for telling a drag from a click
/** Two taps this close in time (ms) and place (px) are a double-tap. */
const DOUBLE_TAP_MS = 320, DOUBLE_TAP_PX = 30;
/** Degrees a look key turns the head. */
const LOOK_STEP = 5;
/** The glance keys. */
export const GLANCE_KEYS = { 1: 'ahead', 2: 'left', 3: 'right', 4: 'center' };

/** Keys never act while focus is in a text field, a select or a slider: those keys are theirs. */
export function ownsKeys(el) {
  if (!el || !(el instanceof Element)) return false;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    || el.isContentEditable || el.getAttribute('role') === 'slider';
}

/** Quiet time after the last wheel step before a zoom counts as finished, ms. */
const WHEEL_DONE_MS = 400;

/**
 * @param {{ canvas: HTMLCanvasElement, controls: object, active: () => boolean, session: () => object|null,
 *           invalidate: () => void, onToggle: () => void, tools: HTMLElement, onLook?: () => void,
 *           onSeekBy?: (seconds: number) => void, onRate?: (dir: 1|-1) => void, onView?: () => void }} opts
 *   onLook runs when a look or zoom gesture finishes (the address is written then); onSeekBy and onRate
 *   carry the transport keys to the controller, which applies the hold-position lock and the address;
 *   onView switches between cabin and clean
 */
export function attachInput({ canvas, controls, active, session, invalidate, onToggle, tools, onLook = () => {}, onSeekBy, onRate, onView }) {
  const pointers = new Map(); // pointerId -> { x, y }
  let look = null; // a look-drag: { id, x, y, moved }
  let pinch = null; // { dist, lens }
  let dragPaused = false;
  let lastTap = null; // { t, x, y } of the last short touch tap
  const s = () => (active() ? session() : null);

  // degrees per pixel, so the scene stays under the pointer while the head turns
  const degPerPx = (sn) => {
    const hfov = (2 * Math.atan(18 / sn.rig.lens) * 180) / Math.PI;
    return hfov / Math.max(1, canvas.clientWidth);
  };

  canvas.addEventListener('pointerdown', (ev) => {
    const sn = s();
    if (!sn) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    // a building drag (main.js just claimed it): hold the clock still for its length
    if (canvas.classList.contains('grabbing')) {
      if (sn.clock.playing) { sn.clock.pause(); dragPaused = true; }
      return;
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), lens: sn.rig.lens };
      look = null;
      return;
    }
    if (ev.button === 0 && !ev.ctrlKey && !ev.metaKey) look = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
  }, true);

  canvas.addEventListener('pointermove', (ev) => {
    const sn = s();
    if (!sn || !pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (canvas.classList.contains('grabbing')) return;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      sn.rig.look({ lens: pinch.lens * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.dist)) });
      invalidate();
      return;
    }
    if (!look || look.id !== ev.pointerId) return;
    const dx = ev.clientX - look.x, dy = ev.clientY - look.y;
    if (!look.moved && Math.hypot(dx, dy) <= DRAG_PX) return;
    if (!look.moved) { try { canvas.setPointerCapture?.(ev.pointerId); } catch { /* a pointer the browser does not track */ } }
    look.moved = true;
    const k = degPerPx(sn);
    sn.rig.lookBy(dx * k, dy * k); // grab the scene: drag right and it follows the pointer, the head turns left
    look.x = ev.clientX; look.y = ev.clientY;
    invalidate();
  });

  const release = (ev) => {
    // a short touch tap that did not turn the head: a second one soon after, close by, looks ahead
    if (ev.type === 'pointerup' && ev.pointerType === 'touch' && look && look.id === ev.pointerId && !look.moved && pointers.size === 1 && active()) {
      const now = ev.timeStamp || performance.now();
      if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < DOUBLE_TAP_PX) {
        lastTap = null;
        session()?.rig.reset();
        invalidate();
        onLook();
      } else lastTap = { t: now, x: ev.clientX, y: ev.clientY };
    }
    pointers.delete(ev.pointerId);
    if (pinch && pointers.size < 2) { pinch = null; if (active()) onLook(); }
    if (look && look.id === ev.pointerId) { if (look.moved && active()) onLook(); look = null; }
    if (!active()) return;
    // main.js turns the map controls back on after a building drag; the drive keeps them off
    controls.enabled = false;
    if (dragPaused && !canvas.classList.contains('grabbing')) { dragPaused = false; session()?.clock.play(); }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('wheel', (ev) => {
    const sn = s();
    if (!sn) return;
    ev.preventDefault();
    sn.rig.zoomBy(Math.exp(-ev.deltaY * 0.0015));
    invalidate();
    clearTimeout(wheelDone);
    wheelDone = setTimeout(() => { if (active()) onLook(); }, WHEEL_DONE_MS);
  }, { passive: false });
  let wheelDone = 0;

  canvas.addEventListener('dblclick', (ev) => {
    const sn = s();
    if (!sn || ev.pointerType === 'touch') return; // touch has its own double-tap above
    sn.rig.reset();
    invalidate();
    onLook();
  });

  addEventListener('keydown', (ev) => {
    const sn = s();
    if (!sn || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ownsKeys(ev.target)) return;
    if (ev.key === ' ') { ev.preventDefault(); if (!ev.repeat) onToggle(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const step = (ev.shiftKey ? 60 : 10) * (ev.key === 'ArrowLeft' ? -1 : 1);
      if (onSeekBy) onSeekBy(step); else sn.seekBy(step);
    } else if (ev.key === ',' || ev.key === '<') onRate?.(-1);
    else if (ev.key === '.' || ev.key === '>') onRate?.(1);
    else if (ev.key === 'r' || ev.key === 'R') { sn.rig.reset(); invalidate(); onLook(); }
    else if (ev.key === 'c' || ev.key === 'C') { if (!ev.repeat) onView?.(); }
    else if (GLANCE_KEYS[ev.key]) { sn.rig.glance(GLANCE_KEYS[ev.key], { hold: ev.repeat }); invalidate(); }
    else if ('wasdWASD'.includes(ev.key) && ev.key.length === 1) {
      const k = ev.key.toLowerCase();
      sn.rig.lookBy(k === 'a' ? LOOK_STEP : k === 'd' ? -LOOK_STEP : 0, k === 'w' ? LOOK_STEP : k === 's' ? -LOOK_STEP : 0);
      invalidate();
      onLook();
    } else if (ev.key === '+' || ev.key === '=') { sn.rig.zoomBy(1.25); invalidate(); onLook(); }
    else if (ev.key === '-' || ev.key === '_') { sn.rig.zoomBy(1 / 1.25); invalidate(); onLook(); }
  });
  // a focused button would also take Space as a click on its release
  addEventListener('keyup', (ev) => { if (s() && ev.key === ' ' && !ownsKeys(ev.target)) ev.preventDefault(); });

  // The map's compass and zoom buttons fly the orbit camera; while driving they look ahead and change the
  // lens instead. Caught on the way down, before the buttons' own listeners.
  tools.addEventListener('click', (ev) => {
    const sn = s();
    const btn = sn && ev.target.closest('button');
    if (!btn) return;
    const act = { compass: () => sn.rig.reset(), 'zoom-in': () => sn.rig.zoomBy(1.5), 'zoom-out': () => sn.rig.zoomBy(1 / 1.5) }[btn.id];
    if (!act) return;
    ev.stopPropagation();
    act();
    invalidate();
    onLook();
  }, true);
}

// Looking around while driving. The map's own pointer handlers stay in charge of buildings (hover,
// click to select, drag a selected one to move it); these listeners only turn the head, zoom the lens
// and run the transport keys, and only while Drive is active. Registered after main.js's, so they run
// after its handlers on the same element and can see a building drag it has claimed (canvas.grabbing).

const DRAG_PX = 5; // main.js's rule for telling a drag from a click

/**
 * @param {{ canvas: HTMLCanvasElement, controls: object, active: () => boolean, session: () => object|null,
 *           invalidate: () => void, onToggle: () => void, tools: HTMLElement }} opts
 */
export function attachInput({ canvas, controls, active, session, invalidate, onToggle, tools }) {
  const pointers = new Map(); // pointerId -> { x, y }
  let look = null; // a look-drag: { id, x, y, moved }
  let pinch = null; // { dist, lens }
  let dragPaused = false;
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
    if (!look.moved) canvas.setPointerCapture?.(ev.pointerId);
    look.moved = true;
    const k = degPerPx(sn);
    sn.rig.lookBy(dx * k, dy * k); // grab the scene: drag right and it follows the pointer, the head turns left
    look.x = ev.clientX; look.y = ev.clientY;
    invalidate();
  });

  const release = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (look && look.id === ev.pointerId) look = null;
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
  }, { passive: false });

  canvas.addEventListener('dblclick', () => {
    const sn = s();
    if (!sn) return;
    sn.rig.reset();
    invalidate();
  });

  addEventListener('keydown', (ev) => {
    const sn = s();
    if (!sn || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
    if (ev.key === ' ') { ev.preventDefault(); if (!ev.repeat) onToggle(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); sn.seekBy(ev.key === 'ArrowLeft' ? -10 : 10); }
    else if (ev.key === 'r' || ev.key === 'R') { sn.rig.reset(); invalidate(); }
  });
  // a focused button would also take Space as a click on its release
  addEventListener('keyup', (ev) => { if (s() && ev.key === ' ' && !(ev.target instanceof HTMLInputElement)) ev.preventDefault(); });

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
  }, true);
}

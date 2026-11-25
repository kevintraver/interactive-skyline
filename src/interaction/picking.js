// Pointer input on the canvas: hover labels, clicks, the context menu, and dragging the selected tower.
import * as THREE from 'three';
import { isHidden } from './edits.js';

export function initPicking(app) {
  const { canvas, camera, controls, renderer, tall, invalidate, format: { label, details } } = app;
  const menu = document.getElementById('menu');
  const tip = document.getElementById('tip');
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const ndc = new THREE.Vector2();

  /**
   * What is under the pointer: a standing tower, or the ground footprint of one that is hidden or moved away.
   * Returns { entry, onMarker, point } or null.
   */
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const targets = [];
    for (const t of tall) {
      if (!isHidden(t)) targets.push(t.mesh);
      if (t.marker.visible) targets.push(t.marker);
    }
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    // a low building in front blocks the click, as it blocks the view
    const low = app.buildings.low;
    const blocker = low.geometry.boundsTree && ray.intersectObject(low, false)[0];
    if (blocker && blocker.distance < hit.distance) return null;
    if (app.fly.active && app.fly.blocked(ray.ray, hit.distance)) return null; // flight seam: the cabin wall and the wing stop a click
    const entry = hit.object.userData.entry;
    return { entry, onMarker: hit.object === entry.marker, point: hit.point };
  }

  const dragPlane = new THREE.Plane(), dragPoint = new THREE.Vector3();
  let down = null, dragging = false;
  let move = null; // a building being dragged: { entry, start, grab }
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  // Capture phase, so this runs before the camera controls and can claim the drag for a building.
  canvas.addEventListener('pointerdown', (ev) => {
    down = { x: ev.clientX, y: ev.clientY, ctrl: ev.ctrlKey };
    dragging = false;
    if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || !app.selected) return;
    const hit = pick(ev);
    if (!hit || hit.entry !== app.selected || hit.onMarker) return;
    // slide the building on a level plane through the point where it was grabbed
    dragPlane.set(new THREE.Vector3(0, 1, 0), -hit.point.y);
    move = { entry: app.selected, start: app.selected.offset.clone(), grab: hit.point.clone() };
    controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add('grabbing');
  }, true);
  canvas.addEventListener('pointermove', (ev) => {
    if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) dragging = true;
    if (move) {
      if (!dragging) return;
      tip.hidden = true;
      app.hideToast();
      const r = canvas.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(dragPlane, dragPoint)) {
        app.place(move.entry, move.start.x + dragPoint.x - move.grab.x, move.start.z + dragPoint.z - move.grab.z);
        renderer.shadowMap.needsUpdate = true;
        invalidate();
      }
      return;
    }
    if ((down && dragging) || !menu.hidden) { app.setHover(null); tip.hidden = true; canvas.classList.remove('grab'); return; }
    const hit = pick(ev), entry = hit && hit.entry;
    app.setHover(entry);
    const grabbable = !!hit && entry === app.selected && !hit.onMarker;
    canvas.classList.toggle('grab', grabbable);
    tip.hidden = !entry;
    if (entry) {
      const b = entry.data;
      tip.innerHTML = '<b></b><i></i><span></span>';
      tip.querySelector('b').textContent = label(b);
      tip.querySelector('i').textContent = details(b);
      tip.querySelector('span').textContent = isHidden(entry) ? 'Hidden. Click to show it.'
        : hit.onMarker ? 'Where it really stands. Click to put it back.'
          : grabbable ? 'Drag to move it' : '';
      tip.style.left = `${Math.min(ev.clientX + 16, innerWidth - 280)}px`;
      tip.style.top = `${ev.clientY + 18}px`;
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    const start = down, wasDrag = dragging;
    down = null; dragging = false;
    if (move) {
      const { entry, start: from } = move;
      move = null;
      controls.enabled = !app.fly.active; // flight seam: the map's controls stay off while flying
      canvas.classList.remove('grabbing');
      if (entry.offset.distanceTo(from) > 0.5) {
        app.remember(`Moved: ${label(entry.data)}`, `Put back: ${label(entry.data)}`, () => app.place(entry, from.x, from.z));
        app.updateCard();
        app.refresh();
      }
      return;
    }
    if (wasDrag || !start) return;
    const hit = pick(ev), entry = hit && hit.entry;
    // right-click, two-finger click, or ctrl-click: the menu
    if (ev.button === 2 || (ev.button === 0 && start.ctrl)) {
      if (entry) app.openMenu(entry, ev.clientX, ev.clientY);
      return;
    }
    if (ev.button !== 0) return;
    tip.hidden = true;
    if (!entry) app.select(null);
    else if (isHidden(entry)) app.apply([entry], false);
    else if (hit.onMarker) app.moveBack([entry]);
    else app.select(entry);
  });
  canvas.addEventListener('pointerleave', () => { app.setHover(null); tip.hidden = true; });
  app.dragging = () => !!move;
}

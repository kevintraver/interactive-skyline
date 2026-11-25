// What stands where: hiding, showing and moving towers, each change one undoable step. Every change is
// announced on the event bus as 'buildings:changed', the seam sky glow, shadows and the other plans subscribe to.
import * as THREE from 'three';
import { REMOVABLE, GRAY } from '../city/buildings.js';

const HOVER = new THREE.Color(0xa9d6ff), SELECT = new THREE.Color(0xf0623c), WHITE = new THREE.Color(0xffffff);

export const isHidden = (e) => !e.mesh.visible;
export const isMoved = (e) => e.offset.lengthSq() > 0.01;

export function initEdits(app) {
  const { settings, renderer, tall, events, sky, format: { fmt, label, plural } } = app;
  const count = document.getElementById('count');
  const toggleAll = document.getElementById('toggle-all');
  const changes = document.getElementById('changes');
  app.history = []; // undo stack: { done, undone, revert() }

  const changed = () => () => ({
    hidden: new Set(tall.filter(isHidden).map((e) => e.data.id)),
    moved: new Map(tall.filter(isMoved).map((e) => [e.data.id, { dx: e.offset.x, dz: e.offset.z }])),
  });

  /** Bring one building's color, marker and list row in line with the current state and settings. */
  function paint(e) {
    const { hovered, selected } = app;
    const m = e.mesh.material;
    const highlight = settings.highlight && !app.drive.active && !app.fly.active; // drive seam: natural colours, no edge lines while driving; flight seam: and while flying
    m.color.copy(e === selected ? SELECT : e === hovered ? (highlight ? HOVER : WHITE) : highlight ? REMOVABLE : GRAY); // drive seam
    m.emissiveIntensity = highlight && e !== selected ? sky.tint(settings.night) : 0; // drive seam
    e.mesh.children[0].visible = highlight; // drive seam
    e.mesh.position.copy(e.offset);
    e.marker.visible = isHidden(e) || isMoved(e);
    e.marker.material.opacity = e === hovered ? 0.75 : 0.42;
  }

  function refresh() {
    const hidden = tall.filter(isHidden).length, moved = tall.filter(isMoved).length;
    count.textContent = `${plural(tall.length)} over ${fmt(settings.cutoff)}`;
    toggleAll.textContent = hidden ? 'Show all' : 'Hide all';
    changes.hidden = !hidden && !moved;
    changes.querySelector('span').textContent = [hidden && `${hidden} hidden`, moved && `${moved} moved`].filter(Boolean).join(' · ');
    renderer.shadowMap.needsUpdate = true;
    app.views.stale = true;
    app.invalidate();
  }

  /** Hide or restore a set of buildings as one undoable step. */
  function apply(entries, hidden, record = true) {
    const changedEntries = entries.filter((e) => isHidden(e) !== hidden);
    if (!changedEntries.length) return;
    for (const e of changedEntries) {
      e.mesh.visible = !hidden;
      if (app.hovered === e) app.setHover(null);
      paint(e);
      app.syncRow(e);
    }
    if (hidden && changedEntries.includes(app.selected)) app.select(null);
    if (record) {
      const what = changedEntries.length === 1 ? label(changedEntries[0].data) : plural(changedEntries.length);
      remember(`${hidden ? 'Hidden' : 'Shown'}: ${what}`, `${hidden ? 'Shown' : 'Hidden'} again: ${what}`, () => apply(changedEntries, !hidden, false));
    }
    refresh();
    events.emit('buildings:changed', changed());
  }

  /** Put a building `x` meters east and `z` meters south of its real spot, standing on the ground there. */
  function place(e, x, z) {
    const [cx, cy] = e.data.c;
    if (!app.near.contains(cx + x, cy - z, 40)) return false; // stay on the detailed terrain
    e.offset.set(x, app.groundY(cx + x, cy - z) - app.groundY(cx, cy), z);
    paint(e);
    app.syncRow(e);
    events.emit('buildings:changed', changed());
    return true;
  }
  /** Send buildings back to where they really stand, as one undoable step. */
  function moveBack(entries) {
    const moved = entries.filter(isMoved);
    if (!moved.length) return;
    const was = moved.map((e) => e.offset.clone());
    moved.forEach((e) => place(e, 0, 0));
    const what = moved.length === 1 ? label(moved[0].data) : plural(moved.length);
    remember(`Put back: ${what}`, `Moved again: ${what}`, () => moved.forEach((e, i) => place(e, was[i].x, was[i].z)));
    app.updateCard();
    refresh();
  }
  /** Everything back as it really is: nothing hidden, nothing moved. */
  function resetEverything() {
    const hidden = tall.filter(isHidden), moved = tall.filter(isMoved);
    if (!hidden.length && !moved.length) return;
    const was = moved.map((e) => e.offset.clone());
    apply(hidden, false, false);
    moved.forEach((e) => place(e, 0, 0));
    remember('Every building is back', 'Your changes are back', () => {
      apply(hidden, true, false);
      moved.forEach((e, i) => place(e, was[i].x, was[i].z));
    });
    app.updateCard();
    refresh();
  }

  function remember(done, undone, revert) {
    app.history.push({ undone, revert });
    app.showToast(done, true);
  }
  function undo() {
    const last = app.history.pop();
    if (!last) return;
    last.revert();
    app.updateCard();
    refresh();
    app.showToast(`Undone. ${last.undone}`, false);
  }

  toggleAll.addEventListener('click', () => apply(tall, !tall.some(isHidden)));
  document.getElementById('reset-all').addEventListener('click', resetEverything);
  Object.assign(app, { paint, refresh, apply, place, moveBack, resetEverything, remember, undo });
}

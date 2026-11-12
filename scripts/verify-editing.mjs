import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const baseUrl = process.argv[2] || 'http://localhost:5173';
const session = execFileSync('agent-browser', ['session', 'id', '--scope', 'worktree', '--prefix', 'skyline-edit-check'], { encoding: 'utf8' }).trim();
const results = [];
function browser(...args) {
  return execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 });
}
function evaluate(fn) {
  const expression = typeof fn === 'function' ? `(${fn.toString()})()` : fn;
  const output = execFileSync('agent-browser', ['--session', session, 'eval', '--stdin'], { input: expression, encoding: 'utf8', timeout: 30000 });
  return JSON.parse(output);
}
function check(condition, message) {
  assert.ok(condition, message);
  results.push(message);
}
function position() {
  return evaluate(() => __skyline.tall.find((entry) => entry.data.name === 'Astra Tower').offset.toArray());
}
function original() {
  return position().every((n) => Math.abs(n) < 0.01);
}
function inspect() {
  return evaluate(() => {
    const visible = (element) => !!element && !element.hidden && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const editor = document.querySelector('#editor');
    const undo = document.querySelector('#edit-undo');
    return {
      editor: visible(editor),
      chrome: ['#top', '#navigation', '#credit', '#start-over'].some((selector) => visible(document.querySelector(selector))),
      undo: visible(undo) && !undo.disabled,
      controls: __skyline.controls.enabled,
      legacyPanels: document.querySelectorAll('#toast, #changes').length,
      editorCount: document.querySelectorAll('#editor').length,
    };
  });
}
function beginDrag() {
  const point = evaluate(() => {
    const app = __skyline;
    const canvas = document.querySelector('#scene');
    const p = app.screen(app.selectedId());
    for (const dy of [0, -20, 20, -40, 40, 60, -60, 80]) {
      for (const dx of [0, -20, 20, -40, 40]) {
        const x = Math.round(p.x + dx), y = Math.round(p.y + dy);
        canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, bubbles: true }));
        if (canvas.classList.contains('grab')) return { x, y };
      }
    }
    throw new Error('No exposed face of the selected tower was found.');
  });
  browser('mouse', 'move', String(point.x), String(point.y));
  browser('mouse', 'down', 'left');
  browser('mouse', 'move', String(point.x + 60), String(point.y + 20), '--duration', '200', '--steps', '12');
}
function chooseTower() {
  evaluate(() => {
    const entry = __skyline.tall.find((building) => building.data.name === 'Astra Tower');
    __skyline.focusOn(entry);
    __skyline.select(entry.data.id);
    return true;
  });
  browser('wait', '--fn', '!__skyline.flying()');
}

try {
  browser('open', `${baseUrl}/?city=slc`);
  browser('set', 'viewport', '1280', '800');
  browser('set', 'media', 'light', 'reduced-motion');
  browser('wait', '--fn', '!!window.__skyline');
  evaluate(() => {
    __skyline.setSetting('night', false);
    document.querySelector('#scene').addEventListener('pointerdown', (event) => { window.__editingTestPointer = event.pointerId; }, true);
    return true;
  });
  chooseTower();
  check(inspect().editorCount === 1 && inspect().legacyPanels === 0, 'Selection uses one editor without legacy toast or change panels.');
  check(evaluate(() => document.querySelector('#start-over').hidden), 'Start over stays hidden until a building changes.');
  browser('focus', '#editor [data-act="hide"]');
  browser('press', 'Escape');
  check(evaluate(() => __skyline.selectedId() === null && document.activeElement.id === 'scene'), 'Escape from the editor returns keyboard focus to the map.');
  chooseTower();

  beginDrag();
  check(!inspect().editor && !inspect().chrome, 'Dragging clears the editing panel and map chrome.');
  check(!original(), 'Pointer movement actually relocates the building.');
  mkdirSync('.impeccable/review', { recursive: true });
  browser('screenshot', `${process.cwd()}/.impeccable/review/dragging.png`);
  const cameraDuringDrag = evaluate(() => __skyline.camera.position.toArray());
  browser('press', 'ArrowRight');
  browser('press', 'Delete');
  check(evaluate(() => __skyline.hiddenIds().length === 0), 'Delete cannot hide a building during its drag.');
  check(evaluate(() => __skyline.camera.position.toArray()).every((n, i) => Math.abs(n - cameraDuringDrag[i]) < 0.01), 'Arrow keys cannot move the camera during a building drag.');
  browser('press', 'Escape');
  browser('mouse', 'up', 'left');
  check(original() && inspect().controls, 'Escape rolls the move back and restores camera input.');
  check(!inspect().undo, 'A cancelled move adds no undo step.');

  for (const reason of ['pointercancel', 'lostpointercapture', 'blur']) {
    chooseTower();
    beginDrag();
    if (reason === 'blur') {
      evaluate(() => { window.dispatchEvent(new Event('blur')); return true; });
    } else if (reason === 'lostpointercapture') {
      evaluate(() => { document.querySelector('#scene').releasePointerCapture(window.__editingTestPointer); return true; });
    } else {
      evaluate(() => {
        document.querySelector('#scene').dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__editingTestPointer, pointerType: 'mouse', bubbles: true }));
        return true;
      });
    }
    browser('mouse', 'up', 'left');
    check(original() && inspect().controls && !inspect().undo, `${reason} rolls back without adding history or leaving camera input disabled.`);
  }

  chooseTower();
  beginDrag();
  browser('mouse', 'up', 'left');
  check(!original() && inspect().editor && inspect().undo, 'Dropping commits the move and returns to one editor with Undo.');
  check(inspect().legacyPanels === 0, 'Dropping creates no additional feedback panels.');
  browser('screenshot', `${process.cwd()}/.impeccable/review/after-drop.png`);
  check(evaluate(() => {
    const control = document.querySelector('#start-over');
    return !control.hidden && !document.querySelector('#editor').contains(control) && control.textContent.trim() === 'Start over';
  }), 'Start over appears as a separate global control after a move.');
  browser('click', '#edit-more');
  check(evaluate(() => document.querySelectorAll('#edit-menu [data-act="back"], #restore-skyline').length === 0), 'The building menu contains no individual or global reset actions.');
  browser('press', 'Escape');
  await new Promise((resolve) => setTimeout(resolve, 7500));
  check(inspect().undo, 'Undo remains available after the old toast expiry time.');
  browser('click', '#edit-undo');
  check(original(), 'Undo restores the original building position.');
  check(evaluate(() => document.activeElement.id === 'scene'), 'Undo transfers focus to the map when its button disappears.');

  chooseTower();
  beginDrag();
  browser('mouse', 'up', 'left');
  browser('click', '#editor [data-act="hide"]');
  check(evaluate(() => __skyline.hiddenIds().length === 1 && __skyline.movedIds().length === 1), 'A moved building can also be hidden.');
  check(inspect().editor && inspect().undo, 'Hiding leaves a single recoverable editing summary.');
  check(evaluate(() => document.activeElement.id === 'edit-undo'), 'Hide transfers focus to persistent Undo.');
  browser('set', 'viewport', '390', '844');
  check(evaluate(() => {
    const views = document.querySelector('.views');
    const credit = document.querySelector('#credit');
    const editor = document.querySelector('#editor').getBoundingClientRect();
    return getComputedStyle(views).display !== 'none' && getComputedStyle(credit).display !== 'none'
      && views.getBoundingClientRect().bottom <= editor.top && credit.getBoundingClientRect().top >= editor.bottom;
  }), 'Changed-scene phone layout preserves viewpoints and readable attribution without covering the editor.');
  browser('find', 'role', 'button', 'click', '--name', 'Aerial', '--exact');
  check(evaluate(() => __skyline.hiddenIds().length === 1 && __skyline.movedIds().length === 1 && document.querySelector('#camera-home').getAttribute('aria-label').includes('Aerial')), 'Phone viewpoint switching remains available without undoing edits.');
  browser('screenshot', `${process.cwd()}/.impeccable/review/mobile-changed.png`);
  check(evaluate(() => {
    const control = document.querySelector('#start-over');
    const r = control.getBoundingClientRect();
    const bar = document.querySelector('#bar').getBoundingClientRect();
    const field = document.querySelector('#search').getBoundingClientRect();
    return document.querySelectorAll('#start-over').length === 1 && !control.hidden
      && r.width >= 44 && r.height >= 44 && r.left >= field.right && r.right <= bar.right;
  }), 'Phone Start over has one clear target in the global bar without covering search.');
  const beforeStart = evaluate(() => ({ position: __skyline.camera.position.toArray(), target: __skyline.controls.target.toArray(), settings: { ...__skyline.settings } }));
  browser('click', '#start-over');
  check(evaluate(() => __skyline.hiddenIds().length === 0 && __skyline.movedIds().length === 0), 'Start over shows hidden buildings and restores moved positions.');
  check(!inspect().editor && !inspect().undo && evaluate(() => document.querySelector('#start-over').hidden), 'Start over clears the editing session and hides its recovery controls.');
  check(evaluate(() => document.activeElement.id === 'scene'), 'Start over returns focus to the map.');
  const afterStart = evaluate(() => ({ position: __skyline.camera.position.toArray(), target: __skyline.controls.target.toArray(), settings: { ...__skyline.settings } }));
  check(JSON.stringify(afterStart) === JSON.stringify(beforeStart), 'Start over preserves the camera and map settings.');
  browser('press', 'Control+z');
  check(evaluate(() => __skyline.hiddenIds().length === 0 && __skyline.movedIds().length === 0), 'Old building edits cannot return through Undo after starting over.');
  browser('screenshot', `${process.cwd()}/.impeccable/review/after-start-over.png`);

  browser('set', 'viewport', '390', '844');
  chooseTower();
  browser('click', '#navigation-toggle');
  check(evaluate(() => {
    const editor = document.querySelector('#editor').getBoundingClientRect();
    const tools = document.querySelector('#tools').getBoundingClientRect();
    return tools.bottom <= editor.top && tools.top >= document.querySelector('#bar').getBoundingClientRect().bottom;
  }), 'Expanded phone navigation clears the compact editor and search bar.');
  browser('screenshot', `${process.cwd()}/.impeccable/review/mobile-edited.png`);
  console.log(JSON.stringify({ checks: results.length, passed: results }, null, 2));
} finally {
  try { browser('mouse', 'up', 'left'); } catch {}
  browser('close');
}

// T0.5: window.__skyline is a contract. The landmark skill's checker (skyline_tool.py, PROBE) and the test suites
// drive the app through it, so every member that exists today must keep existing and behaving, in every phase.
import { test, expect } from '@playwright/test';
import { CITIES, boot, frames, views } from '../helpers/app.js';

// Every member window.__skyline has at the end of phase 0. Later phases may add members, never remove these.
const MEMBERS = ['tall', 'renderer', 'scene', 'camera', 'controls', 'sun', 'invalidate', 'settings', 'setSetting', 'focusOn',
  'flying', 'setView', 'select', 'selectedId', 'screen', 'place', 'movedIds', 'hiddenIds', 'attractions'];
// What attractions.js exposes; the checker's probe uses ready, freeze, summary, find, extras and fountains.
const ATTRACTIONS = ['ready', 'extras', 'fountains', 'find', 'freeze', 'animating', 'summary'];
// Element ids the app and the checker rely on (the checker hides loading, tip, menu, card, toast, top, tools,
// dock, hint and changes before its screenshots; it also asks for `panel`, which no longer exists).
const IDS = ['scene', 'top', 'bar', 'city', 'search', 'city-menu', 'results', 'count', 'toggle-all', 'list', 'empty', 'card',
  'tools', 'night', 'options-toggle', 'compass', 'zoom-in', 'zoom-out', 'settings', 'cutoff-out', 'settings-reset', 'about',
  'tip', 'menu', 'dock', 'hint', 'toast', 'changes', 'reset-all', 'credit', 'loading'];

for (const city of CITIES) {
  test.describe(`hooks ${city}`, () => {
    test.beforeEach(async ({ page }) => { await boot(page, city); });

    test('every member and element is there', async ({ page }) => {
      const got = await page.evaluate(({ members, attractions, ids }) => {
        const s = window.__skyline;
        return {
          members: members.filter((k) => !(k in s)),
          attractions: attractions.filter((k) => !(k in s.attractions)),
          ids: ids.filter((id) => !document.getElementById(id)),
          types: {
            tall: Array.isArray(s.tall), renderer: !!s.renderer.render, scene: typeof s.scene.traverse, camera: !!s.camera.isPerspectiveCamera,
            controls: !!s.controls.target, sun: !!s.sun.isDirectionalLight, nightKey: 'night' in s.settings, ready: typeof s.attractions.ready.then,
          },
        };
      }, { members: MEMBERS, attractions: ATTRACTIONS, ids: IDS });
      expect(got.members).toEqual([]);
      expect(got.attractions).toEqual([]);
      expect(got.ids).toEqual([]);
      expect(got.types).toEqual({ tall: true, renderer: true, scene: 'function', camera: true, controls: true, sun: true, nightKey: true, ready: 'function' });
    });

    test('settings: night and highlight', async ({ page }) => {
      const r = await page.evaluate(() => {
        const s = window.__skyline, out = {};
        s.setSetting('night', true);
        out.night = [s.settings.night, document.documentElement.dataset.theme, s.sun.intensity];
        s.setSetting('night', false);
        out.day = [s.settings.night, document.documentElement.dataset.theme, s.sun.intensity];
        s.setSetting('highlight', false);
        out.edges = s.tall[0].mesh.children[0].visible;
        s.setSetting('highlight', true);
        out.edgesBack = s.tall[0].mesh.children[0].visible;
        return out;
      });
      expect(r).toEqual({ night: [true, 'dark', 0.2], day: [false, 'light', 2.7], edges: false, edgesBack: true });
    });

    test('tall buildings, geometry and the scene', async ({ page }) => {
      const r = await page.evaluate(() => {
        const s = window.__skyline, t = s.tall[0], g = t.mesh.geometry;
        let meshes = 0;
        s.scene.traverse((o) => { if (o.isMesh) meshes++; });
        g.computeBoundingBox();
        const sorted = s.tall.every((e, i) => i === 0 || s.tall[i - 1].data.h >= e.data.h);
        return { id: typeof t.data.id, h: t.data.h > 35, verts: g.attributes.position.count > 0, box: g.boundingBox.max.y > g.boundingBox.min.y,
          withGlow: s.tall.some((e) => !!e.mesh.geometry.attributes.glow), meshes: meshes > s.tall.length, sorted };
      });
      expect(r).toEqual({ id: 'string', h: true, verts: true, box: true, withGlow: true, meshes: true, sorted: true });
    });

    test('invalidate renders one frame', async ({ page }) => {
      await frames(page, 4);
      const before = await page.evaluate(() => window.__skyline.renderer.info.render.frame);
      await page.evaluate(() => window.__skyline.invalidate());
      await frames(page, 3);
      const after = await page.evaluate(() => window.__skyline.renderer.info.render.frame);
      expect(after).toBeGreaterThan(before);
    });

    test('views, select, screen, focus', async ({ page }) => {
      const r = await page.evaluate(async (views) => {
        const s = window.__skyline, out = {};
        const p0 = s.camera.position.clone();
        s.setView(views[views.length - 1]);
        out.moved = s.camera.position.distanceTo(p0) > 1;
        const id = s.tall[3].data.id;
        s.select(id);
        out.selected = s.selectedId() === id && !document.getElementById('card').hidden;
        const p = s.screen(id);
        out.screen = typeof p.x === 'number' && typeof p.y === 'number' && p.visible === true;
        s.focusOn(s.tall[3]);
        out.flying = s.flying();
        s.select('no such id');
        out.cleared = s.selectedId() === null && document.getElementById('card').hidden;
        return out;
      }, views(city));
      expect(r).toEqual({ moved: true, selected: true, screen: true, flying: true, cleared: true });
    });

    test('place, movedIds, hiddenIds', async ({ page }) => {
      const r = await page.evaluate(() => {
        const s = window.__skyline, e = s.tall[2];
        const ok = s.place(e, 30, -20);
        const moved = s.movedIds();
        s.place(e, 0, 0);
        e.mesh.visible = false;
        const hidden = s.hiddenIds();
        e.mesh.visible = true;
        return { ok, moved: moved.includes(e.data.id), back: s.movedIds().length, hidden: hidden.includes(e.data.id), away: s.place(e, 1e6, 0) };
      });
      expect(r).toEqual({ ok: true, moved: true, back: 0, hidden: true, away: false });
    });

    test('attractions: freeze, summary, find', async ({ page }) => {
      const r = await page.evaluate(() => {
        const a = window.__skyline.attractions;
        a.freeze(47);
        const sum = a.summary();
        const first = [...a.extras, ...a.fountains][0];
        const found = first ? a.find(first.name) === first : null;
        a.freeze(null);
        return { animating: typeof a.animating(), extras: Array.isArray(sum.extras), fountains: Array.isArray(sum.fountains),
          problems: sum.problems, found, missing: a.find('no such extra') };
      });
      expect(r.animating).toBe('boolean');
      expect(r.extras && r.fountains).toBe(true);
      expect(r.problems).toEqual([]);
      if (r.found !== null) expect(r.found).toBe(true);
      expect(r.missing).toBeNull();
    });
  });
}

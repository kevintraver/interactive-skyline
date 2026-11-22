// Interactive Skyline: bootstrap. Builds the shared context, loads the city, wires the interface, starts the
// frame loop. Each part lives in its own module (src/app, city, interaction, ui, sky, render; plan 01, 5.2).
//
// The landmark skill (.claude/skills/blender-landmark-model) reads the integration hooks across src/: the
// custom-model loader (city/data.js), the `windows` and `led` attributes (city/extrude.js) and the
// attractions import and call below, which stay in this file.
import { createApp } from './app/context.js';
import { installHooks } from './app/hooks.js';
import { createLegacySky } from './sky/legacySky.js';
import { loadTerrain } from './city/terrain.js';
import { createBuildings } from './city/buildings.js';
import { createViews } from './city/views.js';
import { initEdits } from './interaction/edits.js';
import { initSelection } from './interaction/selection.js';
import { initFocus } from './interaction/focus.js';
import { initPicking } from './interaction/picking.js';
import { createFormat } from './ui/format.js';
import { initCard } from './ui/card.js';
import { initToast, initHint } from './ui/toast.js';
import { initList } from './ui/list.js';
import { initMenu } from './ui/menu.js';
import { initPopovers } from './ui/popovers.js';
import { initSettingsPanel } from './ui/settingsPanel.js';
import { initCityMenu } from './ui/cityMenu.js';
import { initAttractions } from './attractions.js';
import { initDrive } from './drive/index.js'; // drive seam
import cities from '../data/cities.json';

const app = createApp(cities);
const { cityId, city, pending, settings, scene, camera, renderer, controls, loop, invalidate } = app;
// drive seam: Drive mode (src/drive/index.js) sets these while it is active; `night` is its look, never saved
const drive = app.drive = { active: false, night: null, frame: null, render: null, focus: null };
app.nightNow = () => drive.night ?? settings.night; // drive seam
app.format = createFormat(settings, city);
app.sky = createLegacySky().init(app);

// ------------------------------------------------------------------ load
const model = await pending.model;
const terrainData = await pending.terrain;
const customModels = await pending.custom;
const { near, far, terrain, groundY } = await loadTerrain(app, terrainData, pending.maps);
const buildings = createBuildings(app, model, customModels);
const { tall } = buildings;
Object.assign(app, { model, near, far, terrain, groundY, buildings, tall });
app.views = createViews(app, { near, groundY });

// ------------------------------------------------------------------ interface
initToast(app);
initEdits(app);
initSelection(app);
initCard(app);
initFocus(app);
initList(app);
initMenu(app);
initPopovers(app);
initPicking(app);
initSettingsPanel(app);
initHint(app);
initCityMenu(app);

// ------------------------------------------------------------------ go
app.views.resize();
app.views.set(city.views[0].id);
app.applySettings();
document.getElementById('loading').classList.add('done');
performance.mark('skyline-ready');

loop.start(renderer, {
  before(now) {
    if (drive.active) drive.frame(now); // drive seam: the drive moves the camera, not the map controls
    else { app.stepFlight(now); controls.update(); } // drive seam
  },
  render() {
    // while the camera is still, so the extra frames cost nothing during a drag
    if (app.views.stale && !app.flying() && !app.dragging() && !drive.active) { app.views.stale = false; app.views.snap(); } // drive seam
    if (drive.active) drive.render(); else renderer.render(scene, camera); // drive seam: while driving, the drive owns the draw
    if (!performance.getEntriesByName('skyline-frame').length) performance.mark('skyline-frame');
  },
});

installHooks(app);

// extras, the fountain show and animated LED surfaces (skyline-integration v5, src/attractions.js)
// drive seam: night-only extras follow the drive's look
initAttractions({ cityId, scene, camera, renderer, settings: new Proxy(settings, { get: (o, k) => (k === 'night' ? app.nightNow() : o[k]) }), invalidate, groundY, tall });

// drive seam: Drive mode, offered for cities with routes; it adds window.__skyline.drive and .terrain
initDrive(app, { terrainData });

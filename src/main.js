// Interactive Skyline: bootstrap. Builds the shared context, loads the city, wires the interface, starts the
// frame loop. Each part lives in its own module (src/app, city, interaction, ui, sky, render; plan 01, 5.2).
//
// The landmark skill (.claude/skills/blender-landmark-model) reads the integration hooks across src/: the
// custom-model loader (city/data.js), the `windows` and `led` attributes (city/extrude.js) and the
// attractions import and call below, which stay in this file.
import { createApp } from './app/context.js';
import { installHooks } from './app/hooks.js';
import { createLegacySky } from './sky/legacySky.js';
import { initSim, applyTimeParams } from './app/sim.js';
import { loadTerrain } from './city/terrain.js';
import { createBuildings } from './city/buildings.js';
import { createViews } from './city/views.js';
import { initEdits } from './interaction/edits.js';
import { initSelection } from './interaction/selection.js';
import { initFocus } from './interaction/focus.js';
import { initPicking } from './interaction/picking.js';
import { initCameraLimits } from './interaction/cameraLimits.js';
import { createFormat } from './ui/format.js';
import { initCard } from './ui/card.js';
import { initToast, initHint } from './ui/toast.js';
import { initList } from './ui/list.js';
import { initMenu } from './ui/menu.js';
import { initPopovers } from './ui/popovers.js';
import { initSettingsPanel } from './ui/settingsPanel.js';
import { initCityMenu } from './ui/cityMenu.js';
import { initSkyPopover } from './ui/skyPopover.js';
import { initTransport } from './ui/transport.js';
import { initWeather } from './weather/index.js';
import { initAttractions } from './attractions.js';
import { createPipeline } from './render/pipeline.js';
import { createLook } from './render/look.js';
import { initQuality } from './render/setupQuality.js';
import { createBench } from './render/bench.js';
import { warmUp } from './render/warmup.js';
import cities from '../data/cities.json';

const app = await createApp(cities);
const { cityId, city, pending, settings, scene, camera, renderer, controls, loop, invalidate } = app;
app.format = createFormat(settings, city);
app.sky = createLegacySky().init(app);
initSim(app);
// plan 01, phase 2: the render pipeline and the shipped look (physical light, automatic exposure) on the new
// renderer; the classic renderer (?renderer=legacy) draws the scene directly, as before
const pipeline = app.pipeline = createPipeline({ renderer, scene, camera, legacy: app.rendererKind === 'legacy', exposure: app.env.nodes.exposure });
app.draw = () => pipeline.render();
if (!pipeline.legacy) loop.add(app.look = createLook(app), 44);
initQuality(app);

// ------------------------------------------------------------------ load
const model = await pending.model;
const terrainData = await pending.terrain;
const customModels = await pending.custom;
const { near, far, terrain, groundY } = await loadTerrain(app, terrainData, pending.maps);
const buildings = createBuildings(app, model, customModels);
const { tall } = buildings;
Object.assign(app, { model, near, far, terrain, groundY, buildings, tall });
app.views = createViews(app, { near, groundY });
initCameraLimits(app); // the explore camera stays over the terrain and above the ground

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
initSkyPopover(app);
initTransport(app);
initWeather(app);

// ------------------------------------------------------------------ go
app.views.resize();
app.views.set(city.views[0].id);
app.applySettings();
applyTimeParams(app);
// the WebGL2 backend links the first frame's programs in parallel, under the loading cover (src/render/warmup.js)
await warmUp(app);
document.getElementById('loading').classList.add('done');
performance.mark('skyline-ready');
const readyAt = performance.now();

let lastFrame = null;
loop.start(renderer, {
  before(now) {
    app.stepFlight(now);
    controls.update();
  },
  render(now) {
    // while the camera is still, so the extra frames cost nothing during a drag
    if (app.views.stale && !app.flying() && !app.dragging()) { app.views.stale = false; app.views.snap(); }
    pipeline.render();
    if (app.look) app.look.afterRender();
    // the quality governor sees the interval between frames drawn back to back (section 7.14, T2.7)
    // (not in the first five seconds: shader compilation makes the first frames slow, and the governor never raises
    // a render scale it lowered then until a long continuous stretch)
    if (loop.tier === 'continuous' && lastFrame !== null && now - lastFrame < 250 && now - readyAt > 5000) app.quality.frame(now, now - lastFrame);
    lastFrame = now;
    if (!performance.getEntriesByName('skyline-frame').length) performance.mark('skyline-frame');
  },
});

installHooks(app);
// ?bench=1: the per-pass benchmark (plan 01, T2.8)
if (new URLSearchParams(location.search).get('bench') === '1') {
  window.__skyline.bench = app.bench = createBench(app);
  setTimeout(() => app.bench.run(), 1000);
}

// extras, the fountain show and animated LED surfaces (skyline-integration v7, src/attractions.js): a subsystem of
// the frame loop, its show time from the simulation clock (plan 01, T2.11)
initAttractions({ cityId, scene, camera, renderer, settings, invalidate, groundY, tall, loop, clock: app.clock, env: app.env });

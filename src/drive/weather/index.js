// The `weather` drive part (plan 02, phase 8): the wet road and the lamps' reflections (D8.1), falling rain near the
// camera, and spray behind vehicles (D8.3); on the classic renderer also a greyer, shorter-sighted sky. Joined in
// parts.js. Drops and wipers on the windshield (D8.2) are the windshield's (src/drive/vehicle/); what it needs from here
// is env.weather.state() and rainRelative() below (or rainMirror.js relativeRain for a pose).
//
// Two renderers (plan 02, third stretch, decisions 2 and 9). On the classic renderer (ctx.legacy) the GLSL modules
// (wetRoad.js, rain.js, spray.js, lights/sprites.js) draw over the stand-in weather of env.js, and skyblend.js greys the
// sky. On plan 01's renderer the node modules (wetRoad.node.js, rain.node.js, spray.node.js, lights/sprites.node.js)
// draw over plan 01's weather (env.js weatherOn: env.state, with rain and wetness derived in the drive until plan 01's
// phase 7); the sky, its haze and the fog are plan 01's and are left alone (rain falls under plan 01's interim sky).
//
// Everything is a pure function of the weather's state, the simulation time and the frame: nothing is carried from
// frame to frame but caches. Dry, each piece adds exactly nothing: the wet term is on the road and ground materials
// from the start but at wetness 0 skips its block (put on while the drive loads, so the first rain recompiles nothing),
// the twins are hidden with their wetness uniform 0, the rain and spray meshes are hidden; their programs are built
// ahead (classic: compiled in idle time; plan 01's: drawn once with nothing to draw), so the first rain builds none.
//
// Pieces:
//   wetRoad      the `wet` surface term on the road and ground materials (darker, glossier, wheel paths first, the sky
//                mirrored at grazing angles, the visitor's beam and the markings' retroreflection lost to the film)
//   twins        the street lamps' and vehicle lamps' reflected streaks (the sprite layer's setTwins, reflect layers)
//   rain         instanced streaks around the camera, lit by the low beam at night and the sky by day
//   spray        puffs behind the nearest moving vehicles, from the traffic part's vehicles of the frame
//   skyblend.js  classic only: setSkyWeather, grey sky, less sun, thicker fog by the visibility
//
// Test hooks: setRain(mmPerHour), setPreset(id), whenApplied(), state(), rainRelative(), wetUniforms, and stats().

import { bindWeather, chooseRain } from './control.js';
import { meanCover, facetSlope, GLOSS } from './wetMirror.js';
import { relativeRain } from './rainMirror.js';
import { eachGround } from '../parts.js';
import { createTimings } from '../timing.js';

/** Twins are drawn where their reflection point is within this far across the car's road (m: both carriageways of a
 * wide freeway and its median) and along it (m). */
export const TWIN_HALF_WIDTH_M = 26;
export const TWIN_RANGE_M = 320;

/** The modules of a renderer: the GLSL ones (classic) or the node ones (plan 01's). */
async function modulesFor(legacy) {
  if (legacy) {
    const [w, r, s, l, k] = await Promise.all([import('./wetRoad.js'), import('./rain.js'), import('./spray.js'), import('../lights/sprites.js'), import('../skyblend.js')]);
    return { createWetRoad: w.createWetRoad, createRain: r.createRain, createSpray: s.createSpray, setTwins: l.setTwins, TWIN_UNIFORMS: l.TWIN_UNIFORMS, setSkyWeather: k.setSkyWeather };
  }
  const [w, r, s, l, p] = await Promise.all([import('./wetRoad.node.js'), import('./rain.node.js'), import('./spray.node.js'), import('../lights/sprites.node.js'),
    import('../lights/photometry.node.js')]);
  return { createWetRoad: w.createWetRoad, createRain: r.createRain, createSpray: s.createSpray, setTwins: l.setTwins, TWIN_UNIFORMS: l.TWIN_UNIFORMS,
    photometryContext: p.photometryContext, LIGHTING_UNITS: p.LIGHTING_UNITS };
}

/** @param {object} ctx the part context (parts.js) */
export async function createWeatherPart(ctx) {
  const { env, session, group } = ctx;
  const weather = env?.weather;
  if (!weather?.state) return null;
  const legacy = ctx.legacy !== false;
  const M = await modulesFor(legacy);
  const app = ctx.app || {};
  const photometry = legacy ? null : M.photometryContext({ nodes: env.nodes });
  const wet = M.createWetRoad({
    road: [ctx.materials?.road, ctx.materials?.roadNear],
    ground: [ctx.wideMesh?.material],
    photometry,
  });
  const offGround = eachGround(ctx, (mesh) => wet.add(mesh.material, 'ground')); // the terrain patches too, when they come
  // plan 01's renderer: any other road surface the session hands out (decks share the road's materials today)
  const offSurfaces = !legacy && typeof ctx.eachSurface === 'function' ? ctx.eachSurface((m, kind) => { if (kind === 'road') wet.add(m, 'road'); }) : () => {};
  wet.prepare(); // the term on at wetness 0 from the start: the first rain recompiles nothing

  const rain = M.createRain({ parent: group, ...(legacy ? {} : { photometry }) });
  const spray = M.createSpray({ parent: group, ...(legacy ? {} : { photometry }) });
  const timings = createTimings();
  let disposed = false;
  const twinMeshes = () => { const out = []; group.traverse((o) => { if (o.name?.endsWith('-twins')) out.push(o); }); return out; };

  // The rain's own programs (the twins, the streaks, the spray: hidden while dry, so never drawn yet) built ahead, so
  // the first rain does not wait for them.
  //   classic: compiled in idle time, off the frame (compileAsync uses the parallel compile)
  //   plan 01's: each is drawn in one frame while dry with nothing to draw (no instances, or twins at wetness 0, which
  //   their vertex stage puts off screen): three builds the program for the pipeline's own pass then. New twin layers
  //   (a part that loads later) are looked for every WARM_SCAN frames while dry.
  const warmed = new WeakSet();
  let warming = [], warmScan = 0;
  const WARM_SCAN = 120;
  if (legacy) {
    const warm = () => {
      const { renderer, scene, camera } = app;
      // without the parallel compile it would block the main thread (and three warns): the first rain compiles then
      if (!renderer?.compileAsync || !renderer.extensions?.has?.('KHR_parallel_shader_compile') || !scene || !camera) return;
      for (const o of [rain.mesh, spray.mesh, ...twinMeshes()]) renderer.compileAsync(o, camera, scene).catch(() => {});
    };
    const idle = typeof requestIdleCallback === 'function' ? (fn) => requestIdleCallback(fn, { timeout: 3000 }) : (fn) => setTimeout(fn, 1000);
    if (!(typeof location !== 'undefined' && new URLSearchParams(location.search).get('weathertest') === 'nowarm')) idle(() => { if (!disposed) warm(); });
  }
  // ?weathertest=nowarm (test use): nothing built ahead, to measure what it saves (tests/manual/rain-node-budget.mjs)
  const noWarm = typeof location !== 'undefined' && new URLSearchParams(location.search).get('weathertest') === 'nowarm';
  function warmBefore() {
    if (legacy || noWarm || state.wetness > 0 || state.precipMmPerHour > 0) return;
    const scan = warmScan++ % WARM_SCAN === 0;
    const candidates = [rain.mesh, spray.mesh, ...(scan ? twinMeshes() : [])];
    for (const o of candidates) {
      if (warmed.has(o) || o.visible) continue;
      o.visible = true;
      warming.push(o);
    }
  }
  function warmAfter() {
    for (const o of warming) { o.visible = false; warmed.add(o); }
    warming = [];
  }

  let state = weather.state();
  let look = { lights: 0, beams: 0 };
  let pose = null, twinsOn = false, wasDry = false;
  const fogColor = () => app.scene?.fog?.color || null;
  /** The sky's radiance near the horizon in scene units (classic): the fog's colour, as before. */
  const skyRadiance = () => fogColor() || { r: 0.5, g: 0.55, b: 0.6 };
  /**
   * The sky's luminance near the horizon in cd/m^2 (plan 01's renderer). At the classic display it is the fog's colour
   * over LIGHTING_UNITS (so the light scale gives back exactly what the classic renderer used: the parity tool compares
   * them); in the shipped look it is the sky's own light, plan 01's diffuse horizontal illuminance over pi (a uniform
   * sky's luminance), in the haze's colour.
   */
  const sky = { r: 0, g: 0, b: 0 };
  function skyCdM2() {
    const fog = fogColor();
    if (photometry.display === 'classic') {
      const k = 1 / M.LIGHTING_UNITS.nit;
      const f = fog || { r: 0.5, g: 0.55, b: 0.6 };
      sky.r = f.r * k; sky.g = f.g * k; sky.b = f.b * k;
      return sky;
    }
    const L = (env.state?.sky?.ambientLux ?? 0) / Math.PI;
    const c = fog || { r: 1, g: 1, b: 1 };
    const y = Math.max(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 1e-6);
    sky.r = (c.r / y) * L; sky.g = (c.g / y) * L; sky.b = (c.b / y) * L;
    return sky;
  }
  const cityFactor = () => (legacy ? 1 : Math.max(env.state?.lights?.cityFactor ?? 1, 0));

  // ?weathersky=off (test use, classic only): the stand-in's grey sky left out, so the parity tool compares the weather's
  // own pixels with plan 01's renderer, whose sky the drive does not paint (plan 02, third stretch, decision 9)
  const skyWeather = legacy && !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('weathersky') === 'off');
  function applyWeather(s) {
    state = s;
    if (skyWeather) M.setSkyWeather({ overcast: s.overcast, skyDim: s.skyDim, visibilityM: s.visibilityM });
    app.invalidate?.();
  }
  const offChange = weather.on('change', applyWeather);
  const unbind = bindWeather(weather);
  applyWeather(weather.state());
  if (!legacy) app.invalidate?.(); // a frame to build the rain's programs in (warmBefore)

  // ?weathertest=spray (test use, both renderers): with no traffic part, three fixed vehicles ahead of the car throw
  // spray, so the parity tool can compare spray while traffic runs only on the classic renderer
  const testSpray = typeof location !== 'undefined' && new URLSearchParams(location.search).get('weathertest') === 'spray';
  const TEST_VEHICLES = [[-3.7, 14, 0], [0, 26, 1], [3.7, 19, 0]]; // across (m, right +), ahead (m), body (0 car 4.6 m, 1 truck 16 m)
  const testPlaced = { count: 0, pos: new Float32Array(9), fwd: new Float32Array(9), up: new Float32Array(9), speed: new Float32Array(3).fill(30),
    alpha: new Float32Array(3).fill(1), body: new Uint8Array(3), dir: new Uint8Array(3), lane: new Uint8Array([0, 1, 2]), id: new Uint32Array([7, 11, 13]), brake: new Uint8Array([0, 1, 0]) };
  function testTraffic(p) {
    TEST_VEHICLES.forEach(([x, z, b], i) => {
      for (let k = 0; k < 3; k++) {
        const c = ['x', 'y', 'z'][k];
        testPlaced.pos[3 * i + k] = p.position[c] + p.right[c] * x + p.forward[c] * z;
        testPlaced.fwd[3 * i + k] = p.forward[c]; testPlaced.up[3 * i + k] = p.up[c];
      }
      testPlaced.body[i] = b;
    });
    testPlaced.count = 3;
    return { placed: () => testPlaced, renderer: { lengths: [4.6, 16] } };
  }

  const beamsNow = () => {
    const head = session?.part?.('headlights')?.state?.();
    return (head ? (head.on ? 1 : 0) : 1) * (look.beams || 0);
  };

  function applyFrame(frame) {
    const t0 = performance.now();
    pose = frame.pose;
    state = weather.state(); // plan 01's follows the clock (the stand-in's is the cached state)
    const w = state.wetness;
    // plan 01's renderer runs this on every drawn frame: dry and already dry, only the term's order needs looking at
    if (!legacy && !(w > 0) && !(state.precipMmPerHour > 0) && wasDry) { wet.tick(); return; }
    wasDry = !(w > 0) && !(state.precipMmPerHour > 0);
    const skyNow = legacy ? skyRadiance() : skyCdM2();
    if (legacy) wet.set({ wetness: w, sky: skyNow });
    else {
      const cf = Math.max(cityFactor(), 1e-3); // the term's radiance is scaled by cityFactor; the sky is no lamp
      wet.set({ wetness: w, sky: { r: skyNow.r / cf, g: skyNow.g / cf, b: skyNow.b / cf } });
    }
    wet.tick(); // dry too: the term is kept last ahead of the rain
    if (w > 0) {
      const p = pose.position, f = pose.forward, h = Math.hypot(f.x, f.z) || 1;
      M.setTwins({
        wet: meanCover(w) * GLOSS.twin, slope: facetSlope(w), car: { x: p.x, z: p.z }, forward: { x: f.x, z: f.z },
        roadY: p.y, grade: f.y / h, halfWidth: TWIN_HALF_WIDTH_M, range: TWIN_RANGE_M,
      });
      twinsOn = true;
    } else if (twinsOn) { M.setTwins({ wet: 0 }); twinsOn = false; }
    if (legacy) rain.update({ state, simMs: frame.simMs, rate: frame.rate, pose, units: env.lighting.units.nit, beams: beamsNow(), sky: skyNow });
    else rain.update({ state, simMs: frame.simMs, rate: frame.rate, pose, beams: beamsNow(), skyCdM2: skyNow });
    timings.add(performance.now() - t0);
  }

  function sprayFrame(frame) {
    if (!(state.wetness > 0)) {
      if (spray.mesh.visible && !warming.includes(spray.mesh)) spray.update({ wetness: 0 });
      warmBefore();
      return;
    }
    const t0 = performance.now();
    const traffic = session?.part?.('traffic') || (testSpray ? testTraffic(frame.pose) : null);
    const common = {
      placed: traffic?.placed?.() || null, lengths: traffic?.renderer?.lengths || [], eye: frame.camera.position, pose: frame.pose,
      wetness: state.wetness, simMs: frame.simMs, lights: look.lights || 0, beams: beamsNow(),
    };
    if (legacy) spray.update({ ...common, units: env.lighting.units.nit, sky: skyRadiance() });
    else spray.update({ ...common, units: cityFactor(), sky: skyCdM2() });
    timings.add(performance.now() - t0);
  }

  const part = {
    name: 'weather',
    /** env.weather's state now. */
    state: () => state,
    /** Test hook: a rain rate in mm/h (any; 0 is Clear). Goes through the visit's choice, so the popover follows. */
    setRain(mmPerHour) { chooseRain(Number(mmPerHour)); return state; },
    /** A preset by id ('clear', 'light', 'moderate', 'heavy'). */
    setPreset(id) { chooseRain(id); return state; },
    /** Resolves when the last choice is in the weather (at once on the stand-in; plan 01's weather loads on demand). */
    whenApplied: () => Promise.resolve(weather.whenApplied?.()).then(() => { state = weather.state(); return state; }),
    /** Settled once the weather asked for is in force (plan 01's loads on demand): the session waits for it before a shot. */
    whenSettled: () => part.whenApplied(),
    /** The rain relative to the car (rainMirror.js relativeRain), for the windshield: velocity in the car's frame. */
    rainRelative: () => (pose ? relativeRain(state, pose) : null),
    /** The wet term's uniforms (wetRoad.js or wetRoad.node.js), for tests and probes. */
    wetUniforms: wet.uniforms,
    /** Test hook: take the wet term off every material (false) or put it back (true), to measure what it costs dry. */
    testWetTerm(on) { if (on) wet.prepare(); else wet.dispose(); app.invalidate?.(); return wet.attached; },
    // classic: in update, as before. Plan 01's renderer: in beforeRender, on every drawn frame, after plan 01's
    // environment and sky (frame steps 40 to 44): update runs at step 20 and only when the pose moves, so a seek while
    // paused would keep the previous moment's haze, and a #sky change while paused would not reach the road
    update(frame) {
      if (legacy) applyFrame(frame); else pose = frame.pose;
    },
    beforeRender(frame) {
      if (!legacy && frame?.pose) applyFrame(frame);
      sprayFrame(frame);
    },
    afterRender() { if (warming.length) warmAfter(); },
    setLook(l) { look = { lights: l.lights ?? (l.night ? 1 : 0), beams: l.beams ?? l.dusk ?? (l.night ? 1 : 0) }; },
    stats() {
      const t = timings.summary();
      const layers = twinMeshes().map((o) => [o.name, o.visible ? o.geometry.instanceCount : 0]);
      return {
        preset: state.preset, precipMmPerHour: state.precipMmPerHour, wetness: +state.wetness.toFixed(3), visibilityM: Math.round(state.visibilityM),
        wetMaterials: wet.attached, twinWet: +M.TWIN_UNIFORMS.uTwinWet.value.toFixed(3), twins: Object.fromEntries(layers),
        drops: rain.drops, spray: { sprites: spray.sprites, vehicles: spray.vehicles },
        renderer: legacy ? 'classic' : 'plan01', weather: weather.plan01 ? 'plan01' : 'stand-in',
        js: { mean: t.mean, p95: t.p95, max: t.max },
      };
    },
    dispose() {
      disposed = true;
      warmAfter();
      offGround(); offSurfaces();
      offChange(); unbind();
      // plan 01's weather back as it was before the drive's shorthand, unless the visitor changed it; then the port stops
      // listening to plan 01 (its state() still answers, read from env.state)
      Promise.resolve(weather.release?.()).then(() => weather.dispose?.());
      M.setTwins({ wet: 0 });
      if (skyWeather) M.setSkyWeather({ overcast: 0 });
      wet.dispose(); rain.dispose(); spray.dispose();
    },
  };
  group.userData.weatherPart = part; // for tests/manual/rain-shots.mjs
  return part;
}

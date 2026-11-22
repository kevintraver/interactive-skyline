// The `weather` drive part (plan 02, phase 8 on the stand-in weather of env.js): the wet road and the lamps'
// reflections (D8.1), falling rain near the camera, a greyer and shorter-sighted sky, and spray behind vehicles (D8.3).
// Joined in parts.js. Drops and wipers on the windshield (D8.2) are the windshield's (src/drive/vehicle/); what it
// needs from here is env.weather.state() and rainRelative() below (or rainMirror.js relativeRain for a pose).
//
// Everything is a pure function of the weather's state (env.js weatherFor: a preset, or the test hook's rate), the
// simulation time and the frame: nothing is carried from frame to frame but caches. Dry (Clear, the default), each
// piece adds exactly nothing: the wet term is not on any material until the first rain (and at wetness 0 it skips its
// block), the twins are hidden with their wetness uniform 0, the rain and spray meshes are hidden, and the sky's
// weather is overcast 0, which paints the sky as before.
//
// Pieces:
//   wetRoad.js   the `wet` surface term on the road and ground materials (darker, glossier, wheel paths first, the sky
//                mirrored at grazing angles, the visitor's beam and the markings' retroreflection lost to the film)
//   twins        the street lamps' and vehicle lamps' reflected streaks (lights/sprites.js setTwins, reflect layers)
//   rain.js      instanced streaks around the camera, lit by the low beam at night and the sky by day
//   spray.js     puffs behind the nearest moving vehicles, from the traffic part's vehicles of the frame
//   skyblend.js  setSkyWeather: grey sky, less sun, thicker fog by the visibility
//
// Test hooks: setRain(mmPerHour), setPreset(id), state(), rainRelative(), and stats().

import { bindWeather, chooseRain } from './control.js';
import { createWetRoad } from './wetRoad.js';
import { createRain } from './rain.js';
import { createSpray } from './spray.js';
import { meanCover, facetSlope, GLOSS } from './wetMirror.js';
import { relativeRain } from './rainMirror.js';
import { setTwins, TWIN_UNIFORMS } from '../lights/sprites.js';
import { setSkyWeather } from '../skyblend.js';
import { createTimings } from '../timing.js';

/** Twins are drawn where their reflection point is within this far across the car's road (m: both carriageways of a
 * wide freeway and its median) and along it (m). */
export const TWIN_HALF_WIDTH_M = 26;
export const TWIN_RANGE_M = 320;

/** @param {object} ctx the part context (parts.js) */
export function createWeatherPart(ctx) {
  const { env, session, group } = ctx;
  const weather = env?.weather;
  if (!weather?.state) return null;
  const app = ctx.app || {};
  const wet = createWetRoad({
    road: [ctx.materials?.road, ctx.materials?.roadNear],
    ground: [ctx.wideMesh?.material, ...(ctx.ground || []).map(([mesh]) => mesh.material)],
  });
  const rain = createRain({ parent: group });
  const spray = createSpray({ parent: group });
  const timings = createTimings();
  let state = weather.state();
  let look = { lights: 0, beams: 0 };
  let pose = null, twinsOn = false;
  const skyRadiance = () => app.scene?.fog?.color || { r: 0.5, g: 0.55, b: 0.6 };

  function applyWeather(s) {
    state = s;
    setSkyWeather({ overcast: s.overcast, skyDim: s.skyDim, visibilityM: s.visibilityM });
    app.invalidate?.();
  }
  const offChange = weather.on('change', applyWeather);
  const unbind = bindWeather(weather);
  applyWeather(weather.state());

  const part = {
    name: 'weather',
    /** env.weather's state now. */
    state: () => state,
    /** Test hook: a rain rate in mm/h (any; 0 is Clear). Goes through the visit's choice, so the popover follows. */
    setRain(mmPerHour) { chooseRain(Number(mmPerHour)); return state; },
    /** A preset by id ('clear', 'light', 'moderate', 'heavy'). */
    setPreset(id) { chooseRain(id); return state; },
    /** The rain relative to the car (rainMirror.js relativeRain), for the windshield: velocity in the car's frame. */
    rainRelative: () => (pose ? relativeRain(state, pose) : null),
    /** The wet term's uniforms (wetRoad.js), for tests and probes. */
    wetUniforms: wet.uniforms,
    update(frame) {
      const t0 = performance.now();
      pose = frame.pose;
      const w = state.wetness;
      wet.set({ wetness: w, sky: skyRadiance() });
      if (w > 0) wet.tick();
      if (w > 0) {
        const p = pose.position, f = pose.forward, h = Math.hypot(f.x, f.z) || 1;
        setTwins({
          wet: meanCover(w) * GLOSS.twin, slope: facetSlope(w), car: { x: p.x, z: p.z }, forward: { x: f.x, z: f.z },
          roadY: p.y, grade: f.y / h, halfWidth: TWIN_HALF_WIDTH_M, range: TWIN_RANGE_M,
        });
        twinsOn = true;
      } else if (twinsOn) { setTwins({ wet: 0 }); twinsOn = false; }
      const head = session?.part?.('headlights')?.state?.();
      const beams = (head ? (head.on ? 1 : 0) : 1) * (look.beams || 0);
      rain.update({ state, simMs: frame.simMs, rate: frame.rate, pose, units: env.lighting.units.nit, beams, sky: skyRadiance() });
      timings.add(performance.now() - t0);
    },
    beforeRender(frame) {
      if (!(state.wetness > 0)) { if (spray.mesh.visible) spray.update({ wetness: 0 }); return; }
      const t0 = performance.now();
      const traffic = session?.part?.('traffic');
      const head = session?.part?.('headlights')?.state?.();
      spray.update({
        placed: traffic?.placed?.() || null, lengths: traffic?.renderer?.lengths || [], eye: frame.camera.position, pose: frame.pose,
        wetness: state.wetness, simMs: frame.simMs, lights: look.lights || 0, beams: (head ? (head.on ? 1 : 0) : 1) * (look.beams || 0),
        units: env.lighting.units.nit, sky: skyRadiance(),
      });
      timings.add(performance.now() - t0);
    },
    setLook(l) { look = { lights: l.lights ?? (l.night ? 1 : 0), beams: l.beams ?? l.dusk ?? (l.night ? 1 : 0) }; },
    stats() {
      const t = timings.summary();
      const layers = [];
      group.traverse((o) => { if (o.name?.endsWith('-twins')) layers.push([o.name, o.visible ? o.geometry.instanceCount : 0]); });
      return {
        preset: state.preset, precipMmPerHour: state.precipMmPerHour, wetness: +state.wetness.toFixed(3), visibilityM: Math.round(state.visibilityM),
        wetMaterials: wet.attached, twinWet: +TWIN_UNIFORMS.uTwinWet.value.toFixed(3), twins: Object.fromEntries(layers),
        drops: rain.drops, spray: { sprites: spray.sprites, vehicles: spray.vehicles },
        js: { mean: t.mean, p95: t.p95, max: t.max },
      };
    },
    dispose() {
      offChange(); unbind();
      setTwins({ wet: 0 });
      setSkyWeather({ overcast: 0 });
      wet.dispose(); rain.dispose(); spray.dispose();
    },
  };
  group.userData.weatherPart = part; // for tests/manual/rain-shots.mjs
  return part;
}

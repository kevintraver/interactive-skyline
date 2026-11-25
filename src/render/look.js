// The shipped look on the new renderer (plan 01, T2.5 and T2.6): physical light, pre-exposure, automatic exposure.
// Frame step 44, after env.update and the legacy sky (40) and before the pipeline (60). Each rendered frame it
//   1. turns what the legacy sky set (its keyframes: key body, sun power, street glow) into lux and cd/m2
//      (src/render/photometry.js),
//   2. runs the exposure (src/render/exposure.js) from the prior those lights give,
//   3. writes the pre-exposed intensities: key light, sky ambient (the hemisphere light), the city's own ambient
//      light, the ground's street glow, and the uniforms the materials read (exposure, legacyScale, switch-on).
//
// `?display=classic` keeps the classic look instead: the legacy sky's own values, exposure 1, ACES, no bloom. The
// parity specs use it to compare materials with the classic renderer; nothing here runs on that renderer.
import { AmbientLight, Color } from 'three';
import { physicalLights, priorEv100, streetCdM2, PHOTOMETRY } from './photometry.js';
import { createExposure } from './exposure.js';
import { exposure as exposureUniform, physical, legacyScale } from './materials/shared.js';
import { colorTemperatureToLinearSrgb } from '../core/units.js';
import { lum } from './pipeline.js';

const DEG = Math.PI / 180;
/** Tone mapping and bloom of the shipped look (section 7.3). */
/** AgX renders mid-grey about half a stop darker than ACES: the shipped display exposes that much more. */
export const SHIPPED_OFFSET_EV = 0.5;
export const SHIPPED_DISPLAY = { toneMapping: 'agx', bloom: 0.06, contrast: 0.08, saturation: 0.12 };
const lumOf = (c) => Math.max(lum(c.r, c.g, c.b), 1e-6);

/** The display the address asks for: 'classic' or the shipped 'physical' one. */
export const displayFromSearch = (search) => (new URLSearchParams(search).get('display') === 'classic' ? 'classic' : 'physical');

export function createLook(app, { display = displayFromSearch(globalThis.location ? location.search : '') } = {}) {
  const { scene, sky, env, renderer, pipeline, clock, settings } = app;
  const classicDisplay = display === 'classic';
  const warm = colorTemperatureToLinearSrgb(PHOTOMETRY.cityKelvin);
  const cityLight = new AmbientLight(new Color(...warm), 0);
  cityLight.name = 'city light';
  scene.add(cityLight);
  physical.value = classicDisplay ? 0 : 1;

  const current = { keyLux: 0, ambientLux: 0, cityLux: 0, priorEv: 15, keyAltDeg: 32 };
  const exposure = createExposure({ renderer, pipeline, uniform: exposureUniform, clock, settings, offsetEv: SHIPPED_OFFSET_EV, invalidate: app.invalidate,
    prior: () => current.priorEv });
  if (classicDisplay) {
    exposure.hold(1);
    pipeline.configure({ toneMapping: 'aces', bloom: 0, contrast: 0, saturation: 0 });
  } else {
    // the shipped display (section 7.3): AgX with a mild contrast and saturation lift, a little bloom mixed in
    pipeline.configure(SHIPPED_DISPLAY);
  }

  function lights() {
    const s = env.state, c = sky.classic;
    const keyDir = s && s.key && s.key.body !== 'none' ? s.key.dir : sky.sun.position.clone().sub(sky.sun.target.position).normalize();
    current.keyAltDeg = c.pinned ? 32 : Math.asin(Math.max(-1, Math.min(1, keyDir.y))) / DEG;
    const ambientLux = c.pinned ? (c.keyBody === 'sun' ? 15000 : s.sky.ambientLux) : s.sky.ambientLux;
    const street = s ? s.lights.street : 0;
    Object.assign(current, physicalLights(c, { pinned: c.pinned, moonLux: s ? s.moon.illuminanceLux : 0, ambientLux, street }));
    if (!priorTerms) { current.priorEv = priorEv100(current); return; }
    // a mode whose camera is not standing in the lit city (the flight) gives the prior its own terms (and the city light its lux)
    current.priorTerms = priorTerms({ keyLux: current.keyLux, keyAltDeg: current.keyAltDeg, ambientLux: current.ambientLux,
      cityLux: current.cityLux, emissionLux: current.emissionLux, keyBody: c.keyBody, street });
    current.priorEv = priorEv100(current.priorTerms);
  }
  /** setPriorTerms(fn): fn(terms) -> the terms the prior is computed from (null: the lights' own, as by default). */
  let priorTerms = null;

  // The physical, pre-exposed intensities are put on the lights only while the pipeline draws, and the classic
  // values the legacy sky set are put back after: window.__skyline.sun and the landmark checker read them, and
  // they keep their meaning between frames (the hooks contract).
  const saved = { sun: 0, hemi: 0, terrain: [] };
  function applyLight(on) {
    if (classicDisplay) return;
    const terrain = sky.terrain || [];
    if (!on) {
      sky.sun.intensity = saved.sun; sky.hemi.intensity = saved.hemi; cityLight.intensity = 0;
      terrain.forEach((t, i) => { t.mesh.material.emissiveIntensity = saved.terrain[i]; });
      return;
    }
    saved.sun = sky.sun.intensity; saved.hemi = sky.hemi.intensity;
    saved.terrain = terrain.map((t) => t.mesh.material.emissiveIntensity);
    const k = exposureUniform.value, c = sky.classic;
    sky.sun.intensity = (current.keyLux * k) / lumOf(sky.sun.color);
    sky.hemi.intensity = (current.ambientLux * k) / lumOf(sky.hemi.color);
    const cityLux = current.priorTerms && Number.isFinite(current.priorTerms.cityLightLux) ? current.priorTerms.cityLightLux : current.cityLux;
    cityLight.intensity = (cityLux * k * env.nodes.cityFactor.value) / lumOf(cityLight.color);
    terrain.forEach((t, i) => {
      const m = t.mesh.material;
      m.emissiveIntensity = (streetCdM2(c.street[i] || 0) * (c.imagery ? 1 : 0.3) * k * env.nodes.cityFactor.value) / lumOf(m.emissive);
    });
  }
  pipeline.around.push(applyLight);
  if (!classicDisplay) lights();

  const look = {
    display, exposure, current, cityLight,
    update(frame) {
      if (env.mode === 'pinned') env.update(); // the pinned state follows settings.night (cached; cheap)
      env.nodes.sync();
      if (classicDisplay) return;
      lights();
      exposure.update(frame);
      // the interim legacy surfaces follow the exposure's departure from what the prior alone would give
      legacyScale.value = exposureUniform.value / exposure.expectedFor(current.priorEv);
    },
    /** After the frame is drawn: meter it for the next. */
    afterRender() { if (!classicDisplay) exposure.afterRender(); },
    demand() { return classicDisplay ? 'idle' : exposure.demand(); },
    /** A seek for the exposure: a new view, a pinned look, a new city (`newView` forgets the meter's offsets). */
    seek(newView = true) { exposure.snap(newView); },
    /**
     * Replace the terms the prior is computed from, while a mode needs it (the flight: the light at the aircraft, not
     * in the lit city), or put the default back with null. `fn({ keyLux, keyAltDeg, ambientLux, cityLux, emissionLux,
     * keyBody, street })` returns { keyLux, keyAltDeg, ambientLux, cityLux, emissionLux } for photometry.js
     * priorEv100, every frame, and optionally cityLightLux: the lux of the city's ambient light where the camera is
     * (omitted: plan 01's cityLux); the other lights are not changed. Without it everything is exactly as before.
     */
    setPriorTerms(fn) {
      priorTerms = typeof fn === 'function' ? fn : null;
      if (!priorTerms) delete current.priorTerms;
      exposure.snap(false); // Camera mode: a new prior is a seek (Eye mode follows the prior every frame anyway)
    },
  };
  return look;
}

// env.nodes (plan 01, section 11.5): the shader nodes other plans' materials will import. Phase 1 runs on
// today's WebGLRenderer, which has no TSL, so these are placeholders with the final names and the stub values of
// section 11.1: exposure 1, emissive() a day/night constant, no city light, no cloud shadow, dry surfaces. Each
// returns plain numbers (or its input), so code written against the names runs now; phase 2 replaces every one
// with a TSL node and phase 3 onward gives them their real values.
export function createEnvNodes(env) {
  const night = () => env.state.lights.windows; // 0 by day, 1 at night, smooth through dusk
  return {
    exposure: { value: 1 },
    cityFactor: { get value() { return env.state.lights.cityFactor; } },
    switchOn: {
      windows: { get value() { return env.state.lights.windows; } },
      street: { get value() { return env.state.lights.street; } },
      signs: { get value() { return env.state.lights.signs; } },
    },
    /** cd/m2 -> display units: a day/night constant until phase 2's exposure (x cityFactor when artificial). */
    emissive(cdM2, o = {}) {
      const k = 1 / (night() > 0.5 ? 50 : 5000);
      return Number(cdM2) * k * (o.artificial ? env.state.lights.cityFactor : 1);
    },
    pointSource(candela, o = {}) {
      return { color: Number(candela) * (o.artificial ? env.state.lights.cityFactor : 1) * 1e-4, sizePx: Math.max(1, o.minPixels ?? 1) };
    },
    get keyLightDir() { return env.state.key.dir; },
    keyLight: () => env.state.key.illuminanceLux,
    ambient: () => env.state.sky.ambientLux,
    skyReflection: () => 0,
    artificialLight: () => 0,
    aerialPerspective: () => [0, 0, 0, 1],
    transmittance: () => [1, 1, 1],
    cloudShadow: () => 1,
    wetness: () => [0, 0],
    wetLayer: (surface) => surface,
    applyWetSurface: () => {},
  };
}

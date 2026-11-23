// skyline-integration: v7 (blender-landmark-model skill)
// (older tools test for the text "skyline-integration: v4" and replace files without it; v7 includes it here)
// Night lighting without any extra lights or draw calls: buildings glow from their own material.
// Three sources are added as emissive light:
//   - `glow`, an optional per-vertex color baked into hand-made models (see customModels.js)
//   - lit windows, drawn procedurally on the walls of extruded buildings, and on the parts of hand-made
//     models whose `windows` attribute asks for them (their glass, usually)
//   - animated LED surfaces: model faces whose `led` attribute is set (glTF material named Led...) show
//     slowly drifting color bands, strong at night and faint by day, driven by the shared `clock`
// By day the same facade glass of a hand-made model also gets a mullion and floor grid, slightly uneven
// panes, and the sky reflected at grazing angles. Extruded buildings carry no `windows` attribute, so by
// day they look exactly as before.
//
// v7 (plan 01, phase 2): the app renders with WebGPURenderer, which runs neither onBeforeCompile nor GLSL. The
// shading lives in src/render/materials/buildingMaterial.js as TSL node materials, compiled for WebGPU or WebGL2;
// the v6 GLSL moved unchanged to src/render/legacy/materials.js for the classic renderer (?renderer=legacy).
// The names below are the v6 ones: `night` and `clock` are uniforms with a `.value` (TSL uniform nodes, which
// the GLSL path reads as ordinary uniforms), and lightAtNight() still takes a Lambert material and returns the
// material to draw with: a MeshLambertNodeMaterial copying its colour, emissive and blending.
import { active } from './render/active.js';
import { night, clock } from './render/materials/shared.js';
import { createBuildingMaterial } from './render/materials/buildingMaterial.js';

/** 0 by day, 1 at night. Every lit material shares this uniform, so switching is one assignment. */
export { night };
/** Seconds for animated surfaces (LED skins, the fountain show); attractions.js sets it. */
export { clock };

/**
 * Make a Lambert material glow at night. `windows: false` is for hand-made models, which carry their own
 * `glow` colors and get lit windows (and the day facade detail) only where their `windows` attribute is set.
 * Returns the material to use (on the new renderer a node material made from this one).
 */
export function lightAtNight(material, { windows = true } = {}) {
  if (active.legacy) return active.legacy.lightAtNight(material, { windows });
  return createBuildingMaterial({ variant: windows ? 'extruded' : 'landmark', from: material });
}

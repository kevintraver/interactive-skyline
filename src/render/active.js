// Which material set the app builds (plan 01, T2.1). The new renderer's TSL node materials by default; with
// ?renderer=legacy the classic renderer's GLSL ones, which src/render/legacy/renderer.js installs here before
// anything is built. The integration files (night.js, fountain.js) and the legacy sky ask here.
export const active = {
  /** null, or the module src/render/legacy/materials.js when the classic renderer is in use */
  legacy: null,
};

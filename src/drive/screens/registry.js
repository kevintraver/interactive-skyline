// The screens the drive knows about (plan 02, section 5.10): the Sphere, the animated LED faces of the other
// landmark models and extras, and the digital and lit billboards beside the road. A screen is
//   { id, kind: 'led' | 'billboard', name, area (m^2), centre() -> [x, y, z] scene metres (moves with its building),
//     visible() -> boolean (false when its building is hidden), meanColor(simMs, out) -> linear [r, g, b] }
// where meanColor is the content program's mean over the screen's area at that simulation time, in scene emissive
// units (level included), known analytically or from a fixed set of samples: what the screen's light on its
// surroundings is scaled by (light.js), and what the tests compare with the program.

export function createScreenRegistry() {
  const screens = new Map();
  return {
    /** Add or replace a screen (by id). Returns it. */
    add(screen) {
      if (!screen || typeof screen.id !== 'string' || typeof screen.meanColor !== 'function') throw new Error('a screen needs an id and a meanColor(simMs, out)');
      screens.set(screen.id, screen);
      return screen;
    },
    remove(id) { screens.delete(id); },
    get: (id) => screens.get(id) || null,
    list: () => [...screens.values()],
    get size() { return screens.size; },
    /** The mean colour of a screen now, or null for an unknown or hidden one. */
    meanColor(id, simMs, out = [0, 0, 0]) {
      const s = screens.get(id);
      if (!s || (s.visible && !s.visible())) return null;
      return s.meanColor(simMs, out);
    },
    /** A plain summary for tests and stats. */
    summary(simMs) {
      const by = {};
      for (const s of screens.values()) by[s.kind] = (by[s.kind] || 0) + 1;
      const sphere = screens.get('sphere');
      return {
        count: screens.size, byKind: by,
        sphere: sphere ? { visible: sphere.visible(), centre: sphere.centre().map((v) => +v.toFixed(1)), mean: Number.isFinite(simMs) ? sphere.meanColor(simMs, [0, 0, 0]).map((v) => +v.toFixed(4)) : null } : null,
      };
    },
  };
}

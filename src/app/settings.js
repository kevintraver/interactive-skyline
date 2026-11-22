// User-adjustable behaviour, kept between visits. `cutoff` is in meters.
export const DEFAULTS = { cutoff: 35, highlight: true, units: 'ft', imagery: true, night: false, fountain: true, wheel: true };
const STORE = 'slc-skyline-settings';
/**
 * In the clock state (src/env/environment.js) `settings.night` is derived from the Sun and must not be saved;
 * the pinned value it will return to is kept under this key, and saved in its place.
 */
export const PINNED_NIGHT = Symbol('pinned night');

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE)) || {};
    return Object.fromEntries(Object.keys(DEFAULTS).filter((k) => typeof saved[k] === typeof DEFAULTS[k]).map((k) => [k, saved[k]]));
  } catch { return {}; }
}

export function saveSettings(settings) {
  const data = { ...settings };
  if (PINNED_NIGHT in settings) data.night = settings[PINNED_NIGHT];
  try { localStorage.setItem(STORE, JSON.stringify(data)); } catch { /* private window: settings last for this visit only */ }
}

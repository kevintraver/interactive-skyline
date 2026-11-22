// User-adjustable behaviour, kept between visits. `cutoff` is in meters.
export const DEFAULTS = { cutoff: 35, highlight: true, units: 'ft', imagery: true, night: false, fountain: true, wheel: true };
const STORE = 'slc-skyline-settings';

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE)) || {};
    return Object.fromEntries(Object.keys(DEFAULTS).filter((k) => typeof saved[k] === typeof DEFAULTS[k]).map((k) => [k, saved[k]]));
  } catch { return {}; }
}

export function saveSettings(settings) { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* private window: settings last for this visit only */ } }

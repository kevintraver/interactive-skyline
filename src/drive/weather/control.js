// The visitor's rain choice for this visit, shared by the time popover (ui/timepop.js), the address (url.js `rain`)
// and the drive's weather (env.weather, bound by the weather part). The popover is built before any drive session
// exists, so it talks to this module rather than to a session: a choice made with no session waits here and is
// applied when the next session's weather binds. Pure state plus two DOM touches (reading and patching the address),
// both skipped where there is no window.

import { decodeRain, withRain, RAIN_NAMES } from '../url.js';
import { RAIN_PRESETS } from '../env.js';

let chosen = null; // preset id or a rate (mm/h); null until read from the address
let weather = null;
const listeners = new Set();

const hasWindow = () => typeof location !== 'undefined' && typeof history !== 'undefined';

/** The choice now: a preset id ('clear', 'light', 'moderate', 'heavy') or a rate in mm/h from the address. */
export function rainChoice() {
  if (chosen === null) chosen = (hasWindow() && decodeRain(new URLSearchParams(location.search).get('rain'))) ?? 'clear';
  return chosen;
}

function apply() {
  if (!weather) return;
  const c = rainChoice();
  if (typeof c === 'number') weather.setRain(c); else weather.setPreset(c);
}

function writeAddress() {
  if (!hasWindow()) return;
  const params = new URLSearchParams(location.search);
  if (params.get('mode') !== 'drive' && rainChoice() !== 'clear') return; // the map's address carries no rain
  const q = withRain(params, rainChoice()).toString();
  const next = q ? `?${q}` : location.pathname;
  if (next !== location.search) history.replaceState(history.state, '', next);
}

/** Choose the rain (a preset id or a rate in mm/h): applied to the bound weather and written to the address. */
export function chooseRain(choice) {
  const c = typeof choice === 'number' ? decodeRain(String(choice)) : RAIN_NAMES.includes(choice) ? choice : undefined;
  if (c === undefined) return;
  chosen = c;
  apply();
  writeAddress();
  for (const fn of [...listeners]) fn(c);
}

/** The weather part binds its env.weather here; the choice of the visit is applied at once. Returns an unbind. */
export function bindWeather(w) {
  weather = w;
  apply();
  writeAddress();
  return () => { if (weather === w) weather = null; };
}

/** fn(choice) after each choice. */
export function onRainChoice(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The preset the popover shows as chosen for a choice (a rate picks the nearest preset). */
export function presetOf(choice) {
  if (typeof choice !== 'number') return RAIN_PRESETS.find((p) => p.id === choice) || RAIN_PRESETS[0];
  let best = RAIN_PRESETS[0];
  for (const p of RAIN_PRESETS) if (Math.abs(p.mmPerHour - choice) < Math.abs(best.mmPerHour - choice)) best = p;
  return best;
}

/** For tests: forget the choice and the binding. */
export function resetRainChoice() { chosen = null; weather = null; listeners.clear(); }

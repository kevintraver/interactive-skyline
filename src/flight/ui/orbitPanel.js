// The orbit's controls (plan 03, section 4.6; F7.2): the three presets, altitude, radius, looking into or out of the
// circle, the centre, and the readouts the plan asks for (the bank angle and the lap time; the speed, which is set by
// the altitude and is not a control).
//
// Two halves, as the seat map has: the pure logic (slider mappings, readouts, presets, the change each control makes;
// unit tested without a DOM) and createOrbitPanel, which builds the controls in code inside `parent` (the #orbit-
// controls slot of section 4.9) and calls onChange with a change for changeOrbit. Sliders preview their readouts while
// they move and hand the change over on release (or on each key press), so a drag makes one transition, not a hundred.
// The controls are native range inputs, buttons and a switch, so the keyboard works as it does everywhere; keys used
// by a control do not reach the mode's own shortcuts. Its styles are injected once as <style id="orbitpanel-style">.
import { ORBIT, PRESETS, orbitParams, orbitSpeed } from '../orbit.js';
import { G } from '../kinematics.js';

const FT = 0.3048, KT = 1852 / 3600, DEG = Math.PI / 180;
const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------------------------------- the logic

/** Steps of the radius slider. */
export const RADIUS_STEPS = 1000;
/** ft: an altitude this close to one of 4.6's marks snaps to it. */
const MARK_SNAP_FT = 250;

/** The radius (km) at a slider position: logarithmic from minKm to 60 km, so short radii get as much travel. */
export function sliderToRadius(v, minKm, maxKm = ORBIT.radiusMaxM / 1000) {
  const u = Math.min(1, Math.max(0, v / RADIUS_STEPS));
  return minKm * (maxKm / minKm) ** u;
}
/** The slider position (0..RADIUS_STEPS) of a radius. */
export function radiusToSlider(km, minKm, maxKm = ORBIT.radiusMaxM / 1000) {
  if (!(km > minKm)) return 0;
  if (km >= maxKm) return RADIUS_STEPS;
  return (RADIUS_STEPS * Math.log(km / minKm)) / Math.log(maxKm / minKm);
}

/** An altitude (ft) held in 4.6's range, on a mark when within 250 ft of one, else on 500 ft. */
export function snapAltitude(ft) {
  const a = Math.min(ORBIT.altFt.max, Math.max(ORBIT.altFt.min, ft));
  const mark = ORBIT.altFt.marks.find((m) => Math.abs(m - a) <= MARK_SNAP_FT);
  if (mark !== undefined) return mark;
  return Math.min(ORBIT.altFt.max, Math.max(ORBIT.altFt.min, Math.round(a / 500) * 500));
}

/** "6 min 20 s", "7 min", "45 s". */
function durationText(s) {
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  const m = Math.floor(r / 60), sec = r % 60;
  return sec ? `${m} min ${sec} s` : `${m} min`;
}

/**
 * The readouts for a set of orbit parameters (orbitParams), before the orbit is flown: the steady circle's bank (with
 * a wind, its steepest, downwind) and lap time, and the speeds. They equal what createOrbitTrack flies.
 * @param {ReturnType<typeof orbitParams>} p  @param {{ units?: 'ft'|'m' }} [o]
 */
export function orbitReadouts(p, { units = 'ft' } = {}) {
  const altM = p.altFt * FT, r = p.radiusKm * 1000;
  const speed = orbitSpeed(altM, p.iasKt ?? undefined);
  const V = speed.tas, we = p.wind?.east ?? 0, wn = p.wind?.north ?? 0, w = Math.hypot(we, wn);
  // the lap: the integral of r dtheta over the ground speed round the circle, where the ground speed along the tangent
  // is the wind's part along it plus what the airspeed leaves after the wind's part across it
  const N = 720;
  let lapS = 0;
  for (let i = 0; i < N; i++) {
    const th = ((i + 0.5) / N) * 2 * Math.PI, ue = Math.sin(th), un = Math.cos(th);
    const te = un, tn = -ue; // clockwise tangent; the lap time is the same either way round
    const wt = we * te + wn * tn, wr = we * ue + wn * un;
    lapS += (r * (2 * Math.PI / N)) / (wt + Math.sqrt(V * V - wr * wr));
  }
  const vgMax = V + w;
  const bankDeg = Math.atan((vgMax * vgMax) / (G * r)) / DEG;
  const metric = units === 'm';
  const alt = metric ? `${group.format(Math.round(altM / 10) * 10)} m` : `${group.format(p.altFt)} ft`;
  const spd = (ms) => (metric ? `${group.format(Math.round(ms * 3.6))} km/h` : `${group.format(Math.round(ms / KT))} kt`);
  return {
    bankDeg, lapS, iasKt: speed.iasKt, tasKt: speed.tas / KT, mach: speed.mach,
    text: {
      altitude: alt,
      radius: `${Math.round(p.radiusKm * 10) / 10} km`,
      bank: `Bank ${Math.round(bankDeg)}°`,
      lap: `Lap ${durationText(lapS)}`,
      speed: `${spd(speed.ias)} indicated, ${spd(speed.tas)} true`,
      look: p.outward ? 'Looking out, at the mountains' : 'Looking into the circle',
    },
  };
}

/** The preset being flown ('overhead', 'valley', 'strip'), or null. */
export function matchingPreset(p) {
  for (const [key, pr] of Object.entries(PRESETS)) {
    if (p.altFt === pr.altFt && Math.abs(p.radiusKm - Math.max(pr.radiusKm, p.minRadiusKm)) < 0.05) return key;
  }
  return null;
}

/**
 * The change a control makes, for changeOrbit.
 * @param {'preset'|'altitude'|'radius'|'outward'|'center'} kind
 * @param {*} value the preset's key, the altitude slider's ft, the radius slider's position, the switch, a centre
 * @param {ReturnType<typeof orbitParams>} p the orbit now
 */
export function panelChange(kind, value, p) {
  switch (kind) {
    case 'preset': { const pr = PRESETS[value]; return pr ? { altFt: pr.altFt, radiusKm: pr.radiusKm } : {}; }
    case 'altitude': return { altFt: snapAltitude(Number(value)) };
    case 'radius': return { radiusKm: sliderToRadius(Number(value), p.minRadiusKm) };
    case 'outward': return { outward: !!value };
    case 'center': return { center: { x: value.x, n: value.n } };
    default: return {};
  }
}

// ---------------------------------------------------------------------------------------------------- the DOM

const STYLE_ID = 'orbitpanel-style';
const STYLE = `
.orbitpanel { display: grid; gap: 10px; padding: 10px 12px 12px; color: var(--ink, #1d2329); font-size: 13px; min-width: min(320px, calc(100vw - 2 * var(--gap, 12px))); }
.orbitpanel .op-title { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0; font-weight: 650; text-align: left; }
.orbitpanel .op-title::after { content: ""; width: 7px; height: 7px; margin-right: 4px; border: solid var(--muted, #5b6570); border-width: 0 2px 2px 0; rotate: 225deg; translate: 0 2px; }
.orbitpanel .op-title[aria-expanded="false"]::after { rotate: 45deg; translate: 0 -2px; }
.orbitpanel .op-body { display: grid; gap: 10px; }
.orbitpanel .op-body[hidden] { display: none; }
.orbitpanel .op-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.orbitpanel .op-preset { padding: 5px 10px; border-radius: 8px; background: var(--fill, rgba(0,0,0,.06)); font-weight: 600; }
.orbitpanel .op-preset:hover, .orbitpanel .op-preset:focus-visible { background: var(--fill-strong, rgba(0,0,0,.12)); }
.orbitpanel .op-preset[aria-pressed="true"] { background: var(--blue, #2f6fdf); color: var(--surface, #fff); }
.orbitpanel .op-row { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 2px 10px; }
.orbitpanel .op-row label { font-weight: 600; }
.orbitpanel .op-value { color: var(--muted, #5b6570); font-variant-numeric: tabular-nums; }
.orbitpanel input[type=range] { grid-column: 1 / -1; width: 100%; accent-color: var(--blue, #2f6fdf); }
.orbitpanel .op-switch { display: flex; align-items: center; gap: 8px; padding: 4px 0; text-align: left; }
.orbitpanel .op-switch .op-track { width: 30px; height: 18px; border-radius: 9px; background: var(--fill-strong, rgba(0,0,0,.18)); position: relative; flex: none; }
.orbitpanel .op-switch .op-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--surface-strong, #fff); }
.orbitpanel .op-switch[aria-checked="true"] .op-track { background: var(--blue, #2f6fdf); }
.orbitpanel .op-switch[aria-checked="true"] .op-track::after { left: 14px; }
.orbitpanel .op-switch:focus-visible { outline: 2px solid var(--blue, #2f6fdf); outline-offset: 2px; border-radius: 6px; }
.orbitpanel .op-centre { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.orbitpanel .op-centre button { padding: 3px 8px; border-radius: 8px; background: var(--fill, rgba(0,0,0,.06)); }
.orbitpanel .op-centre button:hover, .orbitpanel .op-centre button:focus-visible { background: var(--fill-strong, rgba(0,0,0,.12)); }
.orbitpanel .op-note { color: var(--muted, #5b6570); font-size: 12px; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: no-preference) { .orbitpanel .op-switch .op-track::after { transition: left .12s; } }
`;

function injectStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE;
  doc.head.append(st);
}

/** Keys a focused control uses itself; they are kept from the mode's shortcuts (play, seek, look). */
const CONTROL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' ', 'Enter']);

/**
 * The controls, built in code.
 * @param {{ parent: HTMLElement, params: ReturnType<typeof orbitParams>, stripCenter?: { x: number, n: number },
 *   centerLabel?: string, units?: 'ft'|'m', onChange: (change: object, info: { kind: string }) => void, doc?: Document,
 *   collapsed?: boolean }} o
 *   params is the orbit now (track.orbit); onChange receives a change for changeOrbit(track, t, change) and the kind of
 *   control that made it ('preset', 'altitude', 'radius', 'outward', 'center'): the mode cuts a preset (orbit.js planChange);
 *   collapsed starts it folded to its title (the title button folds and unfolds it)
 */
export function createOrbitPanel({ parent, params, stripCenter = { x: 0, n: 0 }, centerLabel = 'the Strip', units = 'ft', onChange = () => {}, doc = globalThis.document, collapsed = false }) {
  injectStyle(doc);
  let p = params, label = centerLabel;
  const el = doc.createElement('section');
  el.id = 'orbit-controls';
  el.className = 'orbitpanel';
  el.setAttribute('aria-label', 'Orbit');
  const make = (tag, props = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for' || k === 'list') n.setAttribute(k, v);
      else n[k] = v;
    }
    n.append(...kids);
    return n;
  };

  const title = make('button', { type: 'button', class: 'op-title', text: 'Orbit', title: 'Show or hide the orbit\'s controls' });
  const presets = make('div', { class: 'op-presets', role: 'group', 'aria-label': 'Presets' });
  const presetButtons = Object.entries(PRESETS).map(([key, pr]) => {
    const b = make('button', { type: 'button', class: 'op-preset', 'data-preset': key, text: pr.label, title: `${pr.label}: ${group.format(pr.altFt)} ft` });
    b.addEventListener('click', () => onChange(panelChange('preset', key, p), { kind: 'preset' }));
    presets.append(b);
    return [key, b];
  });

  const uid = Math.random().toString(36).slice(2, 8);
  const marks = make('datalist', { id: `op-marks-${uid}` }, ...ORBIT.altFt.marks.map((m) => make('option', { value: String(m) })));
  const altValue = make('span', { class: 'op-value', 'aria-live': 'polite' });
  const alt = make('input', { type: 'range', id: `op-alt-${uid}`, min: String(ORBIT.altFt.min), max: String(ORBIT.altFt.max), step: '100', list: `op-marks-${uid}` });
  const altRow = make('div', { class: 'op-row' }, make('label', { for: `op-alt-${uid}`, text: 'Altitude' }), altValue, alt, marks);

  const radValue = make('span', { class: 'op-value', 'aria-live': 'polite' });
  const rad = make('input', { type: 'range', id: `op-r-${uid}`, min: '0', max: String(RADIUS_STEPS), step: '1' });
  const radRow = make('div', { class: 'op-row' }, make('label', { for: `op-r-${uid}`, text: 'Radius' }), radValue, rad);

  const look = make('button', { type: 'button', class: 'op-switch', role: 'switch' }, make('span', { class: 'op-track', 'aria-hidden': 'true' }), make('span', { text: 'Look out at the mountains' }));
  look.addEventListener('click', () => onChange(panelChange('outward', !p.outward, p), { kind: 'outward' }));

  const centreText = make('span');
  const back = make('button', { type: 'button', text: 'Back to the Strip' });
  back.addEventListener('click', () => onChange(panelChange('center', stripCenter, p), { kind: 'center' }));
  const centre = make('div', { class: 'op-centre' }, centreText, back);
  const note = make('div', { class: 'op-note' });
  const body = make('div', { class: 'op-body' }, presets, altRow, radRow, look, centre, note);
  el.append(title, body);
  parent.append(el);
  const setCollapsed = (on) => { body.hidden = !!on; title.setAttribute('aria-expanded', String(!on)); };
  title.addEventListener('click', () => setCollapsed(!body.hidden));
  setCollapsed(collapsed);

  /** The readouts for a pending change (a slider moving), or for the orbit now. */
  const show = (pending) => {
    const q = pending ? orbitParams({ ...p, ...pending }) : p;
    const r = orbitReadouts(q, { units });
    altValue.textContent = r.text.altitude;
    alt.setAttribute('aria-valuetext', r.text.altitude);
    radValue.textContent = `${r.text.radius} · ${r.text.bank} · ${r.text.lap}`;
    rad.setAttribute('aria-valuetext', `${r.text.radius}, ${r.text.bank.toLowerCase()}, ${r.text.lap.toLowerCase()}`);
    note.textContent = `Speed ${r.text.speed}, set by the altitude.`;
    return q;
  };
  const sync = () => {
    alt.value = String(p.altFt);
    rad.value = String(Math.round(radiusToSlider(p.radiusKm, p.minRadiusKm)));
    const preset = matchingPreset(p);
    for (const [key, b] of presetButtons) b.setAttribute('aria-pressed', String(key === preset));
    look.setAttribute('aria-checked', String(!!p.outward));
    const atStrip = Math.hypot(p.center.x - stripCenter.x, p.center.n - stripCenter.n) < 1;
    centreText.textContent = `Circling ${atStrip ? 'the Strip' : label}`;
    back.hidden = atStrip;
    show();
  };

  alt.addEventListener('input', () => show(panelChange('altitude', alt.value, p)));
  alt.addEventListener('change', () => onChange(panelChange('altitude', alt.value, p), { kind: 'altitude' }));
  rad.addEventListener('input', () => show(panelChange('radius', rad.value, p)));
  rad.addEventListener('change', () => onChange(panelChange('radius', rad.value, p), { kind: 'radius' }));
  el.addEventListener('keydown', (ev) => {
    if (ev.target !== el && CONTROL_KEYS.has(ev.key)) ev.stopPropagation();
  });

  sync();
  return {
    el,
    /** The orbit now (after a change was flown) and, when it circles a building, that building's name. */
    update(next, { centerLabel: nextLabel } = {}) {
      p = next;
      if (nextLabel) label = nextLabel;
      sync();
    },
    /** Fold the panel to its title, or unfold it. */
    setCollapsed,
    get collapsed() { return body.hidden; },
    dispose() { el.remove(); },
  };
}

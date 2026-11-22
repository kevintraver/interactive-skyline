// The weather rows of #sky (plan 01, section 4.2; tasks T5.3 and T5.5): the chip (sky, visibility, temperature, wind
// in the visitor's units), the source line (what the numbers come from and what answered, or the override in force)
// with "Back to real"; the source (Live, This date in history, Preset) and the preset or year; and, behind "Adjust the
// weather", the ten sliders of section 4.2, each with a visible "follow data" state. Built only from what #sky already
// uses: .row, .field, .seg, .check and the theme tokens.
import { formatWeather, describeSource, describeOverride, compass } from '../weather/describe.js';
import { PRESETS } from '../weather/presets.js';
import { OVERRIDES, dataValue } from '../weather/overrides.js';

/** A slider's value in the visitor's units ('ft' or 'm'). */
export function formatOverride(o, v, units) {
  if (v === null || v === undefined) return 'none';
  const metric = units === 'm';
  switch (o.unit) {
    case 'fraction': return `${Math.round(v * 100)} %`;
    case 'height': return metric ? `${Math.round(v / 10) * 10} m` : `${(Math.round(v / 0.3048 / 100) * 100).toLocaleString('en-US')} ft`;
    case 'aod': return `optical depth ${v.toFixed(2)}`;
    case 'dust': return `${Math.round(v).toLocaleString('en-US')} µg/m³`;
    case 'speed': return metric ? `${Math.round(v * 3.6)} km/h` : `${Math.round(v * 2.23694)} mph`;
    case 'direction': return `${compass(v)} ${Math.round(v)}°`;
    case 'rate': return metric ? `${v.toFixed(1)} mm/h` : `${(v / 25.4).toFixed(2)} in/h`;
    case 'flashes': return `${Math.round(v)} a minute`;
    default: return String(v);
  }
}

export function initWeatherRows(app, service) {
  const { clock, env, settings } = app;
  const $ = (id) => document.getElementById(id);
  const form = $('sky'), chip = $('sky-weather'), sourceLine = $('sky-source'), realBtn = $('sky-real');
  const fmt = { time: (t) => clock.format(t, 'time'), date: (t) => clock.format(t, 'date') };

  const sourceRadios = [...form.querySelectorAll('input[name="sky-source"]')];
  const yearRow = $('sky-year-row'), yearIn = $('sky-year'), presetRow = $('sky-preset-row'), presetSel = $('sky-preset');
  const adjust = $('sky-adjust'), sliderBox = $('sky-sliders');
  const sliders = OVERRIDES.map((o) => {
    const el = form.querySelector(`.sky-slider[data-key="${o.key}"]`);
    return { o, el, input: el.querySelector('input'), out: el.querySelector('output'), follow: el.querySelector('.follow') };
  });
  for (const p of PRESETS) presetSel.append(new Option(p.label, p.id));
  const lastYear = () => new Date().getUTCFullYear() - 1;
  yearIn.max = String(lastYear());

  function renderControls(sample, st) {
    for (const r of sourceRadios) r.checked = r.value === st.kind;
    yearRow.hidden = st.kind !== 'history';
    presetRow.hidden = st.kind !== 'preset';
    if (st.kind === 'history' && document.activeElement !== yearIn) yearIn.value = String(st.year);
    if (st.kind === 'preset') presetSel.value = st.preset;
    const overrides = service.overrides;
    if (Object.keys(overrides).length && !adjust.checked) adjust.checked = true;
    sliderBox.hidden = !adjust.checked;
    if (sliderBox.hidden) return;
    for (const { o, el, input, out, follow } of sliders) {
      const set = Object.hasOwn(overrides, o.key);
      const v = set ? overrides[o.key] : dataValue(sample, o.key, service.groundM);
      if (document.activeElement !== input || !set) input.value = String(v ?? o.min);
      out.value = set ? formatOverride(o, v, settings.units) : `data: ${formatOverride(o, v, settings.units)}`;
      out.classList.toggle('data', !set);
      follow.hidden = !set;
      el.dataset.state = set ? 'set' : 'data';
    }
  }

  function render() {
    if (form.hidden) return;
    const t = clock.timeMs;
    const s = service.sample(t);
    const st = service.status(t);
    chip.value = formatWeather(s, settings.units);
    const override = describeOverride(st);
    sourceLine.textContent = override || describeSource(st, fmt);
    if (!override && st.kind !== 'preset' && !st.loading && !st.unavailable) {
      // Open-Meteo's licence asks for a link beside the data
      sourceLine.append(' · Weather data by ');
      const a = document.createElement('a');
      a.href = 'https://open-meteo.com/';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open-Meteo.com';
      sourceLine.append(a);
    }
    realBtn.hidden = !override;
    form.dataset.weather = st.loading ? 'loading' : st.unavailable ? 'unavailable' : st.kind;
    renderControls(s, st);
  }

  for (const r of sourceRadios) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      if (r.value === 'preset') service.setSource({ kind: 'preset', id: presetSel.value || 'clear' });
      else if (r.value === 'history') service.setSource({ kind: 'history', year: Number(yearIn.value) || lastYear() });
      else service.setSource({ kind: 'live' });
    });
  }
  presetSel.addEventListener('change', () => service.setSource({ kind: 'preset', id: presetSel.value }));
  yearIn.addEventListener('change', () => {
    const y = Math.round(Number(yearIn.value));
    if (Number.isFinite(y)) service.setSource({ kind: 'history', year: y });
  });
  adjust.addEventListener('change', () => {
    if (!adjust.checked) service.clearOverrides(); // hiding the sliders follows data again
    render();
  });
  for (const { o, input, follow } of sliders) {
    input.addEventListener('input', () => service.setOverride(o.key, Number(input.value)));
    input.addEventListener('dblclick', () => service.setOverride(o.key, null));
    follow.addEventListener('click', () => { service.setOverride(o.key, null); input.focus({ preventScroll: true }); });
  }

  realBtn.addEventListener('click', () => service.backToReal());
  service.on('change', render);
  for (const type of ['tick', 'seek', 'state']) clock.on(type, render);
  env.on('mode', render);
  app.events.on('sky:open', (open) => { if (open) render(); });
  $('settings').addEventListener('change', render); // units
  render();
  return { render };
}

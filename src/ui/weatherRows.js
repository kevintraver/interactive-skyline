// The weather rows of #sky (plan 01, section 4.2; tasks T5.3 and T5.5): the chip (sky, visibility, temperature, wind
// in the visitor's units), the source line (what the numbers come from and what answered, or the override in force)
// with "Back to real". Built only from what #sky already uses: .row, .field, .seg, .check and the theme tokens.
import { formatWeather, describeSource, describeOverride } from '../weather/describe.js';

export function initWeatherRows(app, service) {
  const { clock, env, settings } = app;
  const $ = (id) => document.getElementById(id);
  const form = $('sky'), chip = $('sky-weather'), sourceLine = $('sky-source'), realBtn = $('sky-real');
  const fmt = { time: (t) => clock.format(t, 'time'), date: (t) => clock.format(t, 'date') };

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

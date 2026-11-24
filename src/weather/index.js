// Weather, on demand (plan 01, phase 5). Nothing is imported or fetched at boot: the first time the clock state needs
// weather, or #sky opens, the weather code (client.js, its own chunk) loads, and with it the weather rows of #sky.
export function initWeather(app) {
  let loading = null;
  const load = () => (loading ||= import('./client.js').then((m) => m.startWeather(app)));
  app.env.setWeatherRequest(() => { load(); });
  app.events.on('sky:open', (open) => { if (open) load(); });
  app.loadWeather = load;
  // window.__skyline gains `loadWeather` (and `weather` once loaded); members are only ever added
  const expose = () => { if (window.__skyline) window.__skyline.loadWeather = load; else setTimeout(expose, 50); };
  expose();
}

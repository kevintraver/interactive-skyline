// The weather code proper, loaded on first need by src/weather/index.js: the service (fetching, fusion, sources,
// overrides), the provider the environment reads, and the weather rows of #sky.
import { createWeatherService } from './service.js';
import { presetSample } from './presets.js';
import { atmosphereMedium } from './derive.js';
import { initWeatherRows } from '../ui/weatherRows.js';

export function startWeather(app) {
  const { city, cityId, env } = app;
  const service = createWeatherService({ cityId, city });
  env.setWeather({
    sample: (t) => service.sample(t),
    preset: (id, t) => presetSample(id, t, service.groundM),
    medium: (s) => atmosphereMedium(s, { elevationM: city.base }), // the scene's ground, where the atmosphere starts
  });
  service.on('change', () => env.weatherChanged());
  initWeatherRows(app, service);
  app.weather = service;
  // window.__skyline gains `weather` (members are only ever added); it exists once the app has booted
  const expose = () => { if (window.__skyline) window.__skyline.weather = service; else setTimeout(expose, 50); };
  expose();
  return service;
}

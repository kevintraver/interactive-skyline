// GET /api/weather: live and historical weather for a city, normalized (plan 01, section 6.3). A Vercel function in
// the web-standard form (Node.js runtime); `pnpm dev` serves the same handler through vite.config.js. The logic is in
// api/_lib/handler.js. WEATHER_CONTACT, if set in the deployment, is appended to the User-Agent the NOAA services ask
// for; nothing else about anyone is sent.
import cities from '../data/cities.json' with { type: 'json' };
import { createWeatherHandler } from './_lib/handler.js';

export const config = { maxDuration: 15 };

const handle = createWeatherHandler({ cities, env: typeof process === 'undefined' ? {} : process.env });

export default { fetch: (request) => handle(request) };

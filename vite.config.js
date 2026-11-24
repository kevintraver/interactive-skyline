// Vite: the build needs no configuration. This file only adds a dev middleware that serves /api/weather with the
// same handler Vercel runs (plan 01, section 6.3), so `pnpm dev` works without the Vercel CLI. `vite preview` and
// the buildless server have no /api, and the app falls back quietly there.
import { defineConfig } from 'vite';

function weatherApi() {
  return {
    name: 'skyline-weather-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/weather', async (req, res) => {
        try {
          const { default: fn } = await server.ssrLoadModule('/api/weather.js');
          const response = await fn.fetch(new Request(new URL(req.originalUrl || req.url, 'http://localhost'), { method: req.method }));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          server.config.logger.error(`/api/weather: ${err && err.stack ? err.stack : err}`);
          res.statusCode = 500;
          res.end('{"success":false,"data":null,"error":"dev middleware failed","meta":null}');
        }
      });
    },
  };
}

export default defineConfig({ plugins: [weatherApi()] });

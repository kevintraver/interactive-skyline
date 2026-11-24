// T5.2: `pnpm dev` serves /api/weather without the Vercel CLI (vite.config.js). Only requests that fail validation
// are sent, so nothing leaves this machine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { createServer } from 'vite';
import { ROOT } from '../../helpers/staticServer.js';

let server, base;
beforeAll(async () => {
  server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null } });
  await server.listen();
  const { port } = server.httpServer.address();
  base = `http://127.0.0.1:${port}`;
}, 60_000);
afterAll(async () => { await server?.close(); });

describe('the dev middleware', () => {
  it('routes /api/weather to the handler: a bad query is its 400, as JSON', async () => {
    const res = await fetch(`${base}/api/weather?city=atlantis&live=1`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ success: false, error: 'unknown city' });
  });
  it('and a POST is its 405', async () => {
    const res = await fetch(`${base}/api/weather?city=lv&live=1`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

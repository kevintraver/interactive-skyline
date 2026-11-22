// T0.6: the app boots with no bundler, from src/ through an import map, as the landmark skill's checker runs it.
import { test, expect } from '@playwright/test';
import { startStaticServer } from '../helpers/staticServer.js';
import { CITIES } from '../helpers/app.js';

let server;
test.beforeAll(async () => { server = await startStaticServer(); });
test.afterAll(async () => { await server.close(); });

for (const city of CITIES) {
  test(`boots ${city} without Vite`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${server.url}/?city=${city}`);
    await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 90_000 });
    await page.evaluate(() => window.__skyline.attractions.ready);
    const built = await page.evaluate(() => ({ tall: window.__skyline.tall.length, problems: window.__skyline.attractions.summary().problems }));
    expect(built.tall).toBeGreaterThan(10);
    expect(built.problems).toEqual([]);
    expect(errors).toEqual([]);
    expect(server.missing.filter((p) => !p.startsWith('/favicon'))).toEqual([]);
  });
}

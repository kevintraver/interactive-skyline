// T0.2: golden screenshots of today's app, the "no behaviour change" gate for phase 0.
// Each city, each view, pinned day and pinned night; fountain, LED and wheel clocks held still; storage fresh
// per test (Playwright gives each test its own browser context).
//
// Goldens are per platform. Where none exists for the running platform (a Linux CI runner, until someone
// generates them there; see tests/README.md) the scene is still rendered and checked for errors, and the
// comparison is skipped with an annotation, so CI never claims golden coverage it does not have.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { SCENES, sceneName, boot, stage } from '../helpers/app.js';

test.describe.configure({ timeout: 600_000 });

const updating = () => test.info().config.updateSnapshots === 'all' || test.info().config.updateSnapshots === 'changed';

for (const scene of SCENES) {
  test(`baseline ${sceneName(scene)}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await boot(page, scene.city);
    await stage(page, scene);
    expect(errors, 'no page or console errors').toEqual([]);
    const name = `${sceneName(scene)}.png`;
    if (!updating() && !fs.existsSync(test.info().snapshotPath(name))) {
      test.info().annotations.push({ type: 'skipped-golden', description: `no ${process.platform} golden for ${name}` });
      return;
    }
    // SKYLINE_GOLDEN_STRICT=1: every pixel must match (for checking a refactor), not the 0.1 % default
    await expect(page).toHaveScreenshot(name, process.env.SKYLINE_GOLDEN_STRICT ? { maxDiffPixels: 0, threshold: 0 } : {});
  });
}

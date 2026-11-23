// T2.3: every baseline scene on the new renderer's WebGL2 backend, held at the classic display (ACES, exposure 1,
// no bloom), against the classic renderer in the same run: each within 2 % mean absolute difference of the canvas
// (plan 01, phase 2). Stays while ?renderer=legacy exists.
//
// Until the goldens were regenerated for the shipped look (commit "regenerate the ten goldens ..."), this spec also
// compared each scene with its T0.2 golden, full-page; on 22 November 2026 every scene was within 0.28 to 0.88 % of
// its golden and 0.29 to 0.90 % of the classic renderer. The goldens now show the shipped look, which is not the
// classic one, so only the same-run comparison remains.
import { test, expect } from '@playwright/test';
import { SCENES, CITIES, sceneName, stage } from '../helpers/app.js';
import { openPair, grab, compare } from '../helpers/parity.js';

const LIMIT = 0.02;

test.describe.configure({ timeout: 1_200_000 });

for (const city of CITIES) {
  test(`the ten scenes match the classic renderer: ${city}`, async ({ browser }) => {
    const { legacy, fresh } = await openPair(browser, city);
    const rows = [];
    for (const scene of SCENES.filter((s) => s.city === city)) {
      await stage(legacy, scene);
      await stage(fresh, scene);
      rows.push({ scene: sceneName(scene), classic: compare(await grab(legacy), await grab(fresh)).mad });
    }
    console.log(JSON.stringify(rows));
    test.info().annotations.push({ type: 'parity', description: JSON.stringify(rows) });
    for (const r of rows) {
      expect(r.classic, `${r.scene}: ${(r.classic * 100).toFixed(2)} % from the classic renderer`).toBeLessThanOrEqual(LIMIT);
    }
    expect([...legacy.errors, ...fresh.errors]).toEqual([]);
  });
}

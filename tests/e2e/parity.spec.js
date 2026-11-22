// T2.3: every baseline scene on the new renderer's WebGL2 backend, held at the classic display (ACES, exposure 1,
// no bloom), against the T0.2 goldens and against the classic renderer in the same run: each within 2 % mean
// absolute difference (plan 01, phase 2). The goldens are full-page, so the comparison with them is too; the one
// with the classic renderer is of the canvas alone (capture()). Stays while ?renderer=legacy exists.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { SCENES, CITIES, sceneName, stage } from '../helpers/app.js';
import { ROOT } from '../helpers/staticServer.js';
import { openPair, grab, compare, decodePng, pageShot } from '../helpers/parity.js';

const LIMIT = 0.02;
const golden = (scene) => path.join(ROOT, 'tests/reference/baseline/darwin', `${sceneName(scene)}.png`);

test.describe.configure({ timeout: 1_200_000 });

for (const city of CITIES) {
  test(`the ten scenes match the goldens and the classic renderer: ${city}`, async ({ browser }) => {
    const { legacy, fresh } = await openPair(browser, city);
    const rows = [];
    for (const scene of SCENES.filter((s) => s.city === city)) {
      await stage(legacy, scene);
      await stage(fresh, scene);
      const row = { scene: sceneName(scene), classic: compare(await grab(legacy), await grab(fresh)).mad };
      if (process.platform === 'darwin' && fs.existsSync(golden(scene))) {
        row.golden = compare(await decodePng(fresh, fs.readFileSync(golden(scene))), await pageShot(fresh)).mad;
      }
      rows.push(row);
    }
    console.log(JSON.stringify(rows));
    test.info().annotations.push({ type: 'parity', description: JSON.stringify(rows) });
    for (const r of rows) {
      expect(r.classic, `${r.scene}: ${(r.classic * 100).toFixed(2)} % from the classic renderer`).toBeLessThanOrEqual(LIMIT);
      if (r.golden !== undefined) expect(r.golden, `${r.scene}: ${(r.golden * 100).toFixed(2)} % from its golden`).toBeLessThanOrEqual(LIMIT);
    }
    expect([...legacy.errors, ...fresh.errors]).toEqual([]);
  });
}

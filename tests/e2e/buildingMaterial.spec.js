// T2.2: the TSL building material (src/render/materials/buildingMaterial.js) against night.js's GLSL on the classic
// renderer, in the same run: at the reference night and the classic afternoon, the Strat, the Sphere (an LED skin)
// and a block of low buildings match within 3 % mean absolute difference on the WebGL2 backend (plan 01, phase 2).
import { test, expect } from '@playwright/test';
import { openPair, stageScene, grab, compare } from '../helpers/parity.js';

const REFERENCE_NIGHT = Date.UTC(2026, 2, 19, 5, 0); // new Moon, Sun 37 degrees down (plan 01, 5.6)
const CLASSIC_AFTERNOON = Date.UTC(2026, 2, 23, 23, 8); // the Sun at 245, 32 over Las Vegas
const TARGETS = [
  { name: 'the Strat', target: { id: 'w135457469' }, dist: 1.6 },
  { name: 'the Sphere', target: { id: 'w976405284' }, dist: 2.4 },
  // the densest 300 m cell of low buildings near the Strip, from 400 m
  { name: 'a block of low buildings', target: { point: [-1200, 31.6, -2700] }, dist: 4, elev: 25 },
];
const LIMIT = 0.03;

test.describe.configure({ timeout: 900_000 });

test('the building material matches the classic renderer', async ({ browser }) => {
  const { legacy, fresh } = await openPair(browser, 'lv');
  const rows = [];
  for (const [when, timeMs] of [['reference night', REFERENCE_NIGHT], ['classic afternoon', CLASSIC_AFTERNOON]]) {
    for (const t of TARGETS) {
      const scene = { ...t, timeMs };
      await stageScene(legacy, scene);
      await stageScene(fresh, scene);
      const r = compare(await grab(legacy), await grab(fresh));
      rows.push({ when, what: t.name, ...r });
    }
  }
  console.log(JSON.stringify(rows));
  test.info().annotations.push({ type: 'parity', description: JSON.stringify(rows.map((r) => ({ ...r, mad: +r.mad.toFixed(4) }))) });
  for (const r of rows) expect(r.mad, `${r.what} at the ${r.when}: ${(r.mad * 100).toFixed(2)} % mean absolute difference`).toBeLessThanOrEqual(LIMIT);
  expect([...legacy.errors, ...fresh.errors]).toEqual([]);
});

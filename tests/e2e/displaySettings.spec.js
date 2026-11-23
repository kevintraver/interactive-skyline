// T2.7: Quality, Exposure and Reduce flashes in #settings (plan 01, decision 3), by real input. The detected level is
// shown; each level can be chosen on the WebGL2 backend except Ultra, which is refused with an explanation; the
// choice is kept between visits; the exposure mode and compensation reach the exposure.
import { test, expect } from '@playwright/test';
import { boot } from '../helpers/app.js';

test.describe.configure({ timeout: 600_000 });

test('quality, exposure and reduce flashes', async ({ page }) => {
  await boot(page, 'slc', 'backend=webgl');
  await page.click('#options-toggle');
  const form = page.locator('#settings');
  await expect(form).toBeVisible();
  await expect(page.locator('#quality-out')).toHaveText(/Detected: (Low|High|Ultra)/);
  const detected = await page.evaluate(() => window.__skyline.quality.detected.level);
  await form.getByText('High', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => [window.__skyline.quality.level, window.__skyline.settings.quality])).toEqual(['high', 'high']);
  await expect(page.locator('#quality-out')).toHaveText('High');
  await form.getByText('Ultra', { exact: true }).click();
  await expect(page.locator('#quality-out')).toHaveText(/needs WebGPU/);
  expect(await page.evaluate(() => [window.__skyline.quality.level, window.__skyline.settings.quality])).toEqual(['high', 'high']);
  await expect(form.locator('input[name="quality"][value="high"]')).toBeChecked();
  await form.getByText('Low', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__skyline.quality.level)).toBe('low');
  await form.getByText('As a camera').click();
  await expect.poll(() => page.evaluate(() => window.__skyline.look.exposure.state.mode)).toBe('camera');
  await form.locator('input[name="exposureComp"]').fill('1');
  await form.locator('input[name="exposureComp"]').dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => window.__skyline.look.exposure.state.compensation)).toBe(1);
  await expect(page.locator('#exposure-out')).toHaveText('+1 EV');
  await form.getByText('Reduce flashes').click();
  await expect.poll(() => page.evaluate(() => window.__skyline.settings.reduceFlashes)).toBe(true);
  // kept between visits
  await boot(page, 'slc', 'backend=webgl');
  expect(await page.evaluate(() => ({ q: window.__skyline.quality.level, mode: window.__skyline.look.exposure.state.mode, rf: window.__skyline.settings.reduceFlashes })))
    .toEqual({ q: 'low', mode: 'camera', rf: true });
  await page.click('#options-toggle');
  await page.locator('#settings').getByText('Auto', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__skyline.quality.level)).toBe(detected);
});

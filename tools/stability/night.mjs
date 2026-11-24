// The night and dusk looks, the shipped renderer beside the classic one, on this machine's GPU: the five night
// scenes of the goldens (pinned night, the view buttons) and a dusk sequence of one view per city (the clock state,
// the Sun at +10, +2, -3, -9 and -18 degrees on 21 June). Full-page screenshots at 1280 x 800, as the goldens.
// usage: node tools/stability/night.mjs <out> <baseUrl> [extraQuery] [labels: classic,shipped]
// then:  uv run --python 3.12 --with numpy --with pillow python tools/stability/nightsheet.py <out>
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');
const [out, base, extra = '', labels = 'classic,shipped'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const SCENES = [['lv', 'aerial'], ['lv', 'east'], ['lv', 'strat'], ['slc', 'aerial'], ['slc', 'ensign']];
const DUSK = { lv: 'strat', slc: 'ensign' };
const ALTS = [10, 2, -3, -9, -18];

async function open(city, query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/?city=${city}&${query}${extra}`, { timeout: 180000 });
  await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
  await page.evaluate(() => window.__skyline.attractions.ready);
  await page.addStyleTag({ content: '#tip,#hint{visibility:hidden!important}' });
  return page;
}
const still = (page) => page.waitForFunction(() => { const s = window.__skyline; return s.loop.tier === 'idle' && (!s.look || s.look.exposure.state.settled) && getComputedStyle(document.getElementById('loading')).opacity === '0'; }, null, { timeout: 120000 });

for (const [label, query] of [['classic', 'renderer=legacy'], ['shipped', 'backend=webgl']].filter(([l]) => labels.split(',').includes(l))) {
  for (const city of ['lv', 'slc']) {
    const page = await open(city, query);
    for (const [c, view] of SCENES.filter(([c]) => c === city)) {
      await page.evaluate((view) => { const s = window.__skyline; s.attractions.freeze(47); s.setSetting('night', true); s.setView(view); s.renderer.shadowMap.needsUpdate = true; s.invalidate(); }, view);
      await page.waitForTimeout(800);
      await still(page);
      await page.screenshot({ path: `${out}/${label}-${c}-${view}-night.png` });
    }
    // the day scenes too, to check that a change to the night leaves the day alone
    for (const [c, view] of SCENES.filter(([c]) => c === city)) {
      await page.evaluate((view) => { const s = window.__skyline; s.setSetting('night', false); s.setView(view); s.renderer.shadowMap.needsUpdate = true; s.invalidate(); }, view);
      await page.waitForTimeout(800);
      await still(page);
      await page.screenshot({ path: `${out}/${label}-${c}-${view}-day.png` });
    }
    // dusk: find the minute on 21 June at which the Sun stands at each altitude, after noon
    await page.evaluate((view) => { const s = window.__skyline; s.setView(view); s.env.enterClock(); }, DUSK[city]);
    for (const alt of ALTS) {
      await page.evaluate((alt) => {
        const s = window.__skyline;
        let best = null;
        for (let m = 12 * 60; m < 24 * 60; m += 1) {
          s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: Math.floor(m / 60), minute: m % 60 });
          s.env.update();
          const a = s.env.state.sun.altDeg;
          if (best === null || Math.abs(a - alt) < best.d) best = { m, d: Math.abs(a - alt) };
          if (a < alt - 1) break;
        }
        s.clock.setLocal({ year: 2026, month: 6, day: 21, hour: Math.floor(best.m / 60), minute: best.m % 60 });
        s.renderer.shadowMap.needsUpdate = true;
        s.invalidate();
      }, alt);
      await page.waitForTimeout(800);
      await still(page);
      await page.screenshot({ path: `${out}/${label}-${city}-${DUSK[city]}-dusk${alt}.png` });
    }
    await page.close();
  }
}
await browser.close();
console.log('saved in', out);

// T2.9: the landmark skill's checker against the new renderer (plan 01, section 3.3). Runs the skill's own `check`
// (it serves src/ with no bundler through an import map that now includes three/webgpu and three/tsl, runs headless
// Chromium with --headless=new --enable-unsafe-swiftshader --ignore-gpu-blocklist --virtual-time-budget=45000
// --screenshot, and makes the probe's calls by day and by night) for one building model, one extra and the fountain,
// with the browser the tool finds itself (Chrome or Edge, as for its users; Playwright's Chrome for Testing does not
// exit after --screenshot in this mode, measured 22 November 2026). Each must load, report OK, choose the WebGL2
// backend, and write pictures that are not blank. Skipped where the machine has neither browser.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { ROOT } from '../helpers/staticServer.js';

const TOOL = '.claude/skills/blender-landmark-model/scripts/skyline_tool.py';
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const BROWSERS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
const browser = process.env.BROWSER_BIN || BROWSERS.find((b) => fs.existsSync(b));
// a fountain show has no GLB, so the tool prints no `loaded` line for it
const CASES = [
  { name: 'a building model (the Strat)', args: ['--city', 'lv', '--id', 'w135457469'], glb: true },
  { name: 'an extra (the High Roller)', args: ['--city', 'lv', '--extra', 'High Roller'], glb: true },
  { name: 'the fountain', args: ['--city', 'lv', '--extra', 'Fountains of Bellagio'], glb: false },
];

test.describe.configure({ timeout: 900_000 });

for (const c of CASES) {
  test(`check: ${c.name}`, async ({ page }, testInfo) => {
    test.skip(!python, 'no python');
    test.skip(!browser, 'no Chrome or Edge for the checker');
    const out = testInfo.outputPath('check');
    const r = spawnSync(python, [TOOL, 'check', '--repo', ROOT, ...c.args, '--out', out, '--browser', browser],
      { cwd: ROOT, encoding: 'utf8', timeout: 800_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    console.log(text.split('\n').filter((l) => /loaded|OK|FAIL|error|backend/i.test(l)).join('\n'));
    expect(r.status, text).toBe(0);
    if (c.glb) expect(text).toMatch(/loaded = True/);
    expect(text).toMatch(/^OK$/m);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'check.json'), 'utf8'));
    expect(report.probe.backend, 'the backend the app chose').toBe('webgl2');
    // every picture has contrast (a blank or black frame fails even when the probe says OK)
    const shots = fs.readdirSync(out).filter((f) => f.endsWith('.png'));
    expect(shots.length).toBeGreaterThanOrEqual(2);
    for (const f of shots) {
      const stats = await page.evaluate(async (b64) => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (x) => x.charCodeAt(0))], { type: 'image/png' }));
        const c2 = new OffscreenCanvas(64, 40), g = c2.getContext('2d');
        g.drawImage(bmp, 0, 0, 64, 40);
        const px = g.getImageData(0, 0, 64, 40).data;
        let lo = 255, hi = 0, sum = 0;
        for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; lo = Math.min(lo, l); hi = Math.max(hi, l); sum += l; }
        return { range: hi - lo, mean: sum / (px.length / 4) };
      }, fs.readFileSync(path.join(out, f)).toString('base64'));
      expect(stats.range, `${f} has contrast`).toBeGreaterThan(40);
      expect(stats.mean, `${f} is not black`).toBeGreaterThan(8);
    }
  });
}

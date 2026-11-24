// Where a software-rendered frame's time goes: the app on SwiftShader, as the e2e suite runs it, with the native
// stacks of the browser's GPU and renderer processes sampled (macOS `sample`, the stand-in for pstack) while it
// boots and while it draws frames back to back.
//   node tools/stability/sw-sample.mjs <out> <baseUrl> <city> [extraQuery] [seconds]
// Writes <out>/boot-gpu.txt, boot-renderer.txt, frames-gpu.txt, frames-renderer.txt and prints the frame time.
// Read the "Call graph" and the "Sort by top of stack" sections of each file.
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');

const [out, base, city, extra = '', secondsArg] = process.argv.slice(2);
const SECONDS = Number(secondsArg || 10);
fs.mkdirSync(out, { recursive: true });
const SOFTWARE = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--use-gl=angle'];
const server = await chromium.launchServer({ args: SOFTWARE });
const browser = await chromium.connect(server.wsEndpoint());
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

/** The browser's child processes by type ('gpu-process', 'renderer'); the renderer that is busiest. */
function children() {
  const rows = execFileSync('ps', ['-Ao', 'pid,ppid,pcpu,args']).toString().split('\n').map((l) => l.trim().split(/\s+/));
  const mine = rows.filter((r) => Number(r[1]) === server.process().pid);
  const of = (type) => mine.filter((r) => r.includes(`--type=${type}`)).sort((a, b) => Number(b[2]) - Number(a[2])).map((r) => Number(r[0]));
  return { gpu: of('gpu-process')[0], renderer: of('renderer')[0] };
}
const sample = (pid, seconds, file) => new Promise((done) => {
  if (!pid) return done();
  spawn('sample', [String(pid), String(seconds), '-file', file, '-mayDie'], { stdio: 'ignore' }).on('exit', done);
});

await page.goto('about:blank');
let c = children();
// boot: sample both while the app loads
const bootSamples = Promise.all([sample(c.gpu, SECONDS, `${out}/boot-gpu.txt`), sample(c.renderer, SECONDS, `${out}/boot-renderer.txt`)]);
const t0 = Date.now();
await page.goto(`${base}/?city=${city}${extra}`, { timeout: 600000 });
await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 600000 });
await page.evaluate(() => window.__skyline.attractions.ready);
await page.waitForFunction(() => performance.getEntriesByName('skyline-frame').length > 0, null, { timeout: 600000 });
const marks = await page.evaluate(() => ({ ready: performance.getEntriesByName('skyline-ready')[0].startTime, frame: performance.getEntriesByName('skyline-frame')[0].startTime, backend: window.__skyline.backend || 'webgl (classic)' }));
console.log(`boot: ready ${marks.ready.toFixed(0)} ms, first frame ${marks.frame.toFixed(0)} ms, wall ${Date.now() - t0} ms, ${marks.backend}`);
await bootSamples;

// frames: draw back to back for SECONDS while sampling
await page.evaluate(() => window.__skyline.attractions.freeze(47));
c = children();
const frameSamples = Promise.all([sample(c.gpu, SECONDS, `${out}/frames-gpu.txt`), sample(c.renderer, SECONDS, `${out}/frames-renderer.txt`)]);
const r = await page.evaluate(async (ms) => {
  const s = window.__skyline, times = [];
  const end = performance.now() + ms;
  let last = performance.now();
  while (performance.now() < end) {
    s.invalidate();
    await new Promise((done) => requestAnimationFrame(done));
    const now = performance.now(); times.push(now - last); last = now;
  }
  times.sort((a, b) => a - b);
  return { frames: times.length, median: times[times.length >> 1], max: times[times.length - 1] };
}, SECONDS * 1000);
console.log(`frames: ${r.frames} in ${SECONDS} s, median ${r.median.toFixed(0)} ms, slowest ${r.max.toFixed(0)} ms`);
await frameSamples;
await browser.close();
await server.close();

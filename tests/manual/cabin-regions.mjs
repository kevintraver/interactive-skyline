// The cabin's parity by region (plan 02, third stretch): drive-parity.mjs compares whole frames, where a mirror or a
// display is a few percent of the pixels and a wrong mirror image hides under the frame's limit. This reads a
// drive-parity.mjs output directory and the shots file it ran, and compares the named regions of each shot (a mirror's
// glass, a display) between the classic frame and each backend's. The exit code is the verdict: 0 when every region
// passes.
//
//   node tests/manual/drive-parity.mjs --port 5323 --out <dir> --shots <shots.json>
//   node tests/manual/cabin-regions.mjs --dir <dir> --shots <shots.json> [--limit 3]
//
// A shot's `regions` is { name: [x0, y0, x1, y1] } in pixels of the 1280 x 720 frame, and `regionLimit` (percent, with
// a `regionReason`) replaces the default for that shot. Reads only the PNGs drive-parity.mjs writes (8-bit RGBA, filter 0).
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const dir = opt('dir');
const shotsArg = opt('shots');
const defaultLimit = Number(opt('limit', 3));
if (!dir || !shotsArg) { console.error('usage: cabin-regions.mjs --dir <parity output> --shots <shots.json>'); process.exit(2); }
const shots = JSON.parse(existsSync(shotsArg) ? readFileSync(shotsArg, 'utf8') : shotsArg);

/** The RGBA pixels of a PNG drive-parity.mjs wrote. */
function readPng(file) {
  const b = readFileSync(file);
  let p = 8, w = 0, h = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 6) throw new Error(`${file}: not 8-bit RGBA`); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error(`${file}: filtered rows are not read here`);
    raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  }
  return { w, h, px };
}

function regionMad(a, b, [x0, y0, x1, y1]) {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * a.w + x) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(a.px[i + c] - b.px[i + c]);
    n++;
  }
  return (sum / (n * 3 * 255)) * 100;
}

let failed = 0, rows = 0;
for (const shot of shots) {
  if (!shot.regions) continue;
  const ref = join(dir, `${shot.name}.classic.png`);
  if (!existsSync(ref)) { console.log(`${shot.name}: no classic frame`); failed++; continue; }
  const a = readPng(ref);
  for (const backend of ['webgl', 'webgpu']) {
    const f = join(dir, `${shot.name}.${backend}.png`);
    if (!existsSync(f)) continue;
    const b = readPng(f);
    const limit = shot.regionLimit ?? defaultLimit;
    for (const [name, box] of Object.entries(shot.regions)) {
      const mad = regionMad(a, b, box);
      const pass = mad <= limit;
      rows++;
      if (!pass) failed++;
      console.log(`${shot.name.padEnd(24)} ${backend.padEnd(7)} ${name.padEnd(12)} ${mad.toFixed(2).padStart(6)} %  (limit ${limit} %)  ${pass ? 'PASS' : 'FAIL'}${shot.regionReason ? `  [${shot.regionReason}]` : ''}`);
    }
  }
}
console.log(`\n${rows} regions, ${failed} failed`);
process.exit(failed ? 1 : 0);

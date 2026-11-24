// Parity of the traffic and valley parts between the classic renderer and plan 01's (plan 02, third stretch, decision
// 1), measured where the part draws, as screens-parity.mjs does for the screens: the parity tool (drive-parity.mjs)
// runs each shot with the part and with `parts=none`, and only the pixels the part changes on the classic renderer
// are compared:
//   mask      the pixels where the classic renderer's frame with the part differs from its frame without it by more
//             than MASK_STEP (of 765, summed over R, G, B): the vehicles, their shadows, lamps, ribbons
//   masked    the mean absolute difference over the mask between the classic frame and the new renderer's, percent
//   missing   the share of the mask where the new frame is nearer the classic frame without the part than with it
// A shot passes when the mask is not empty, masked <= its limit and missing <= its missing limit.
//
// Shots: three places per route, by day (the default limits) and at night (their own limits, with the reason: the
// classic renderer tone-mapped each lamp sprite on its own and blended it after tone mapping; plan 01's adds the
// sprites' light before its tone mapping, so a lamp's pixels cannot match, only its place).
//
// Serve the repository first, then:
//   node tests/manual/traffic-parity.mjs [--port 5325] [--out <dir outside the repo>] [--backends webgl,webgpu]
//        [--only <name,...>] [--times day,night]
// The exit code is the verdict.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = opt('port', '5325');
const out = opt('out', `/private/tmp/traffic-parity-${Date.now()}`);
const backends = opt('backends', 'webgl,webgpu');
const only = opt('only', null)?.split(',');
const times = opt('times', 'day,night').split(',');
const MASK_STEP = 24;
const MISSING_MAX = 2; // percent of the mask
const LIMIT = 6; // percent, masked
const SPRITES = 'lamp sprites: the classic renderer tone-mapped each and blended it after tone mapping, plan 01 adds their light before';

// three places per route: traffic near ahead, an interchange's traffic farther out, and a view across the carriageways
const PLACES = [
  { name: 'i15n-near', route: 'i15n', s: 52000, look: { lens: 35 } },
  { name: 'i15n-far', route: 'i15n', s: 30000, look: { lens: 85 } },
  { name: 'i15n-across', route: 'i15n', s: 61000, look: { yaw: -25, lens: 35 } },
  { name: 'i15s-near', route: 'i15s', s: 20000, look: { lens: 35 } },
  { name: 'i15s-far', route: 'i15s', s: 33000, look: { lens: 85 } },
  // measured 2.21 % missing on WebGPU only (75 of 3,390 mask pixels, the wheels and edges of three vehicles at the left
  // edge of the frame, each in place): its 4x multisampling covers small shapes with other samples than WebGL2's
  // (traffic-node.html found the same in isolation)
  { name: 'i15s-across', route: 'i15s', s: 36500, look: { yaw: -25, lens: 35 }, missingMax: 3, reason: 'WebGPU multisampling at small vehicles\' edges' },
  { name: 'us93-near', route: 'us93', s: 30000, look: { lens: 35 } },
  { name: 'us93-far', route: 'us93', s: 40000, look: { lens: 85 } },
  { name: 'us93-across', route: 'us93', s: 47000, look: { yaw: -25, lens: 35 } },
];
const PART_SETS = ['traffic', 'valley'];
const NIGHT = { limit: 25, missingMax: 25, reason: SPRITES };
const SHOTS = PART_SETS.flatMap((parts) => PLACES.flatMap((p) => times.map((t) => ({ ...p, parts, name: `${parts}-${p.name}-${t}`, t, ...(t === 'night' ? { ...NIGHT, missingMax: Math.max(NIGHT.missingMax, p.missingMax ?? 0) } : {}) }))))
  // the valley's ribbons are off by day on the classic renderer: nothing to compare
  .filter((s) => !(s.parts === 'valley' && s.t === 'day'))
  .filter((s) => !only || only.includes(s.name));

const toolShots = [...PART_SETS, 'none'].flatMap((set) => SHOTS.flatMap((s) => {
  const base = { route: s.route, s: s.s, t: s.t, view: 'clean', look: s.look };
  if (set === 'none') return [{ ...base, name: `${s.name}.none`, parts: 'none', limit: 100 }];
  return s.parts === set ? [{ ...base, name: s.name, parts: s.parts, limit: 100 }] : [];
}));
mkdirSync(out, { recursive: true });
const shotFile = join(out, 'tool-shots.json');
writeFileSync(shotFile, JSON.stringify(toolShots, null, 1));
const tool = join(dirname(fileURLToPath(import.meta.url)), 'drive-parity.mjs');
const run = !toolShots.length ? { stdout: '', stderr: '' } : spawnSync(process.execPath, [tool, '--port', port, '--out', out, '--shots', shotFile, '--backends', backends], { encoding: 'utf8', maxBuffer: 1 << 26 });
writeFileSync(join(out, 'tool.log'), `${run.stdout}\n${run.stderr}`);

/** RGBA pixels of a PNG written by drive-parity.mjs (8-bit RGBA, filter 0 on every row). */
function readPng(file) {
  const buf = readFileSync(file);
  let w = 0, h = 0;
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12); }
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error(`${file}: row filter ${raw[y * (w * 4 + 1)]}, expected 0`);
    raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  }
  return { w, h, px };
}

/** An RGBA PNG (filter 0 rows) of a 1280 x 720 frame, as drive-parity.mjs writes them. */
function pngOf(rgba, w = 1280, h = 720) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dist = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
function measure(ref, none, got) {
  let n = 0, sum = 0, missing = 0, all = 0;
  for (let i = 0; i < ref.length; i += 4) {
    const d = dist(ref, got, i);
    all += d;
    if (dist(ref, none, i) <= MASK_STEP) continue;
    n++;
    sum += d;
    if (dist(got, none, i) < d) missing++;
  }
  const px = ref.length / 4;
  return { maskPx: n, masked: n ? (sum / (n * 765)) * 100 : 0, missing: n ? (missing / n) * 100 : 0, whole: (all / (px * 765)) * 100 };
}

const rows = [];
let failed = 0;
console.log(`out: ${out}\n`);
console.log('shot                       backend   mask px   masked %  missing %  whole %   verdict');
for (const s of SHOTS) {
  const f = (name, r) => join(out, `${name}.${r}.png`);
  if (!existsSync(f(s.name, 'classic')) || !existsSync(f(`${s.name}.none`, 'classic'))) {
    console.log(`${s.name.padEnd(26)} classic   no picture (see ${join(out, 'tool.log')})`); failed++; continue;
  }
  const ref = readPng(f(s.name, 'classic')).px, none = readPng(f(`${s.name}.none`, 'classic')).px;
  for (const b of backends.split(',')) {
    if (!existsSync(f(s.name, b))) { console.log(`${s.name.padEnd(26)} ${b.padEnd(8)}  no picture`); failed++; rows.push({ shot: s.name, backend: b, error: 'no picture' }); continue; }
    const m = measure(ref, none, readPng(f(s.name, b)).px);
    const limit = s.limit ?? LIMIT;
    const missingMax = s.missingMax ?? MISSING_MAX;
    const pass = m.maskPx > 0 && m.masked <= limit && m.missing <= missingMax;
    if (!pass) failed++;
    rows.push({ shot: s.name, backend: b, ...m, limit, pass, reason: s.reason });
    console.log(`${s.name.padEnd(26)} ${b.padEnd(8)} ${String(m.maskPx).padStart(8)}  ${m.masked.toFixed(2).padStart(8)}  ${m.missing.toFixed(2).padStart(9)}  ${m.whole.toFixed(2).padStart(7)}   ${pass ? 'PASS' : 'FAIL'} (limits ${limit} %, missing ${missingMax} %)${s.reason ? `  [${s.reason}]` : ''}`);
  }
}
writeFileSync(join(out, 'traffic-parity.json'), JSON.stringify({ rows, failed }, null, 1));
console.log(`\n${rows.length} comparisons, ${failed} failed; images in ${out}`);
process.exit(failed ? 1 : 0);

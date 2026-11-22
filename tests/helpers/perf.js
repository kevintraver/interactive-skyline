// Shared by the performance specs (plan 01, section 8.7, T0.8).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './staticServer.js';

export const PERF_DIR = path.join(ROOT, 'tests/reference/perf');
export const BUDGETS = path.join(PERF_DIR, 'budgets.json');
/** SKYLINE_PERF_UPDATE=1 rewrites the budget file (deterministic tier) or this machine's baseline (timing tier). */
export const UPDATING = !!process.env.SKYLINE_PERF_UPDATE;
/** Sizes may grow this much over the committed budget before the suite fails. */
export const SIZE_GROWTH = 1.03;
/** Timing gates against this machine's baseline: median and 95th percentile; on a software rasterizer, both 2x. */
export const GATES = { median: 1.15, p95: 1.25, software: 2 };
/** Single-sample timings (time to ready, an edit's frame) also get this much absolute slack: one 60 Hz frame. */
export const FRAME_SLACK_MS = 17;

export const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
/** Read-modify-write one key path of a JSON file (the update runs use one worker, so this does not race). */
export function writeJsonAt(file, keys, value) {
  const doc = readJson(file, {});
  let at = doc;
  for (const k of keys.slice(0, -1)) at = at[k] = at[k] || {};
  at[keys[keys.length - 1]] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sortKeys(doc), null, 2)}\n`);
}
const sortKeys = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

export function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (v) => quantile(v, 0.5);
export const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** A machine id with nothing personal in it: the GPU's renderer string and the core count, as a slug. */
export function machineId({ renderer }, cores) {
  const slug = renderer.toLowerCase().replace(/\bangle\b|\(|\)|,|unspecified version|direct3d11|vs_5_0|ps_5_0/g, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug}-${cores}c`;
}

/** Gzipped size (level 9) of every JS and CSS file `vite build` wrote to dist/assets. */
export function bundleSizes() {
  const dir = path.join(ROOT, 'dist/assets');
  const out = { js: 0, css: 0, jsRaw: 0, cssRaw: 0, chunks: {} };
  for (const f of fs.readdirSync(dir)) {
    const kind = f.endsWith('.js') ? 'js' : f.endsWith('.css') ? 'css' : null;
    if (!kind) continue;
    const buf = fs.readFileSync(path.join(dir, f)), gz = zlib.gzipSync(buf, { level: 9 }).length;
    out[kind] += gz;
    out[`${kind}Raw`] += buf.length;
    out.chunks[f.replace(/-[\w-]{8}\.(js|css)$/, '.$1')] = gz; // name without the content hash
  }
  return out;
}

/** In the page: render-loop edits, each timed from the call to the GPU finishing the frame that shows it. */
export const EDIT_LATENCY = async () => {
  const s = window.__skyline, gl = s.renderer.getContext();
  const nextFrames = (n) => new Promise((done) => { const step = () => (n-- <= 0 ? done() : requestAnimationFrame(step)); requestAnimationFrame(step); });
  const timed = async (action) => {
    await nextFrames(3);
    const target = s.perf.frames() + 1, t0 = performance.now();
    action();
    await new Promise((done) => { const check = () => (s.perf.frames() >= target ? done() : requestAnimationFrame(check)); requestAnimationFrame(check); });
    gl.finish();
    return performance.now() - t0;
  };
  const undo = () => dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true }));
  const out = { hide: [], undo: [], move: [], rebuild: [] };
  const cutoff = s.settings.cutoff;
  for (let i = 0; i < 5; i++) {
    const e = s.tall[2 + i];
    s.select(e.data.id);
    out.hide.push(await timed(() => document.querySelector('#card [data-act="hide"]').click()));
    out.undo.push(await timed(undo));
    // as a drag does: place, redraw the shadows, ask for a frame
    out.move.push(await timed(() => { s.place(e, 40, -30); s.renderer.shadowMap.needsUpdate = true; s.invalidate(); }));
    s.place(e, 0, 0);
    out.rebuild.push(await timed(() => s.setSetting('cutoff', cutoff + 5 + i)));
    s.setSetting('cutoff', cutoff);
  }
  return out;
};

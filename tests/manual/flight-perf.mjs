// Fly mode measured against plan 03, section 9 (task F8.2), on this machine's GPU, in a production build.
//
// For each flight (default lv-19-dusk, lv-19-night, lv-wx) at cruise, 18,000 ft, 10,000 ft, 60 s out, the threshold and
// the rollout (20 s after touchdown), and for Orbit's three presets, on each backend at 1280 x 800 (the plan's
// reference viewport, as every spec here uses):
//   frame      the whole frame: perf.throughput (frames drawn back to back, not capped by vsync; plan 01's method on
//              ANGLE Metal) and, on WebGPU, the GPU's own time (timestamp queries summed over the frame's passes)
//   parts      each part switched off in turn (terrain, the map's ground, the map's city, the airport, the night ground,
//              the airframe, the clouds, the cabin stage, the glass alone): the draws, triangles and frame time it
//              takes, the minimum of `--rounds` rounds (under contention the least time is the part's own cost)
//   js         the flight's own JavaScript per frame while playing (__skyline.flight.stats().layerMs over 250 frames)
//   memory     the GPU memory three.js tracks (renderer.info.memory, bytes) and, per part, the bytes of its geometry and
//              textures; the JavaScript heap after a collection
//   entry      the first entry of each backend's page: requests and bytes from the click to the settled first frame, the
//              time to the first flight frame and to settled
//   pictures   a PNG of every moment with the interface hidden, before any playing (so blinking lamps are in the same
//              phase in two runs), to compare a build before a change with one after (--compare <other run>)
// The machine's load (os.loadavg) is recorded with each scenario.
//
// Serve a build first:  pnpm build --outDir dist-perf && pnpm exec vite preview --outDir dist-perf --host 127.0.0.1 --port 5471 --strictPort
// then:                 node tests/manual/flight-perf.mjs <out> [--port 5471] [--backend webgpu|webgl2]
//                         [--flights lv-19-dusk,lv-19-night,lv-wx] [--moments cruise,threshold] [--orbits overhead,valley,strip]
//                         [--rounds 2] [--no-parts] [--no-js] [--no-shots]
//                       node tests/manual/flight-perf.mjs --compare <runA> <runB>   (pixel differences of the pictures)
// From a normal shell on macOS (a sandboxed one gives the browser software rendering).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const VALUED = ['--port', '--backend', '--flights', '--moments', '--orbits', '--rounds', '--compare'];
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));

const loadNow = () => os.loadavg().map((v) => +v.toFixed(2));

// ------------------------------------------------------------------------------------------------- compare mode
if (args.includes('--compare')) {
  const a = opt('--compare'), b = positional[0];
  if (!a || !b) { console.error('usage: node tests/manual/flight-perf.mjs --compare <runA> <runB>'); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = {};
  for (const backend of ['webgpu', 'webgl2']) {
    const da = path.join(a, backend, 'shots'), db = path.join(b, backend, 'shots');
    if (!existsSync(da) || !existsSync(db)) continue;
    for (const f of readdirSync(da).filter((n) => n.endsWith('.png'))) {
      if (!existsSync(path.join(db, f))) continue;
      const r = await page.evaluate(async ({ a64, b64 }) => {
        const load = async (s) => {
          const bytes = Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
          g.drawImage(bmp, 0, 0);
          return { w: bmp.width, h: bmp.height, px: g.getImageData(0, 0, bmp.width, bmp.height).data };
        };
        const [A, B] = await Promise.all([load(a64), load(b64)]);
        if (A.w !== B.w || A.h !== B.h) return { size: 'differs' };
        const n = A.px.length / 4;
        let any = 0, over8 = 0, over32 = 0, max = 0;
        for (let i = 0; i < A.px.length; i += 4) {
          const d = Math.max(Math.abs(A.px[i] - B.px[i]), Math.abs(A.px[i + 1] - B.px[i + 1]), Math.abs(A.px[i + 2] - B.px[i + 2]));
          if (d > 0) any++;
          if (d > 8) over8++;
          if (d > 32) over32++;
          if (d > max) max = d;
        }
        return { differing: +(any / n).toFixed(6), over8: +(over8 / n).toFixed(6), over32: +(over32 / n).toFixed(6), max };
      }, { a64: readFileSync(path.join(da, f)).toString('base64'), b64: readFileSync(path.join(db, f)).toString('base64') });
      (report[backend] ??= {})[f] = r;
      console.log(backend, f, JSON.stringify(r));
    }
  }
  writeFileSync(path.join(b, 'compare.json'), `${JSON.stringify({ a, b, report }, null, 1)}\n`);
  await browser.close();
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------- measuring
const out = positional[0];
if (!out) { console.error('usage: node tests/manual/flight-perf.mjs <out> [--port 5471] [--backend webgpu|webgl2] ...'); process.exit(2); }
const port = opt('--port') || 5471;
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu', 'webgl2'];
const ROUNDS = Number(opt('--rounds') || 2);
const ids = (opt('--flights') || 'lv-19-dusk,lv-19-night,lv-wx').split(',').filter(Boolean);
const onlyMoments = opt('--moments') ? opt('--moments').split(',') : null;
const orbits = (opt('--orbits') ?? 'overhead,valley,strip').split(',').filter(Boolean);
const PARTS = !args.includes('--no-parts'), JS = !args.includes('--no-js'), SHOTS = !args.includes('--no-shots');

/** The moments of one flight, seconds from its start (flight-mode-shots.mjs's names), from the header the build serves. */
async function momentsOf(id) {
  const header = await (await fetch(`http://127.0.0.1:${port}/data/lv/flights/${id}.json`)).json();
  const ev = (k) => header.events.find((e) => e.id === k)?.t;
  const td = ev('touchdown');
  const m = { cruise: 0, fl180: ev('fl180'), ft10000: ev('10000'), 'sixty-out': td - 60, threshold: ev('threshold'), rollout: Math.min(header.samples - 1, td + 20) };
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => Number.isFinite(v) && (!onlyMoments || onlyMoments.includes(k))));
}
const PRESETS = { overhead: { altitudeFt: 35000, radiusKm: 31 }, valley: { altitudeFt: 12000, radiusKm: 9 }, strip: { altitudeFt: 6500, radiusKm: 5 } };

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--js-flags=--expose-gc', '--enable-precise-memory-info',
    // as playwright.config.js: no weather service is reached
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
const hideUi = () => {
  const canvas = document.querySelector('canvas');
  for (const el of document.body.children) if (!el.contains(canvas)) el.dataset.shotHidden = el.style.visibility = 'hidden';
};
const showUi = () => { for (const el of document.body.querySelectorAll('[data-shot-hidden]')) { el.style.visibility = ''; delete el.dataset.shotHidden; } };

/** Installed in the page: the measuring helpers (window.__perfF8). */
function installHelpers() {
  const s = window.__skyline, f = s.flight, R = s.renderer;
  const byName = (n) => s.scene.getObjectByName(n);
  const meshTris = (o) => { const g = o.geometry; return g ? (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3 : 0; };
  /** The map's own parts, found by their shape (main.js does not name them): the ground meshes over a million
   * triangles, the merged low-rise, the removable towers' group, the attractions. */
  function mapParts() {
    const ground = [], city = [];
    for (const c of s.scene.children) {
      if (c.isMesh && !c.name && meshTris(c) > 1e6) ground.push(c);
      else if (c.isMesh && !c.name && meshTris(c) > 1e5) city.push(c);
      else if (c.isGroup && !c.name && c.children.length > 50) city.push(c);
      else if (c.name === 'attractions') city.push(c);
    }
    return { ground, city };
  }
  const groups = () => {
    const m = mapParts();
    return {
      terrain: [byName('flight-region-terrain')],
      mapGround: m.ground,
      mapCity: m.city,
      airport: [byName('airport'), byName('flight airport ground')],
      night: [byName('flight-night-ground')],
      airframe: [byName('flight-body')],
      clouds: [byName('flight-clouds')],
    };
  };
  /** The night ground's own parts (lamps, traffic, obstruction lights), each as `night/<name>`. */
  const nightKids = () => (byName('flight-night-ground')?.children ?? []).map((c, i) => [`night/${c.name || i}`, c]);
  /** Switch a part off (true) or back to how it was. */
  const was = new Map();
  function off(part, on) {
    if (part === 'cabinStage') { f.window({ stage: !on }); return; }
    if (part === 'glass') { f.window({ glass: !on }); return; }
    const list = part.startsWith('night/') ? [Object.fromEntries(nightKids())[part]] : groups()[part];
    for (const o of list.filter(Boolean)) {
      if (on) { was.set(o, o.visible); o.visible = false; } else if (was.has(o)) { o.visible = was.get(o); was.delete(o); }
    }
  }
  /** One frame's counts, the counters reset first (three resets them per animation frame, not per render). */
  function count() {
    R.info.reset();
    s.pipeline.render();
    const r = R.info.render;
    return { draws: r.drawCalls, triangles: Math.round(r.triangles), points: r.points, lines: r.lines };
  }
  const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
  async function time({ frames = 30, gpuFrames = 20 } = {}) {
    const tp = await s.perf.throughput(frames, 6);
    let gpu = null;
    if (s.backend === 'webgpu') {
      const r = await s.perf.renderFrames(gpuFrames, 4);
      gpu = r.method === 'gpu-timestamp' ? med(r.ms) : null;
    }
    return { ms: +tp.msPerFrame.toFixed(3), gpuMs: gpu === null ? null : +gpu.toFixed(3) };
  }
  /** Bytes of a part's geometry (every attribute and index once) and textures (found on its materials and their nodes). */
  function bytes(roots) {
    const attrs = new Set(), texs = new Set(), seen = new Set();
    const scan = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 6 || seen.has(v)) return;
      seen.add(v);
      if (v.isTexture) { texs.add(v); return; }
      if (v.isObject3D || v.isBufferGeometry || ArrayBuffer.isView(v)) return;
      for (const k of Object.keys(v)) { if (k === 'parent' || k === 'children' || k.startsWith('_')) continue; try { scan(v[k], depth + 1); } catch { /* getter */ } }
    };
    for (const r of roots.filter(Boolean)) r.traverse((o) => {
      const g = o.geometry;
      if (g) { for (const a of Object.values(g.attributes)) attrs.add(a.isInterleavedBufferAttribute ? a.data : a); if (g.index) attrs.add(g.index); }
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) scan(m, 0);
    });
    let geo = 0, cpuGeo = 0;
    for (const a of attrs) { const n = (a.count ?? 0) * (a.itemSize ?? a.stride ?? 1) * (a.array?.BYTES_PER_ELEMENT ?? 4); geo += a.array ? a.array.byteLength : n; if (a.array && a.array.length) cpuGeo += a.array.byteLength; }
    let tex = 0;
    for (const t of texs) {
      const img = t.image, w = img?.width ?? 0, h = img?.height ?? 0, d = img?.depth ?? 1;
      const bpp = t.type === 1016 /* HalfFloat */ ? 8 : t.type === 1015 /* Float */ ? 16 : 4;
      tex += w * h * d * bpp * (t.generateMipmaps !== false && t.minFilter >= 1007 ? 4 / 3 : 1);
    }
    return { geometryMB: +(geo / 2 ** 20).toFixed(2), cpuArraysMB: +(cpuGeo / 2 ** 20).toFixed(2), texturesMB: +(tex / 2 ** 20).toFixed(2), textures: texs.size };
  }
  function memory() {
    if (window.gc) window.gc();
    const m = R.info.memory;
    return { gpuTotalMB: +(m.total / 2 ** 20).toFixed(1), texturesMB: +(m.texturesSize / 2 ** 20).toFixed(1), attributesMB: +((m.attributesSize + m.indexAttributesSize) / 2 ** 20).toFixed(1),
      textures: m.textures, geometries: m.geometries, renderTargets: m.renderTargets, jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(1) : null };
  }
  const nextFrames = (n) => new Promise((done) => { const step = () => (n-- <= 0 ? done() : requestAnimationFrame(step)); requestAnimationFrame(step); });
  window.__perfF8 = { groups, off, count, time, bytes, memory, nextFrames, nightKids,
    get PART_NAMES() { return ['terrain', 'mapGround', 'mapCity', 'airport', 'night', ...nightKids().map(([k]) => k), 'airframe', 'clouds', 'cabinStage', 'glass']; } };
}

/** Measure the view as it stands: counts, frame time, each part off, memory. */
async function measureHere(page) {
  return page.evaluate(async ({ rounds, parts }) => {
    const P = window.__perfF8, f = window.__skyline.flight, st = f.state(), stats = f.stats();
    const base = P.count(), names = P.PART_NAMES;
    const times = { base: [] }, counts = {};
    for (let r = 0; r < rounds; r++) {
      times.base.push(await P.time());
      if (!parts) continue;
      for (const p of names) {
        P.off(p, true);
        if (r === 0) counts[p] = P.count();
        (times[p] ??= []).push(await P.time());
        P.off(p, false);
      }
    }
    times.base.push(await P.time());
    const least = (a, k) => Math.min(...a.map((x) => x[k]).filter((v) => v !== null && Number.isFinite(v)));
    const baseMs = least(times.base, 'ms'), baseGpu = least(times.base, 'gpuMs');
    const part = {};
    if (parts) {
      for (const p of names) {
        const ms = least(times[p], 'ms'), gpu = least(times[p], 'gpuMs');
        part[p] = { draws: base.draws - counts[p].draws, triangles: base.triangles - counts[p].triangles,
          ms: +(baseMs - ms).toFixed(3), gpuMs: Number.isFinite(gpu) ? +(baseGpu - gpu).toFixed(3) : null };
      }
      const g = P.groups();
      for (const p of Object.keys(g)) part[p].memory = P.bytes(g[p]);
      for (const [k, o] of P.nightKids()) if (part[k]) part[k].memory = P.bytes([o]);
    }
    const region = stats.world.region, ground = stats.world.ground;
    return {
      t: st.t, altMsl: Math.round(st.altMsl), heightAboveGround: Math.round(st.heightAboveGround), far: Math.round(window.__skyline.camera.far),
      sunAltDeg: window.__skyline.env.state?.sun?.altDeg != null ? +window.__skyline.env.state.sun.altDeg.toFixed(1) : null,
      frame: { ...base, ms: baseMs, gpuMs: Number.isFinite(baseGpu) ? baseGpu : null, samples: times.base },
      parts: part,
      region: { needed: region.needed, drawCalls: region.drawCalls, triangles: region.triangles, cpuMs: region.cpuMs, grids: region.grids },
      airport: stats.world.airport && { drawCalls: stats.world.airport.drawCalls, lights: stats.world.airport.lights, night: stats.world.airport.night },
      lamps: ground?.lamps ? { drawn: ground.lamps.drawn, inView: ground.lamps.lampsInView, cellsDrawn: ground.lamps.cellsDrawn } : null, groundDraws: ground?.draws ?? null,
      cabinStage: stats.cabinStage, aircraftTriangles: stats.aircraftTriangles, cabinDrawCalls: stats.cabinDrawCalls,
      clouds: window.__skyline.flight.stats().clouds ?? null,
      memory: P.memory(),
    };
  }, { rounds: ROUNDS, parts: PARTS });
}

/** The flight's own JavaScript per frame while playing: 250 frames, so the 240 kept are all playing frames. */
async function measureJs(page) {
  return page.evaluate(async () => {
    const P = window.__perfF8, s = window.__skyline, f = s.flight;
    const loop0 = s.loop.frames, t0 = performance.now();
    f.play();
    await P.nextFrames(250);
    f.pause();
    const wall = (performance.now() - t0) / Math.max(1, s.loop.frames - loop0);
    const st = f.stats(), l = st.layerMs;
    return { mean: +l.mean.toFixed(3), p50: +l.p50.toFixed(3), p95: +l.p95.toFixed(3), frames: l.frames, steps: st.steps ?? null, cabinStageLastMs: st.cabinStage?.lastMs ?? null, region: st.world.region.cpuMs, wallMsPerFrame: +wall.toFixed(2) };
  });
}

async function shot(page, file) {
  await page.evaluate(hideUi);
  await page.evaluate(async () => { await window.__skyline.flight.whenSettled(); await window.__perfF8.nextFrames(3); });
  await page.screenshot({ path: file, type: 'png' });
  await page.evaluate(showUi);
}

const all = { date: new Date().toISOString(), port, host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, platform: process.platform }, loadAtStart: loadNow(), backends: {} };
mkdirSync(out, { recursive: true });

for (const backend of backends) {
  const dir = path.join(out, backend), shots = path.join(dir, 'shots');
  mkdirSync(shots, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/flights\/[\w-]+\.jpg/.test(r.url())) problems.push(`[http ${r.status()}] ${r.url()}`); });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* */ } });
  await page.goto(`http://127.0.0.1:${port}/?city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && window.__skyline.attractions && document.getElementById('loading').classList.contains('done'), null, { timeout: 240_000 });
  await page.evaluate(async () => { const s = window.__skyline; await s.attractions.ready; s.attractions.freeze(47); await s.flight.ready; });
  await page.evaluate(installHelpers);
  const gpu = await page.evaluate(() => window.__skyline.perf.gpu());
  if (gpu.backend !== backend || gpu.software) throw new Error(`asked for ${backend} on the GPU, drawing on ${gpu.backend} (${gpu.renderer})`);
  const lowPower = await page.evaluate(async () => { let n = 0; const t0 = performance.now(); await new Promise((r) => { const step = () => (++n >= 30 ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); }); return +(1000 * 30 / (performance.now() - t0)).toFixed(1); });
  const result = { backend, gpu, rafHz: lowPower, load: loadNow(), mapMemory: await page.evaluate(() => window.__perfF8.memory()), entry: null, flights: {}, orbits: {} };
  console.log(backend, JSON.stringify(gpu), 'rAF', lowPower, 'Hz', 'load', result.load.join(' '));

  for (const [k, id] of ids.entries()) {
    const moments = await momentsOf(id);
    // the entry: from the call to the settled first frame (the first entry builds everything; later ones reuse it)
    const entry = await page.evaluate(async (fid) => {
      const s = window.__skyline, f = s.flight;
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(2000);
      const t0 = performance.now();
      let firstFrame = null;
      const watch = () => { if (firstFrame === null) { if (f.active() && f.state()) firstFrame = performance.now() - t0; else requestAnimationFrame(watch); } };
      requestAnimationFrame(watch);
      await f.start(fid, { pace: false, play: false });
      const startResolved = performance.now() - t0;
      await f.whenSettled();
      const settled = performance.now() - t0;
      const res = performance.getEntriesByType('resource').map((e) => ({ name: new URL(e.name).pathname, bytes: e.transferSize || e.encodedBodySize || 0, body: e.decodedBodySize, ms: Math.round(e.responseEnd - e.startTime), end: Math.round(e.responseEnd - t0) }));
      return { firstFrameMs: firstFrame && Math.round(firstFrame), startResolvedMs: Math.round(startResolved), settledMs: Math.round(settled), requests: res.length,
        bytesMB: +(res.reduce((a, r) => a + r.bytes, 0) / 2 ** 20).toFixed(2), decodedMB: +(res.reduce((a, r) => a + (r.body || 0), 0) / 2 ** 20).toFixed(2), resources: res };
    }, id);
    if (k === 0) result.entry = entry;
    result.flights[id] = { entry: k === 0 ? undefined : { settledMs: entry.settledMs, requests: entry.requests, bytesMB: entry.bytesMB }, moments: {} };
    await page.evaluate(() => window.__skyline.flight.options({ hud: false }));
    console.log(backend, id, 'entry', entry.settledMs, 'ms', entry.requests, 'requests', entry.bytesMB, 'MB');
    // pictures first, before anything has played
    if (SHOTS) {
      for (const [name, at] of Object.entries(moments)) {
        await page.evaluate(async (t) => { await window.__skyline.flight.seek({ at: t }); await window.__skyline.flight.whenSettled(); }, at);
        await shot(page, path.join(shots, `${id}_${name}.png`));
      }
    }
    for (const [name, at] of Object.entries(moments)) {
      const load = loadNow();
      await page.evaluate(async (t) => { const f = window.__skyline.flight; await f.seek({ at: t }); await f.whenSettled(); await f.whenSettled(); }, at);
      const m = await measureHere(page);
      m.load = load;
      if (JS) {
        m.js = await measureJs(page);
        await page.evaluate(async (t) => { await window.__skyline.flight.seek({ at: t }); await window.__skyline.flight.whenSettled(); }, at);
      }
      result.flights[id].moments[name] = m;
      console.log(backend, id, name, `alt ${m.altMsl} m`, `draws ${m.frame.draws}`, `tris ${m.frame.triangles}`, `${m.frame.ms} ms`, m.frame.gpuMs !== null ? `gpu ${m.frame.gpuMs} ms` : '', m.js ? `js p95 ${m.js.p95}` : '', `load ${load[0]}`);
    }
    writeFileSync(path.join(dir, 'measure.json'), `${JSON.stringify(result, null, 1)}\n`);
  }

  for (const name of orbits) {
    const load = loadNow();
    await page.evaluate(async (o) => { const f = window.__skyline.flight; await f.orbit({ ...o, play: false }); f.options({ hud: false }); await f.whenSettled(); await f.whenSettled(); }, PRESETS[name]);
    if (SHOTS) await shot(page, path.join(shots, `orbit-${name}.png`));
    const m = await measureHere(page);
    m.load = load;
    if (JS) m.js = await measureJs(page);
    result.orbits[name] = m;
    console.log(backend, 'orbit', name, `alt ${m.altMsl} m`, `draws ${m.frame.draws}`, `tris ${m.frame.triangles}`, `${m.frame.ms} ms`, m.frame.gpuMs !== null ? `gpu ${m.frame.gpuMs} ms` : '', m.js ? `js p95 ${m.js.p95}` : '', `load ${load[0]}`);
  }
  result.problems = problems;
  result.loadAtEnd = loadNow();
  all.backends[backend] = result;
  writeFileSync(path.join(dir, 'measure.json'), `${JSON.stringify(result, null, 1)}\n`);
  await page.close();
}
all.loadAtEnd = loadNow();
writeFileSync(path.join(out, 'measure.json'), `${JSON.stringify(all, null, 1)}\n`);
await browser.close();

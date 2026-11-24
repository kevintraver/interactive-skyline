// Photometric probes of the drive's lights on plan 01's renderer (plan 02, section 8.3 and 8.4; third stretch,
// decision 6): the scene-referred light the pipeline holds (window.__skyline.probe, pipeline.probe(): cd/m^2 at a
// point of the screen, the pre-exposure divided out) against what the plan's pure functions say it must be. GPU,
// shipped look (no ?display=classic), clean camera, the drive's clock paused. Each line prints the quantity, the
// expected value, the measured one, the tolerance and PASS or FAIL; the exit code is the verdict (0: all pass).
//
// Serve the repository first (pnpm exec vite --port 5321 --strictPort), then:
//   node tests/manual/lights-probe.mjs [--port 5321] [--backends webgpu,webgl] [--only pool,sprite,road,sign] [--quality high]
//
// The quality level is pinned (default High) before Drive is entered: the automatic choice's governor may drop a level
// on a loaded machine, and a level change while driving on WebGPU leaves the frame broken (plan 01's shadow map is
// destroyed while still bound: "Destroyed texture ShadowDepthTexture used in a submit"; seen 2026-11-23), after which
// every probe reads 0.
//
// What is measured, and against what (every expected value is computed in the page from the source's pure modules
// and the data files, not read back from the part):
//   pool     ?parts=lamps, a lit stretch of I-15 at 23:30. The road's luminance where the lamp pools are brightest,
//            lamps on minus lamps off (the part's setEnabled), against albedo x E / pi, with E summed lamp by lamp
//            from lamps.js illuminanceAt over the lamp product (every lamp within 150 m, steady colour and flux) and
//            the albedo read from the road atlas at the hit's uv over the pixel's footprint. Tolerance 15 %: the pool
//            map's 2 m texels and half floats (a few %), the albedo's footprint estimate (about 5 %).
//   sprite   ?parts=lamps. A lamp's sprite: its light summed over the pixels around it (a block read back from the
//            scene pass, lamps on minus off) times each pixel's solid angle, against E = T I(theta, phi) / d^2 from
//            spriteMirror.js instanceIntensity (the lamp type's pattern and aim, the far pool glow) and the visibility.
//            Tolerance 5 %, the plan's "sprite flux across distance" (8.4), at two distances.
//   road     ?parts=headlights, unlit desert at 23:30. The lane's centre 10, 30 and 60 m ahead of the lamps in the low
//            beam and 30, 60 and 100 m in the high beam, the
//            headlamps on minus off, against albedo x E / pi with E from headlampMirror.js headlampIrradiance (the beam
//            map of beam.json, both lamps where the pose puts them). Tolerance 20 % (the plan's own is a factor of 2
//            at 30 m, 8.4; 20 % is what a correct port must reach: the albedo estimate and the beam map's filtering).
//   sign     ?parts=headlights. A green guide sign (the first one ahead, overhead or beside the road) 60 and 150 m ahead under the low beam: its legend's and its
//            background's luminance (on minus off; texels classified from the sign atlas at each probe's uv, only pure
//            ones kept) against headlampMirror.js retroReturn x the sheeting's ageing (headlights.js AGEING, 0.8):
//            R_A(alpha, beta) x E_perp / cos(nu) per lamp from retro.js's tables. Tolerance 15 % (the plan's table
//            ratio tolerance, 8.4); and the plan's acceptance on its own line: the white legend at 150 m within 10 to
//            60 cd/m^2 with the lamps on, and near zero (under 1 cd/m^2) with them off.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5321));
const backends = opt('backends', 'webgpu,webgl').split(',').filter(Boolean);
const only = opt('only', null)?.split(',');
const level = opt('quality', 'high');
const W = 1280, H = 720;
const NIGHT = '2026-11-22T07:30:00Z'; // 23:30 Pacific: every lamp long on, every sodium lamp warm, the sun at -60 degrees

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});

// ------------------------------------------------------------------ helpers installed in the page
// window.__lp: geometry, raycasts, the pixel reads and the pure modules (imported through the dev server).
const PAGE_HELPERS = String.raw`
window.__lp = (() => {
  const sk = window.__skyline;
  const T = sk.three;
  const V = (o) => new T.Vector3(o.x, o.y, o.z);
  const mods = {};
  async function load() {
    if (mods.ready) return mods;
    const imp = (p) => import(p);
    Object.assign(mods, {
      mirror: await imp('/src/drive/lights/headlampMirror.js'),
      beam: await imp('/src/drive/lights/beam.js'),
      lamps: await imp('/src/drive/lights/lamps.js'),
      pack: await imp('/src/drive/lights/pack.js'),
      sprite: await imp('/src/drive/lights/spriteMirror.js'),
      atlas: await imp('/src/drive/roadnet/atlas.js'),
      ready: true,
    });
    return mods;
  }
  const frames = (n = 3) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const drive = () => sk.scene.getObjectByName('drive');
  function poseBasis() {
    const p = sk.drive.pose();
    const f = V(p.forward).normalize(), u = V(p.up).normalize();
    const r = new T.Vector3().crossVectors(f, u).normalize();
    return { pose: p, position: V(p.position), forward: f, up: u, right: r, eye: V(p.eye) };
  }
  /** Meshes drawn with the road's materials (userData.surfaceLight 'road'). */
  function roadMeshes() {
    const out = [];
    drive()?.traverse((o) => { if (o.isMesh && o.visible && o.material?.userData?.surfaceLight === 'road') out.push(o); });
    return out;
  }
  function signFaceMeshes() {
    const out = [];
    // a page's faces are one mesh with a material per distance band (roadside/index.js)
    const named = (m) => (Array.isArray(m) ? m : [m]).some((x) => /^signs /.test(x?.name || ''));
    drive()?.traverse((o) => { if (o.isMesh && o.visible && named(o.material) && o.geometry.getAttribute('retro')) out.push(o); });
    return out;
  }
  const ray = new T.Raycaster();
  function rayAtNdc(x, y) {
    const cam = sk.camera;
    cam.updateMatrixWorld();
    const o = new T.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const d = new T.Vector3(x, y, 0.5).unproject(cam).sub(o).normalize();
    return { o, d };
  }
  function hitRoad(o, d, meshes = roadMeshes()) {
    ray.set(o, d); ray.far = 5000;
    const h = ray.intersectObjects(meshes, false)[0];
    if (!h) return null;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    return { point: h.point.clone(), normal: n, uv: h.uv ? h.uv.clone() : null, distance: h.distance, object: h.object };
  }
  const ndcOf = (p) => { const v = p.clone().project(sk.camera); return { x: v.x, y: v.y, z: v.z }; };
  // ---- the road atlas at a uv (the map's own transform: repeat (1, 1 / V_CYCLES), wrapT repeat), linear sRGB
  let atlasPx = null;
  function atlasPixels(map) {
    if (atlasPx && atlasPx.map === map) return atlasPx;
    const img = map.image, w = img.width, h = img.height;
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    atlasPx = { map, w, h, data: g.getImageData(0, 0, w, h).data };
    return atlasPx;
  }
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  /** Mean linear albedo [r, g, b] of a texture over a box of half sizes (du, dv) in uv around uv (after the map's transform). */
  function albedoAt(map, uv, du = 0, dv = 0) {
    const a = atlasPixels(map);
    const tu = (u) => u * map.repeat.x + map.offset.x, tv = (v) => v * map.repeat.y + map.offset.y;
    const u0 = tu(uv.x - du), u1 = tu(uv.x + du), v0 = tv(uv.y - dv), v1 = tv(uv.y + dv);
    const x0 = Math.floor(Math.min(u0, u1) * a.w), x1 = Math.max(x0, Math.floor(Math.max(u0, u1) * a.w));
    const y0 = Math.floor(Math.min(v0, v1) * a.h), y1 = Math.max(y0, Math.floor(Math.max(v0, v1) * a.h));
    const sx = Math.max(1, Math.ceil((x1 - x0 + 1) / 24)), sy = Math.max(1, Math.ceil((y1 - y0 + 1) / 24));
    const s = [0, 0, 0]; let n = 0;
    for (let y = y0; y <= y1; y += sy) for (let x = x0; x <= x1; x += sx) {
      const xx = Math.min(a.w - 1, Math.max(0, x)), yy = ((y % a.h) + a.h) % a.h, i = (yy * a.w + xx) * 4;
      s[0] += lin(a.data[i]); s[1] += lin(a.data[i + 1]); s[2] += lin(a.data[i + 2]); n++;
    }
    return s.map((v) => v / n);
  }
  /** The uv footprint of the pixel at ndc on a road hit: half the uv step to the next pixel across and up. */
  function footprint(x, y, hit, meshes) {
    const px = 2 / sk.renderer.domElement.width, py = 2 / sk.renderer.domElement.height;
    const a = rayAtNdc(x + px, y), b = rayAtNdc(x, y + py);
    const ha = hitRoad(a.o, a.d, meshes), hb = hitRoad(b.o, b.d, meshes);
    if (!ha?.uv || !hb?.uv) return [0, 0];
    return [Math.max(Math.abs(ha.uv.x - hit.uv.x), Math.abs(hb.uv.x - hit.uv.x)) / 2, Math.max(Math.abs(ha.uv.y - hit.uv.y), Math.abs(hb.uv.y - hit.uv.y)) / 2];
  }
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  /** pipeline.probe at ndc: { L, rgb }, with the vertical sense found by calibrate(). */
  let ySign = 1;
  async function probe(x, y) { const r = await sk.probe(x, y * ySign); return { L: r.luminanceCdM2, rgb: r.rgb }; }
  /**
   * Which way pipeline.probe's y runs. Measured on 2026-11-24 it reads the row mirrored about the middle (probe(0, 0.6)
   * returns the road under the headlamps, not the night sky above), on both backends. So it is found, not assumed: a
   * light the part switches (toggle) changes the bottom of the frame (the road) and not the top (the sky).
   */
  async function calibrate(toggle) {
    ySign = 1;
    const diff = async (y) => { toggle(true); const a = (await probe(0, y)).L; toggle(false); const b = (await probe(0, y)).L; toggle(true); return a - b; };
    const lo = await diff(-0.75), hi = await diff(0.75);
    ySign = Math.abs(hi) > Math.abs(lo) ? -1 : 1;
    return { ySign, bottom: lo, top: hi };
  }
  // ---- a block of the scene pass read back (for a sprite's whole extent), cd/m^2 per pixel, rows from the top
  let halfLut = null;
  const fromHalf = (u) => { const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff; if (e === 0) return s * f * 2 ** -24; if (e === 31) return f ? NaN : s * Infinity; return s * (1 + f / 1024) * 2 ** (e - 15); };
  async function block(cx, cy, r, flip) {
    const pl = sk.pipeline;
    pl.render();
    const rt = pl.scenePass.renderTarget, w = 2 * r + 1;
    const x0 = Math.max(0, Math.min(rt.width - w, cx - r));
    const top = Math.max(0, Math.min(rt.height - w, cy - r));
    const y0 = flip ? rt.height - top - w : top;
    const px = await sk.renderer.readRenderTargetPixelsAsync(rt, x0, y0, w, w);
    const k = 1 / sk.env.nodes.exposure.value;
    const half = px instanceof Uint16Array;
    const out = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
      const row = flip ? w - 1 - j : j, o = (row * w + i) * 4;
      const c = half ? [fromHalf(px[o]), fromHalf(px[o + 1]), fromHalf(px[o + 2])] : [px[o], px[o + 1], px[o + 2]];
      out[j * w + i] = lum(c) * k;
    }
    return { x0, top, w, data: out, size: [rt.width, rt.height] };
  }
  return { load, frames, drive, poseBasis, roadMeshes, signFaceMeshes, rayAtNdc, hitRoad, ndcOf, albedoAt, footprint, lum, probe, calibrate, block, V };
})();
`;

async function openPage(backend, parts) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page.problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => page.problems.push(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.routeWebSocket(/./, () => {}); // other work in the checkout makes Vite reload the page: keep its socket silent
  await page.goto(`http://localhost:${port}/?city=lv&renderer=webgpu&backend=${backend}&parts=${parts}`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.attractions && window.__skyline?.drive, null, { timeout: 180000 });
  await page.evaluate(async (level) => { const s = window.__skyline; s.quality?.set(level); s.attractions.freeze(20); await s.attractions.ready; }, level);
  await page.addScriptTag({ content: PAGE_HELPERS });
  page.info = await page.evaluate(() => ({ ...window.__skyline.rendererInfo, quality: window.__skyline.quality?.level }));
  console.log(`${backend.padEnd(7)} page ?parts=${parts}: ${JSON.stringify(page.info)}`);
  return page;
}

/** Start or move the drive, look, settle; returns the pose. */
async function place(page, { route, s, t = NIGHT, look }) {
  return page.evaluate(async ({ route, s, t, look }) => {
    const d = window.__skyline.drive;
    const tMs = Date.parse(t);
    if (!d.active() || d.route()?.id !== route) await d.start(route, { s, t: tMs, view: 'clean' });
    d.pause(); d.setView('clean'); d.seek({ s, t: tMs });
    d.look({ yaw: 0, pitch: 0, lens: 50, ...look });
    await d.whenSettled();
    await window.__lp.frames(4);
    return d.pose();
  }, { route, s, t, look });
}

const rows = [];
function report(backend, quantity, expected, measured, tol, unit = 'cd/m2', note = '') {
  let pass, tolText;
  if (Array.isArray(tol)) { pass = Number.isFinite(measured) && measured >= tol[0] && measured <= tol[1]; tolText = `in [${tol[0]}, ${tol[1]}]`; }
  else { pass = Number.isFinite(measured) && Number.isFinite(expected) && Math.abs(measured - expected) <= tol * Math.abs(expected); tolText = `+-${Math.round(tol * 100)} %`; }
  const fmt = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3)) : String(v));
  rows.push({ backend, quantity, expected, measured, tol, pass });
  console.log(`${backend.padEnd(7)} ${quantity.padEnd(40)} expected ${fmt(expected).padStart(9)}  measured ${fmt(measured).padStart(9)} ${unit.padEnd(6)} ${tolText.padEnd(12)} ${pass ? 'PASS' : 'FAIL'}${note ? `  ${note}` : ''}`);
}
const want = (k) => !only || only.includes(k);

// ------------------------------------------------------------------ lamps: pools and sprites
async function lamps(backend) {
  const page = await openPage(backend, 'lamps');
  await place(page, { route: 'i15n', s: 59200, look: { pitch: -7, lens: 35 } });
  const present = await page.evaluate(async () => {
    const part = window.__skyline.scene.getObjectByName('lamp-sprites')?.userData.lampsPart;
    if (!part) return null;
    await window.__skyline.drive.whenSettled();
    const st = part.stats();
    return { on: st.on, ambientLux: st.ambientLux, sprites: st.sprites, renderer: st.renderer };
  });
  console.log(`${backend.padEnd(7)} lamps part: ${present ? JSON.stringify(present) : 'not running on this renderer'}`);
  if (present) console.log(`${backend.padEnd(7)} probe orientation: ${JSON.stringify(await page.evaluate(() => {
    const part = window.__skyline.scene.getObjectByName('lamp-sprites').userData.lampsPart;
    return window.__lp.calibrate((on) => part.setEnabled(on));
  }))}`);

  if (want('pool')) {
    const r = !present ? { error: 'no lamps part' } : await page.evaluate(async () => {
      const lp = window.__lp, sk = window.__skyline, m = await lp.load();
      const part = sk.scene.getObjectByName('lamp-sprites').userData.lampsPart;
      // the lamp product, decoded here, and its types (the expected E is summed from these)
      const meta = await (await fetch('/data/lv/lamps-drive.json')).json();
      const buf = await (await fetch(`/data/lv/${meta.file || 'lamps-drive.bin'}`)).arrayBuffer();
      const pack = m.pack.decodeLampPack(meta, buf), types = m.lamps.createLampTypes(pack.lampTypes);
      const steady = (t) => (t.cls === 'sodium' ? t.warmup(1e6) : { flux: 1, color: t.color });
      function luxAt(x, y) { // map metres; every lamp within 150 m, lit, steady
        const e = [0, 0, 0];
        for (let i = 0; i < pack.count; i++) {
          const dx = x - pack.x[i], dy = y - pack.y[i];
          if (dx * dx + dy * dy > 150 * 150) continue;
          const t = types.byId.get(pack.type[i]); if (!t) continue;
          const v = m.lamps.illuminanceAt(t, pack.lumens[i], pack.mount[i], dx, dy, Number.isFinite(pack.aim[i]) ? pack.aim[i] : null);
          const w = steady(t);
          for (let c = 0; c < 3; c++) e[c] += v * w.flux * Math.max(0, w.color[c]);
        }
        return e;
      }
      // candidate pixels on the lane: the brightest pool texels the map shows
      const meshes = lp.roadMeshes();
      const lane = m.atlas.REGIONS.lane, laneR = m.atlas.REGIONS.laneR, W = m.atlas.ATLAS_W;
      const inLane = (u) => (u * W > lane[0] + 10 && u * W < lane[1] - 10) || (u * W > laneR[0] + 10 && u * W < laneR[1] - 10);
      const cands = [];
      for (let y = -0.95; y <= -0.15; y += 0.05) for (let x = -0.7; x <= 0.7; x += 0.05) {
        const { o, d } = lp.rayAtNdc(x, y);
        const h = lp.hitRoad(o, d, meshes);
        if (!h?.uv || !inLane(h.uv.x) || h.distance > 120) continue;
        const pl = part.poolLuxAt(h.point.x, -h.point.z);
        if (!pl) continue;
        cands.push({ x, y, h, mapLux: lp.lum(pl.rgb) });
      }
      cands.sort((a, b) => b.mapLux - a.mapLux);
      const picked = [];
      for (const c of cands) { if (picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 0.12)) picked.push(c); if (picked.length >= 5) break; }
      if (!picked.length) return { error: 'no pool on the lane in view', cands: cands.length };
      let exp = 0, meas = 0, mapE = 0, sumE = 0;
      const pts = [];
      for (const c of picked) {
        const [du, dv] = lp.footprint(c.x, c.y, c.h, meshes);
        const rho = lp.albedoAt(c.h.object.material.map, c.h.uv, du, dv);
        const E = luxAt(c.h.point.x, -c.h.point.z);
        part.setEnabled(true); const on = await lp.probe(c.x, c.y);
        part.setEnabled(false); const off = await lp.probe(c.x, c.y);
        part.setEnabled(true);
        const e = lp.lum([rho[0] * E[0], rho[1] * E[1], rho[2] * E[2]]) / Math.PI;
        exp += e; meas += on.L - off.L; mapE += c.mapLux; sumE += lp.lum(E);
        pts.push({ ndc: [+c.x.toFixed(2), +c.y.toFixed(2)], d: +c.h.distance.toFixed(1), rho: +lp.lum(rho).toFixed(3), E: +lp.lum(E).toFixed(2), mapE: +c.mapLux.toFixed(2), exp: +e.toFixed(4), on: +on.L.toFixed(4), off: +off.L.toFixed(4) });
      }
      const n = picked.length;
      return { expected: exp / n, measured: meas / n, mapE: mapE / n, sumE: sumE / n, pts };
    });
    if (r.error) report(backend, 'pool: road luminance (on - off)', NaN, NaN, 0.15, 'cd/m2', r.error);
    else {
      report(backend, 'pool: E on the lane, map vs lamp sum', r.sumE, r.mapE, 0.10, 'lux', 'the map against the lamps summed one by one (8.4: +-10 %)');
      report(backend, 'pool: road luminance (on - off)', r.expected, r.measured, 0.15, 'cd/m2', `mean of ${r.pts.length} points, albedo x E / pi`);
      console.log(`        points ${JSON.stringify(r.pts)}`);
    }
  }

  if (want('sprite')) {
    for (const [lo, hi] of [[20, 250], [250, 1500]]) {
      let r = { error: 'no lamps part' };
      // a few views of the same place, until one shows a lamp that suits (see the conditions below)
      for (const look of present ? [{ pitch: 2, lens: 50 }, { pitch: 12, lens: 35 }, { yaw: 35, pitch: 12, lens: 35 }, { yaw: -35, pitch: 12, lens: 35 }, { yaw: 30, pitch: 3, lens: 50 }, { pitch: 1, lens: 120 }] : []) {
      await page.evaluate(async (look) => { const d = window.__skyline.drive; d.look({ yaw: 0, pitch: 0, ...look }); await d.whenSettled(); await window.__lp.frames(3); }, look);
      r = await page.evaluate(async ({ lo, hi }) => {
        const lp = window.__lp, sk = window.__skyline, m = await lp.load();
        const part = sk.scene.getObjectByName('lamp-sprites').userData.lampsPart;
        const layer = sk.scene.getObjectByName('lamp-sprites');
        const meta = await (await fetch('/data/lv/lamps-drive.json')).json();
        const buf = await (await fetch(`/data/lv/${meta.file || 'lamps-drive.bin'}`)).arrayBuffer();
        const pack = m.pack.decodeLampPack(meta, buf), types = m.lamps.createLampTypes(pack.lampTypes);
        void layer;
        const cam = sk.camera; cam.updateMatrixWorld();
        const eye = new sk.three.Vector3().setFromMatrixPosition(cam.matrixWorld);
        const fwd = new sk.three.Vector3(); cam.getWorldDirection(fwd);
        // the layer's own instance data holds the positions on the drawn ground (lights/index.js)
        const pos = part.instancePositions ? part.instancePositions() : null;
        if (!pos) return { error: 'the part does not expose its sprite positions (instancePositions)' };
        const sz = [sk.renderer.domElement.width, sk.renderer.domElement.height];
        const proj = [], weights = part.drawnWeights();
        for (let i = 0; i < pack.count; i++) {
          if (!weights.has(i)) continue; // not drawn: culled, or its light carried by a neighbour (thinning)
          const p = new sk.three.Vector3(pos[4 * i], pos[4 * i + 1], pos[4 * i + 2]);
          const d = p.distanceTo(eye);
          if (d > 1500) continue;
          if (p.clone().sub(eye).dot(fwd) < 1) continue; // behind the camera (a projection mirrors those into view)
          const n = lp.ndcOf(p);
          if (Math.abs(n.x) > 0.9 || Math.abs(n.y) > 0.9) continue;
          proj.push({ i, p, d, px: [(n.x + 1) / 2 * sz[0], (1 - n.y) / 2 * sz[1]], n });
        }
        // isolated: no other lamp within 30 px, in the distance band, in front of nothing, and well conditioned: the
        // pattern's intensity toward the eye changes by under 1 % when the eye rises 0.1 m (a lamp seen at its cutoff,
        // where I(theta) falls by a third per degree, would test the geometry's rounding rather than the flux)
        const iso = proj.filter((a) => a.d >= lo && a.d <= hi && proj.every((b) => b === a || Math.hypot(b.px[0] - a.px[0], b.px[1] - a.px[1]) > 30));
        if (!iso.length) return { error: `no isolated lamp between ${lo} and ${hi} m in view (${proj.length} in view)` };
        const ray = new sk.three.Raycaster();
        // anything opaque that writes depth can hide a sprite (the app's ground and buildings too, not only the drive's)
        const blockers = [];
        sk.scene.traverseVisible((o) => {
          const mats = o.isMesh ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          if (o.isMesh && !o.isInstancedMesh && mats.some((x) => x && x.depthWrite !== false && !x.transparent) && o.geometry?.index !== undefined
            && !/sky|lamp-sprites|twins/.test(o.name)) blockers.push(o);
        });
        const intensityOf = (a, e) => {
          const t = types.byId.get(pack.type[a.i]);
          return m.sprite.instanceIntensity({ pos: [a.p.x, a.p.y, a.p.z], eye: [e.x, e.y, e.z], intensity: pack.lumens[a.i], kind: m.sprite.kindOfOptic(t.optic),
            k: [t.kDown, t.kUp, 1 - t.uplight], axis: [0, -1, 0], aimRad: Number.isFinite(pack.aim[a.i]) ? (pack.aim[a.i] * Math.PI) / 180 : NaN,
            mount: pack.mount[a.i], groundAlbedo: 0.15 });
        };
        let pick = null;
        for (const a of iso.sort((x, y) => x.d - y.d)) {
          const i0 = intensityOf(a, eye).intensity, i1 = intensityOf(a, eye.clone().add(new sk.three.Vector3(0, 0.1, 0))).intensity;
          if (!(i0 > 0) || Math.abs(i1 / i0 - 1) > 0.02) continue;
          ray.set(eye, a.p.clone().sub(eye).normalize()); ray.far = a.d - 2;
          if (!ray.intersectObjects(blockers, false).length) { pick = a; break; }
        }
        if (!pick) return { error: `no isolated, visible, well-conditioned lamp between ${lo} and ${hi} m (${iso.length} isolated)` };
        const i = pick.i, t = types.byId.get(pack.type[i]);
        const st = t.cls === 'sodium' ? t.warmup(1e6) : { flux: 1, color: t.color };
        const ii = intensityOf(pick, eye);
        const vis = part.stats().visibilityM; // what the part gives the layer: the weather's visibility at the camera
        const Tr = Math.exp(-ii.distance / vis);
        const colourLum = lp.lum(st.color.map((c) => Math.max(0, c)));
        const weight = weights.get(i); // a thinned far lamp stands for `weight` lamps of its cell
        const expected = (weight * Tr * ii.intensity * st.flux * colourLum) / (ii.distance * ii.distance);
        // the block: radius from the sprite rule (core and halo), at least 12 px
        const rt = sk.pipeline.scenePass.renderTarget, P = cam.projectionMatrix.elements;
        // a pixel's angular size across and up, from the projection actually used (its focal lengths in NDC)
        const pax = 2 / (P[0] * rt.width), pay = 2 / (P[5] * rt.height), pa = Math.sqrt(pax * pay);
        const rule = m.sprite.spriteRule({ intensityCd: ii.intensity, distanceM: ii.distance, pixelAngle: pa, halo: 0.006 });
        const R = Math.max(12, Math.ceil(2.6 * Math.max(rule.a, rule.halo > 0 ? rule.haloA : 0)) + 3);
        const cx = Math.round((pick.n.x + 1) / 2 * rt.width - 0.5), cy = Math.round((1 - pick.n.y) / 2 * rt.height - 0.5);
        // the rows of a read run from the top on WebGPU and from the bottom on WebGL (each API's texture origin); the
        // sprites alone are switched (the layer's mesh), so the pools on the ground behind do not change
        const flip = sk.rendererInfo.backend !== 'webgpu';
        const sprites = sk.scene.getObjectByName('lamp-sprites');
        sprites.visible = true;
        const onB = await lp.block(cx, cy, R, flip);
        let k = 0; for (let j = 1; j < onB.data.length; j++) if (onB.data[j] > onB.data[k]) k = j;
        const pxk = [onB.x0 + (k % onB.w) + 0.5, onB.top + Math.floor(k / onB.w) + 0.5];
        const pr = await lp.probe(pxk[0] / rt.width * 2 - 1, 1 - pxk[1] / rt.height * 2);
        sprites.visible = false;
        const offB = await lp.block(cx, cy, R, flip);
        sprites.visible = true;
        // each pixel's solid angle: pa^2 cos^3 of its angle off the axis
        const f = new sk.three.Vector3(); cam.getWorldDirection(f);
        let E = 0;
        for (let j = 0; j < onB.w; j++) for (let q = 0; q < onB.w; q++) {
          const nx = (onB.x0 + q + 0.5) / rt.width * 2 - 1, ny = 1 - (onB.top + j + 0.5) / rt.height * 2;
          const dir = new sk.three.Vector3(nx, ny, 0.5).unproject(cam).sub(eye).normalize();
          const c = dir.dot(f);
          E += (onB.data[j * onB.w + q] - offB.data[j * onB.w + q]) * pax * pay * c * c * c;
        }
        const offAxisDeg = Math.acos(Math.min(1, pick.p.clone().sub(eye).normalize().dot(fwd))) * 180 / Math.PI;
        return { expected, measured: E, d: ii.distance, type: `${t.key || t.cls || t.id}, ${offAxisDeg.toFixed(0)} deg off axis, weight ${weight}, visibility ${Math.round(vis)} m`, I: ii.intensity * st.flux * colourLum, R, flip, probeAgree: pr.L / onB.data[k] };
      }, { lo, hi });
      if (!r.error) break;
      }
      if (r.error) report(backend, `sprite: E at the eye, ${lo}-${hi} m`, NaN, NaN, 0.05, 'lux', r.error);
      else report(backend, `sprite: E at the eye, ${Math.round(r.d)} m`, r.expected, r.measured, 0.05, 'lux', `${r.type}, I ${r.I.toFixed(0)} cd, block radius ${r.R} px, the read's peak against pipeline.probe ${r.probeAgree.toFixed(3)}`);
    }
  }
  return page;
}

// ------------------------------------------------------------------ headlights: the road and a guide sign
async function headlights(backend) {
  const page = await openPage(backend, 'headlights');
  await place(page, { route: 'i15n', s: 3000, look: { pitch: -4, lens: 35 } });
  const present = await page.evaluate(() => {
    const part = window.__skyline.scene.getObjectByName('drive')?.userData.headlightsPart;
    return part ? part.state() : null;
  });
  console.log(`${backend.padEnd(7)} headlights part: ${present ? JSON.stringify(present) : 'not running on this renderer'}`);
  if (present) console.log(`${backend.padEnd(7)} probe orientation: ${JSON.stringify(await page.evaluate(() => {
    const part = window.__skyline.scene.getObjectByName('drive').userData.headlightsPart;
    return window.__lp.calibrate((on) => part.setEnabled(on));
  }))}`);
  const beamSetup = String.raw`
    const sk = window.__skyline, lp = window.__lp, m = await lp.load();
    const meta = await (await fetch('/data/drive/beam.json')).json();
    const bin = async (w) => (await fetch('/data/drive/' + (meta.files?.[w] || ('beam_' + w + '.bin')))).arrayBuffer();
    const tex = { low: m.mirror.beamTexture(m.beam.decodeBeam(await bin('low'), meta, 'low')), high: m.mirror.beamTexture(m.beam.decodeBeam(await bin('high'), meta, 'high')) };
    const hl = await import('/src/drive/lights/headlights.js');
    const part = sk.scene.getObjectByName('drive')?.userData.headlightsPart;
    const lampsNow = () => { const b = lp.poseBasis(); const v = (x) => ({ x: x.x, y: x.y, z: x.z });
      return { b, lamps: m.mirror.lampPositions({ position: v(b.position), right: v(b.right), up: v(b.up), forward: v(b.forward) }, m.beam.DEFAULT_LAMPS, hl.NOSE_M),
        basis: { right: v(b.right), up: v(b.up), forward: v(b.forward) } }; };
    const colour = m.mirror.chromaOf([1, 0.95, 0.86]);
  `;

  if (want('road')) {
    for (const [beam, dist] of [['low', 10], ['low', 30], ['low', 60], ['high', 30], ['high', 60], ['high', 100]]) {
      const r = !present ? { error: 'no headlights part' } : await page.evaluate(new Function('o', `const { dist, beam } = o; return (async () => { ${beamSetup}
        part.setHigh(beam === 'high');
        const { b, lamps, basis } = lampsNow();
        const mid = new sk.three.Vector3((lamps[0][0] + lamps[1][0]) / 2, (lamps[0][1] + lamps[1][1]) / 2, (lamps[0][2] + lamps[1][2]) / 2);
        const target = mid.clone().addScaledVector(b.forward, dist);
        const meshes = lp.roadMeshes();
        const h = lp.hitRoad(target.clone().addScaledVector(b.up, 6), b.up.clone().negate(), meshes);
        if (!h?.uv) return { error: 'no road under the point ' + dist + ' m ahead' };
        const n = lp.ndcOf(h.point);
        if (Math.abs(n.x) > 1 || Math.abs(n.y) > 1) return { error: 'the point is off screen' };
        const sight = lp.rayAtNdc(n.x, n.y), seen = lp.hitRoad(sight.o, sight.d, meshes);
        const [du, dv] = lp.footprint(n.x, n.y, seen || h, meshes);
        const rho = lp.albedoAt(h.object.material.map, h.uv, du, dv);
        const E = m.mirror.headlampIrradiance({ tex: tex[beam], lamps, basis, point: [h.point.x, h.point.y, h.point.z], normal: [h.normal.x, h.normal.y, h.normal.z] });
        part.setEnabled(true); const on = await lp.probe(n.x, n.y);
        part.setEnabled(false); const off = await lp.probe(n.x, n.y);
        part.setEnabled(true);
        part.setHigh(false);
        return { expected: lp.lum(rho.map((p, i) => p * colour[i])) * E / Math.PI, measured: on.L - off.L, E, rho: lp.lum(rho), at: seen ? seen.point.distanceTo(h.point) : null };
      })()`), { dist, beam });
      if (r.error) report(backend, `road in ${beam} beam, ${dist} m`, NaN, NaN, 0.2, 'cd/m2', r.error);
      else report(backend, `road in ${beam} beam, ${dist} m`, r.expected, r.measured, 0.2, 'cd/m2', `E ${r.E.toFixed(2)} lux, albedo ${r.rho.toFixed(3)}`);
    }
  }

  if (want('sign')) {
    for (const dist of [60, 150]) {
      const r = !present ? { error: 'no headlights part' } : await page.evaluate(new Function('dist', `return (async () => { ${beamSetup}
        part.setHigh(false);
        const d = sk.drive;
        // a green guide sign with a white legend facing the car (overhead or beside the road), 30 m to 2 km ahead
        function guideFaces() {
          const { b } = lampsNow(), out = [];
          for (const mesh of lp.signFaceMeshes()) {
            const g = mesh.geometry, P = g.getAttribute('position'), N = g.getAttribute('normal'), UV = g.getAttribute('uv');
            const R = g.getAttribute('retro'), L = g.getAttribute('retroLegend');
            mesh.updateMatrixWorld();
            for (let q = 0; q + 3 < P.count; q += 4) {
              if (Math.round(R.getX(q)) !== 4 || Math.round(L.getX(q)) !== 1) continue;
              const c = [0, 1, 2, 3].map((k) => new sk.three.Vector3(P.getX(q + k), P.getY(q + k), P.getZ(q + k)).applyMatrix4(mesh.matrixWorld));
              const ctr = c.reduce((a, v) => a.add(v), new sk.three.Vector3()).multiplyScalar(0.25);
              const nrm = new sk.three.Vector3(N.getX(q), N.getY(q), N.getZ(q)).transformDirection(mesh.matrixWorld);
              const rel = ctr.clone().sub(b.position), along = rel.dot(b.forward), side = rel.dot(b.right), up = rel.dot(b.up);
              if (along < 30 || nrm.dot(b.forward) > -0.9 || up < 1.5 || Math.abs(side) > 25) continue;
              out.push({ mesh, q, corners: c, uvs: [0, 1, 2, 3].map((k) => [UV.getX(q + k), UV.getY(q + k)]), ctr, nrm, along, area: c[0].distanceTo(c[1]) * c[1].distanceTo(c[2]) });
            }
          }
          return out.sort((a, b) => a.along - b.along);
        }
        // walk forward until an overhead guide sign is in the list, then put it dist ahead of the lamps
        let s = d.pose().s, face = null;
        for (let k = 0; k < 40 && !face; k++) {
          const f = guideFaces().filter((x) => x.area > 6);
          if (f.length) face = f[0]; else { s += 1500; d.seek({ s }); await d.whenSettled(); await lp.frames(3); }
        }
        if (!face) return { error: 'no guide sign found' };
        for (let it = 0; it < 3; it++) {
          const { b, lamps } = lampsNow();
          const mid = new sk.three.Vector3(lamps[0][0], lamps[0][1], lamps[0][2]).add(new sk.three.Vector3(lamps[1][0], lamps[1][1], lamps[1][2])).multiplyScalar(0.5);
          const along = face.ctr.clone().sub(mid).dot(b.forward);
          d.seek({ s: d.pose().s + along - dist }); await d.whenSettled(); await lp.frames(3);
          const again = guideFaces().filter((x) => x.area > 6).sort((a, c) => a.ctr.distanceTo(face.ctr) - c.ctr.distanceTo(face.ctr))[0];
          if (!again || again.ctr.distanceTo(face.ctr) > 3) return { error: 'lost the sign after moving' };
          face = again;
        }
        // aim the telephoto at it
        d.look({ yaw: 0, pitch: 0, lens: 200 }); await lp.frames(2);
        for (let it = 0; it < 6; it++) {
          const n = lp.ndcOf(face.ctr), st = d.pose();
          const hf = 2 * Math.atan(18 / 200) * 180 / Math.PI, vf = sk.camera.fov;
          d.look({ yaw: st.yaw - n.x * hf / 2, pitch: st.pitch + n.y * vf / 2 }); await lp.frames(2);
        }
        await d.whenSettled(); await lp.frames(3);
        const { lamps, basis } = lampsNow();
        const cam = sk.camera; cam.updateMatrixWorld();
        const eye = new sk.three.Vector3().setFromMatrixPosition(cam.matrixWorld);
        // the sign atlas, to class each probe's texel as legend or background
        const map = (Array.isArray(face.mesh.material) ? face.mesh.material[0] : face.mesh.material).map, img = map.image;
        const cv = new OffscreenCanvas(img.width, img.height), g2 = cv.getContext('2d'); g2.drawImage(img, 0, 0);
        const px = g2.getImageData(0, 0, img.width, img.height).data;
        const texel = (u, v) => { const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width))), y = Math.min(img.height - 1, Math.max(0, Math.floor((map.flipY ? 1 - v : v) * img.height))); const i = (y * img.width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
        const classOf = (u, v) => {
          const r = 1; let leg = 0, bg = 0;
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const c = texel(u + dx / img.width, v + dy / img.height);
            if (c[0] > 200 && c[1] > 200 && c[2] > 200) leg++; else if (c[1] > c[0] + 40 && c[1] > c[2] + 20) bg++; }
          const n = (2 * r + 1) ** 2;
          return leg === n ? 'legend' : bg === n ? 'background' : null;
        };
        const [c0, c1, c2, c3] = face.corners, [t0, t1, t2, t3] = face.uvs;
        const lerp = (a, b, t) => a.clone().lerp(b, t), lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const samples = { legend: [], background: [] };
        for (let j = 1; j < 12; j++) for (let i = 1; i < 28; i++) {
          const u = i / 28, v = j / 12;
          const p = lerp(lerp(c0, c1, u), lerp(c3, c2, u), v), uv = lerp2(lerp2(t0, t1, u), lerp2(t3, t2, u), v);
          const k = classOf(uv[0], uv[1]);
          if (!k || samples[k].length >= 10) continue;
          samples[k].push({ p, n: lp.ndcOf(p) });
        }
        const out = {};
        for (const k of ['legend', 'background']) {
          if (!samples[k].length) { out[k] = { error: 'no pure ' + k + ' texel found' }; continue; }
          let exp = 0, on = 0, off = 0;
          for (const sm of samples[k]) {
            const rows = k === 'legend' ? [0, 0] : [3, 3]; // retroTable rows: white 0, green 3
            const L = m.mirror.retroReturn({ tex: tex.low, table: m.mirror.retroTable(), lamps, basis, eye: [eye.x, eye.y, eye.z],
              point: [sm.p.x, sm.p.y, sm.p.z], normal: [face.nrm.x, face.nrm.y, face.nrm.z], rows });
            exp += L[0] * hl.AGEING.sheeting;
            part.setEnabled(true); on += (await lp.probe(sm.n.x, sm.n.y)).L;
            part.setEnabled(false); off += (await lp.probe(sm.n.x, sm.n.y)).L;
          }
          part.setEnabled(true);
          const nS = samples[k].length;
          out[k] = { expected: exp / nS, measured: (on - off) / nS, on: on / nS, off: off / nS, n: nS };
        }
        return { ...out, d: face.ctr.distanceTo(eye) };
      })()`), dist);
      if (r.error) { report(backend, `sign legend, ${dist} m`, NaN, NaN, 0.15, 'cd/m2', r.error); report(backend, `sign background, ${dist} m`, NaN, NaN, 0.15, 'cd/m2', r.error); continue; }
      for (const k of ['legend', 'background']) {
        const x = r[k];
        if (x.error) report(backend, `sign ${k}, ${dist} m`, NaN, NaN, 0.15, 'cd/m2', x.error);
        else report(backend, `sign ${k}, ${dist} m (on - off)`, x.expected, x.measured, 0.15, 'cd/m2', `${x.n} texels, sign at ${r.d.toFixed(0)} m`);
      }
      if (dist === 150 && !r.legend.error) {
        report(backend, 'sign legend 150 m, lamps on (7.4)', NaN, r.legend.on, [10, 60], 'cd/m2', 'the plan\'s acceptance');
        report(backend, 'sign legend 150 m, lamps off (7.4)', NaN, r.legend.off, [0, 1], 'cd/m2', 'zero with the lamps off');
      }
    }
  }
  return page;
}

const started = Date.now();
for (const backend of backends) {
  const pages = [];
  try {
    if (want('pool') || want('sprite')) pages.push(await lamps(backend));
    if (want('road') || want('sign')) pages.push(await headlights(backend));
  } catch (e) {
    console.log(`${backend} ERROR ${e.message}`);
    rows.push({ backend, quantity: 'run', pass: false });
  }
  for (const p of pages) {
    const problems = [...new Set(p.problems)];
    if (problems.length) console.log(`  ${backend} said:\n    ${problems.slice(0, 8).join('\n    ')}`);
    await p.close();
  }
}
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length} probes, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`);
await browser.close();
process.exit(failed ? 1 : 0);

// A probe of the wet road on plan 01's renderer (plan 02, D8.1; third stretch), in the shipped look, scene-referred
// (window.__skyline.probe: cd/m^2 before exposure). On I-15 by day, clean camera looking down the lanes ahead:
//   1. dry, every term zero: the same pixels of asphalt with the weather part (dry) and without it (?parts=none) are
//      equal within NOISE.
//   2. wet against the model: the same pixels dry and in heavy rain (rain and spray hidden: asphalt only) against
//      wetMirror.js wetFragment, the rules the term implements: L_wet = k x L_dry + sky x cover x gloss x F(view), with
//      k = 1 - cover x (1 - WET_DIFFUSE), the sky's luminance the term was given, and the view angle of each pixel.
//      Within TOLERANCE.
// --control sets the term's gloss to 0 on the GPU while keeping the model's: the wet check must then fail (it shows the
// probe sees the sheen). No weather service is reached: the weather hosts do not resolve and /api/weather answers 503.
// Serve the repository (pnpm exec vite --port 5324 --strictPort), then:
//   node tests/manual/rain-probe.mjs [--port 5324] [--backend webgpu|webgl] [--control]
// Exit code 0 when both checks pass.
import { chromium } from '@playwright/test';
import { wetFragment, waterCover } from '../../src/drive/weather/wetMirror.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', 5324)), backend = opt('backend', 'webgpu'), control = args.includes('--control');
const NOISE = 0.005, TOLERANCE = 0.05;
const AT = { route: 'i15n', s: 44200, t: Date.parse('2026-11-21T20:30:00Z'), look: { yaw: 0, pitch: -12, lens: 50 } };
// pixels of the lanes ahead (NDC): the near lanes, on both sides of the car's lane line
const POINTS = [[-0.12, -0.62], [0.12, -0.62], [-0.06, -0.45], [0.06, -0.45], [0, -0.75]];

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
  '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'] });

async function open(parts) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.route(/\/api\/weather/, (r) => r.fulfill({ status: 503, body: '' }));
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend}&parts=${parts}`);
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 240000 });
  // the quality level pinned before Drive is entered: a level change on WebGPU leaves every later frame broken (plan 01's
  // shadow map is destroyed while bound, "Destroyed texture ShadowDepthTexture used in a submit"), and every probe reads 0
  await page.evaluate(() => window.__skyline.quality?.set('high'));
  await page.evaluate(async (AT) => {
    const sk = window.__skyline, d = sk.drive;
    sk.attractions?.freeze?.(20); await sk.attractions?.ready;
    await d.start(AT.route, { s: AT.s, t: AT.t, view: 'clean' });
    d.pause(); d.setView('clean');
  }, AT);
  return page;
}

/** Set the rain (when the part is there), seek, settle; then the luminance and the view's cosine at each point. */
async function measure(page, { rain, gloss = null }) {
  return page.evaluate(async ({ AT, POINTS, rain, gloss }) => {
    const sk = window.__skyline, d = sk.drive;
    let w = null;
    for (let i = 0; i < 300 && rain !== null && !w; i++) {
      sk.scene.traverse((o) => { if (o.userData?.weatherPart) w = o.userData.weatherPart; });
      if (!w) await new Promise((r) => setTimeout(r, 100));
    }
    if (w) { if (typeof rain === 'string') w.setPreset(rain); else w.setRain(rain); await w.whenApplied(); }
    d.seek({ s: AT.s, t: AT.t }); d.look(AT.look);
    await d.whenSettled();
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    for (const name of ['rain', 'spray']) { const o = sk.scene.getObjectByName(name); if (o) o.material.visible = false; } // asphalt only (the part sets the meshes' own visibility each frame)
    if (w && gloss !== null) w.wetUniforms.uWetRoad.value.w = gloss;
    const cam = sk.camera, rc = new sk.three.Raycaster();
    // which way up the probe reads: plan 01's pipeline.probe (2026-11-24) puts NDC y into the texture's v unflipped, so
    // probe(x, y) reads the pixel at -y on both backends. Found here, by the sky (blue) and the asphalt below it
    const blue = (c) => c[2] / Math.max(c[0], 1e-9);
    const up = await sk.probe(0, 0.95), down = await sk.probe(0, -0.95);
    const flip = blue(down.rgb) > blue(up.rgb) ? -1 : 1;
    const out = [];
    for (const [x, y] of POINTS) {
      const p = await sk.probe(x, flip * y);
      rc.setFromCamera({ x, y }, cam);
      const h = rc.intersectObjects(sk.scene.children, true).find((i) => i.object.visible && i.object.isMesh);
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      const eye = new sk.three.Vector3().setFromMatrixPosition(cam.matrixWorld);
      out.push({ x, y, L: p.luminanceCdM2, cosView: Math.max(0, n.dot(eye.sub(h.point).normalize())), hit: h.object.material?.name, flip });
    }
    if (out.some((o) => o.hit !== 'road' && o.hit !== 'road-near')) return { error: `not asphalt: ${out.map((o) => o.hit).join(', ')}` };
    const state = w ? w.state() : null;
    const sky = w ? w.wetUniforms.uWetSky.value.toArray() : null;
    return { points: out, renderer: sk.rendererInfo, wetness: state?.wetness ?? 0, sky, cityFactor: sk.env.state.lights.cityFactor, stats: w?.stats() ?? null };
  }, { AT, POINTS, rain, gloss });
}

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
let failed = 0;

// 1. dry: on against off
const off = await open('none');
const dryOff = await measure(off, { rain: null });
for (const m of [dryOff]) if (m.error) { console.log(m.error); process.exit(1); }
console.log(`probe orientation: ${dryOff.points[0].flip === -1 ? 'reads -y (plan 01 pipeline.probe is flipped)' : 'as documented'}`);
await off.close();
const on = await open('weather');
const dryOn = await measure(on, { rain: 0 });
if (dryOn.error) { console.log(dryOn.error); process.exit(1); }
console.log('1. dry, the part on against off (cd/m^2, scene-referred)');
for (let i = 0; i < POINTS.length; i++) {
  const a = dryOff.points[i].L, b = dryOn.points[i].L, rel = Math.abs(b - a) / Math.max(a, 1e-9);
  const ok = rel <= NOISE;
  if (!ok) failed++;
  console.log(`   (${POINTS[i].join(', ')})  off ${a.toFixed(3)}  on ${b.toFixed(3)}  ${(rel * 100).toFixed(3)} %  ${ok ? 'PASS' : 'FAIL'} (limit ${NOISE * 100} %)`);
}

// 2. wet against the model
const wet = await measure(on, { rain: 'heavy', gloss: control ? 0 : null });
if (wet.error) { console.log(wet.error); process.exit(1); }
const skyCd = wet.sky.map((v) => v * wet.cityFactor);
// a check of nothing is a failure: the frame must be wet (heavy rain: wetness 1 - exp(-6))
if (!(wet.wetness > 0.99)) { failed++; console.log(`   FAIL: not wet (wetness ${wet.wetness}): the rain was not applied`); }
console.log(`2. heavy rain against wetMirror.js (wetness ${wet.wetness.toFixed(4)}, sky ${lum(skyCd).toFixed(0)} cd/m^2${control ? ', CONTROL: gloss 0 on the GPU' : ''})`);
for (let i = 0; i < POINTS.length; i++) {
  const Ld = dryOn.points[i].L, Lw = wet.points[i].L, c = wet.points[i].cosView;
  // the wheel paths' wear is not known at a pixel; at this wetness the cover is the same anywhere (within 0.3 %)
  const f = wetFragment({ wetness: wet.wetness, path: 0, cosView: c, kind: 'road', sky: skyCd, diffuse: [Ld, Ld, Ld] });
  const model = f.diffuse[0] + lum(f.slL);
  const rel = Math.abs(Lw - model) / model;
  const ok = rel <= TOLERANCE;
  if (!ok) failed++;
  console.log(`   (${POINTS[i].join(', ')})  cos ${c.toFixed(3)}  dry ${Ld.toFixed(3)}  wet ${Lw.toFixed(3)}  model ${model.toFixed(3)} (k ${f.k.toFixed(3)}, sheen ${lum(f.slL).toFixed(3)}, cover ${waterCover(wet.wetness).toFixed(4)})  ratio ${(Lw / Ld).toFixed(3)} vs ${(model / Ld).toFixed(3)}  ${(rel * 100).toFixed(2)} %  ${ok ? 'PASS' : 'FAIL'} (limit ${TOLERANCE * 100} %)`);
}
console.log(JSON.stringify({ asked: backend, renderer: wet.renderer, control, statsWet: wet.stats }));
await browser.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

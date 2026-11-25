// Pictures and measurements of dusk and night from the air (plan 03, F6.3, F6.4, F8.1, sections 7.7, 7.8, 7.11, 7.14,
// 9.1) in the running app on this machine's GPU. For the dusk and night flights (or those named with --flights), at
// cruise, through 18,000 ft, through 10,000 ft, the turn to final (the largest bank between 10,000 ft and 1,000 ft above
// the runway), 150 s out (base: the airport often to one side), 60 s out, the threshold, touchdown and the rollout (20 s after touchdown); from each seat of
// --seats (default the flight's own, 23F, and the same row's other side, 23A, which faces the city on these arrivals);
// through the window (the cabin, the frame and the pane) and clean (no cabin):
//
//   pictures     <out>/<backend>/<flight>_<moment>_<seat>_<view>.jpg and a contact sheet per flight,
//                <out>/<backend>/sheet_<flight>.html (moments down, seat and view across)
//   regions      the light of named regions before exposure (cd/m^2, pipeline.probe and the cabin stage's probe through
//                __skyline.flight.luminance()), its hue and saturation, and what the screen shows there (sRGB 0..255
//                read back from the picture, so "clipped" and "black" can be told apart):
//                  wall, frame        the cabin's sidewall beside the window and the window's reveal (window view)
//                  winglet            the inner face of the own side's winglet (the nav light's green)
//                  wingMid            the upper surface of the wing half way out (the beacon's and strobe's wash)
//                  nacelle            the top of the own side's engine (the wing inspection light)
//                  valley             the ground below the horizon along the view, at 2, 5, 10 and 20 degrees below it
//                                     (a mean of the picture's pixels in a 41 x 41 box round each, and the probe at its
//                                     centre: light points make one pixel a lottery)
//                  horizon            the sky 0.7 degrees above the horizon
//                each found by projecting body-axes points of the airframe (checked by a ray from the eye: the first
//                thing hit must be that part) or directions from the eye; through the window the cabin's wall can
//                stand in front of a part (the picture shows it: the composed light is the wall's then);
//   frame cost   draws, triangles and the frame time (perf.throughput: frames drawn back to back) with and without the
//                night ground, from the flight's own seat (--cost off skips it);
//   counts       the night ground's (lamps drawn, lit share, extinction length) and the airport's.
// Writes <out>/<backend>/measure.json and <out>/<backend>/table.md (one row per moment, seat and view).
//
// Serve the app first (a dev server or a build):
//   pnpm exec vite --port 5441 --strictPort
// then:
//   node tests/manual/flight-night-shots.mjs <out> [--port 5441] [--backend webgpu|webgl2]
//     [--flights lv-19-dusk,lv-19-night,lv-26-night] [--moments cruise,threshold] [--seats 23F,23A]
//     [--views window,clean] [--size 1280x800] [--cost on|off] [--ev 0]   (--ev: exposure compensation, EV)
// From a normal shell on macOS (a sandboxed one gives the browser software rendering).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const VALUED = ['--port', '--backend', '--flights', '--moments', '--views', '--size', '--seats', '--cost', '--ev'];
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const out = args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1]));
if (!out) {
  console.error('usage: node tests/manual/flight-night-shots.mjs <out> [--port 5441] [--backend webgpu|webgl2] [--flights a,b] [--moments a,b] [--seats 23F,23A] [--views window,clean] [--size 1280x800] [--cost on|off]');
  process.exit(2);
}
const port = opt('--port') || 5441;
const backends = opt('--backend') ? [opt('--backend')] : ['webgpu', 'webgl2'];
const DIR = 'public/data/lv/flights';
const ids = opt('--flights') ? opt('--flights').split(',') : ['lv-19-dusk', 'lv-19-night', 'lv-26-night'];
const onlyMoments = opt('--moments') ? opt('--moments').split(',') : null;
const views = opt('--views') ? opt('--views').split(',') : ['window', 'clean'];
const seatsAsked = opt('--seats') ? opt('--seats').split(',') : null;
const cost = opt('--cost') !== 'off';
// exposure compensation in EV (the app's setting exposureComp): to show what a brighter night exposure would give
const ev = Number(opt('--ev') || 0);
const [W, H] = (opt('--size') || '1280x800').split('x').map(Number);
const ORDER = ['cruise', 'fl180', 'ft10000', 'turn', 'base', 'sixty-out', 'threshold', 'touchdown', 'rollout'];

/** The moments of one flight, seconds from its start, read from its header and channels. */
function momentsOf(id) {
  const header = JSON.parse(readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  const bin = new Float32Array(readFileSync(path.join(DIR, `${id}.bin`)).buffer.slice(0));
  const ch = (name) => { const k = header.channels.indexOf(name); return bin.subarray(k * header.samples, (k + 1) * header.samples); };
  const ev = (k) => header.events.find((e) => e.id === k)?.t;
  const td = ev('touchdown'), roll = ch('roll');
  const from = ev('10000') ?? 0, to = ev('ft1000') ?? td - 60;
  let turn = from, best = 0;
  for (let i = Math.ceil(from); i < to; i++) if (Math.abs(roll[i]) > best) { best = Math.abs(roll[i]); turn = i; }
  const m = { cruise: 0, fl180: ev('fl180'), ft10000: ev('10000'), turn, base: td - 150, 'sixty-out': td - 60, threshold: ev('threshold'), touchdown: td + 1, rollout: Math.min(header.samples - 1, td + 20) };
  return Object.fromEntries(Object.entries(m).filter(([k, v]) => Number.isFinite(v) && (!onlyMoments || onlyMoments.includes(k))));
}

/** In the page: find the named regions on the screen now (NDC), with what the ray from the eye hits. */
function regionsInPage({ side }) {
  const s = window.__skyline, cam = s.camera, V = s.three.Vector3;
  const af = s.scene.getObjectByName('airframe');
  const out = {};
  const sign = side === 'left' ? -1 : 1, suffix = side === 'left' ? '_L' : '_R';
  const meshes = [];
  if (af) { af.updateMatrixWorld(true); af.traverse((o) => { if (o.isMesh && o.visible && o.name !== 'aircraft-lamps') meshes.push(o); }); }
  const rc = new s.three.Raycaster();
  rc.layers.enableAll();
  cam.updateMatrixWorld();
  const toNdc = (w) => { const p = w.clone().project(cam); return Math.abs(p.x) < 0.98 && Math.abs(p.y) < 0.98 ? [p.x, p.y] : null; };
  const firstHit = (w) => {
    const d = w.clone().sub(cam.position), dist = d.length();
    rc.set(cam.position, d.normalize()); rc.near = 0; rc.far = dist + 50;
    const h = rc.intersectObjects(meshes, false)[0];
    return h ? { name: h.object.name, dist: h.distance, want: dist } : null;
  };
  // airframe parts: candidate body points (right side; mirrored for the left), the first one seen wins
  const PARTS = {
    winglet: { prefix: ['Wing' + suffix + '_1'], pts: [[17.25, 4.4, 4.9], [17.3, 4.8, 5.3], [17.2, 4.1, 4.6], [17.4, 5.3, 5.7], [17.35, 4.6, 5.6]] },
    wingMid: { prefix: ['Wing' + suffix + '_2', 'Spoiler', 'Slat', 'Flap', 'Aileron'], pts: [[9.1, 3.0, 0.6], [8.5, 2.95, 1.2], [10.0, 3.05, 1.2], [9.5, 3.0, -0.2], [7.5, 2.9, 0.5]] },
    nacelle: { prefix: ['Engine' + suffix, 'ReverserSleeve' + suffix], pts: [[4.83, 2.55, -5.2], [5.5, 2.4, -5.2], [5.7, 2.0, -6.0], [4.83, 2.6, -4.0], [5.6, 2.3, -3.8], [5.8, 1.7, -5.0]] },
  };
  for (const [name, p] of Object.entries(PARTS)) {
    for (const q of p.pts) {
      const w = new V(q[0] * sign, q[1], q[2]).applyMatrix4(af.matrixWorld);
      const ndc = toNdc(w);
      if (!ndc) continue;
      const h = firstHit(w);
      if (h && p.prefix.some((pr) => h.name.startsWith(pr)) && Math.abs(h.dist - h.want) < 0.6) { out[name] = { ndc, part: h.name }; break; }
    }
  }
  // the horizon and the ground below it, along the view's azimuth: the Earth's centre straight below the scene origin
  const R = 6371008.8;
  const up = cam.position.clone().add(new V(0, R, 0)).normalize();
  const h = Math.max(1, cam.position.clone().add(new V(0, R, 0)).length() - R);
  const dip = Math.acos(R / (R + h));
  const fwd = new V(0, 0, -1).applyQuaternion(cam.quaternion);
  const horiz = fwd.clone().sub(up.clone().multiplyScalar(fwd.dot(up))).normalize();
  const dirAt = (belowRad) => horiz.clone().multiplyScalar(Math.cos(belowRad)).sub(up.clone().multiplyScalar(Math.sin(belowRad)));
  const deg = Math.PI / 180;
  const at = (dir) => { const w = cam.position.clone().add(dir.multiplyScalar(500)); const ndc = toNdc(w); if (!ndc) return null; const hit = firstHit(cam.position.clone().add(dir.normalize().multiplyScalar(500))); return hit && hit.dist < 450 ? null : ndc; };
  const g = at(dirAt(dip - 0.7 * deg));
  if (g) out.horizon = { ndc: g };
  for (const k of [2, 5, 10, 20]) { const v = at(dirAt(dip + k * deg)); if (v) out[`valley${k}`] = { ndc: v }; }
  // the cabin, at fixed places of the default look (the window centred): the wall beside it and the reveal
  out.wall = { ndc: [-0.81, 0.1], cabin: true };
  out.frame = { ndc: [-0.57, 0.0], cabin: true };
  return { regions: out, dipDeg: dip / deg };
}

/** Hue (degrees) and saturation (0..1) of a linear RGB triple. */
function hueSat([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx <= 0) return { hue: null, sat: 0 };
  const hue = (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
  return { hue: Math.round((hue + 360) % 360), sat: +((mx - mn) / mx).toFixed(2) };
}

/** In the page: the mean sRGB of a box of a picture round each pixel, and its brightest pixel. */
function boxesInPage({ b64, boxes, half }) {
  return (async () => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const res = {};
    for (const [k, [px, py]] of Object.entries(boxes)) {
      const x0 = Math.max(0, Math.round(px) - half), y0 = Math.max(0, Math.round(py) - half);
      const w = Math.min(img.width - x0, 2 * half + 1), h = Math.min(img.height - y0, 2 * half + 1);
      if (w <= 0 || h <= 0) continue;
      const d = x.getImageData(x0, y0, w, h).data;
      let r = 0, g = 0, b = 0, peak = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; peak = Math.max(peak, 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]); }
      const centre = x.getImageData(Math.round(px), Math.round(py), 1, 1).data;
      res[k] = { mean: [r / n, g / n, b / n].map(Math.round), peak: Math.round(peak), centre: [centre[0], centre[1], centre[2]] };
    }
    return res;
  })();
}

function sheet(dir, id, cols, names, measures) {
  const head = `<tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  const rows = names.map((n) => {
    const any = cols.map((c) => measures[c]?.[n]).find(Boolean) || {};
    const label = [n, any.altMsl != null ? `${Math.round(any.altMsl * 3.28084)} ft` : '', any.sunAltDeg != null ? `sun ${any.sunAltDeg.toFixed(1)}°` : ''].filter(Boolean).join('<br>');
    return `<tr><th>${label}</th>${cols.map((c) => {
      const r = measures[c]?.[n];
      if (!r) return '<td></td>';
      const line = [r.msPerFrame != null ? `${r.msPerFrame} ms (${r.msWithoutNightGround ?? '?'} w/o ground)` : '', r.drawCalls != null ? `${r.drawCalls} draws` : '',
        r.ground ? `${r.ground.drawn ?? '?'} lamps, lit ${r.ground.lit}` : '', `k ${r.exposure?.toExponential(2)}`].filter(Boolean).join(' · ');
      return `<td><img src="${id}_${n}_${c}.jpg"><div>${line}</div></td>`;
    }).join('')}</tr>`;
  }).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>${id}</title>
<style>body{background:#111;color:#ddd;font:11px system-ui;margin:12px}table{border-collapse:collapse}td,th{vertical-align:top;padding:3px}
img{width:360px;display:block}th{text-align:left;font-weight:600}</style><h1>${id}</h1><table>${head}${rows}</table>`;
  writeFileSync(path.join(dir, `sheet_${id}.html`), html);
}

const REGION_ORDER = ['wall', 'frame', 'winglet', 'wingMid', 'nacelle', 'valley2', 'valley5', 'valley10', 'valley20', 'horizon'];
function table(measure) {
  const lines = [`# ${measure.backend}, ${measure.date}`, '',
    'Each region: the light before exposure in cd/m^2 (composed: the cabin over the outside), hue and saturation of that light, and the picture there (mean sRGB of a 41 x 41 box / its peak). "—" not in view; "cov" covered by the cabin.', ''];
  const cols = ['flight', 'moment', 'seat', 'view', 'alt ft', 'sun°', 'k', 'lamps', 'lit', ...REGION_ORDER];
  lines.push(`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
  for (const [id, byCol] of Object.entries(measure.flights)) {
    for (const [col, byMoment] of Object.entries(byCol)) {
      const [seat, view] = col.split('_');
      for (const n of ORDER) {
        const r = byMoment[n];
        if (!r) continue;
        const cell = (k) => {
          const g = r.regions?.[k];
          if (!g) return '—';
          if (g.covered) return 'cov';
          const lum = g.composed ?? g.outside;
          const hs = g.hueSat?.hue != null && g.hueSat.sat > 0.15 ? ` h${g.hueSat.hue}/s${g.hueSat.sat}` : '';
          const pic = g.picture ? ` [${Math.round((g.picture.mean[0] + g.picture.mean[1] + g.picture.mean[2]) / 3)}/${g.picture.peak}]` : '';
          return `${lum != null ? lum.toPrecision(2) : '?'}${hs}${pic}`;
        };
        lines.push(`| ${id} | ${n} | ${seat} | ${view} | ${Math.round(r.altMsl * 3.28084)} | ${r.sunAltDeg?.toFixed(1)} | ${r.exposure?.toExponential(2)} | ${r.ground?.drawn ?? ''} | ${r.ground?.lit ?? ''} | ${REGION_ORDER.map(cell).join(' | ')} |`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});
const hideUi = () => {
  const canvas = document.querySelector('canvas');
  for (const el of document.body.children) if (!el.contains(canvas)) el.dataset.shotHidden = el.style.visibility = 'hidden';
};
const showUi = () => { for (const el of document.body.querySelectorAll('[data-shot-hidden]')) { el.style.visibility = ''; delete el.dataset.shotHidden; } };

for (const backend of backends) {
  const dir = path.join(out, backend);
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/flights\/[\w-]+\.jpg/.test(m.location()?.url || '')) problems.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.url()}`); });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* */ } });
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend === 'webgl2' ? 'webgl' : backend}`);
  await page.waitForFunction(() => window.__skyline && window.__skyline.flight && document.getElementById('loading').classList.contains('done'), null, { timeout: 240_000 });
  await page.evaluate(async () => { const s = window.__skyline; if (s.attractions) { await s.attractions.ready; s.attractions.freeze(47); } await s.flight.ready; });
  if (ev) await page.evaluate((e) => window.__skyline.setSetting('exposureComp', e), ev);
  const gpu = await page.evaluate(() => window.__skyline.perf.gpu());
  console.log(backend, JSON.stringify(gpu));
  if (gpu.backend !== backend) throw new Error(`asked for ${backend}, drawing on ${gpu.backend}`);
  const measure = { backend, gpu, size: [W, H], date: new Date().toISOString(), flights: {} };

  for (const id of ids) {
    const moments = momentsOf(id);
    measure.flights[id] = {};
    const own = await page.evaluate(async (fid) => { const f = window.__skyline.flight; await f.start(fid, { pace: false, play: false }); f.options({ hud: false }); return f.state().seat; }, id);
    const seats = seatsAsked ?? [own, own.replace(/[A-Z]$/, (c) => (c <= 'C' ? 'F' : 'A'))];
    const cols = [];
    for (const seat of seats) for (const view of views) cols.push(`${seat}_${view}`);
    for (const [name, at] of Object.entries(moments)) {
      for (const seat of seats) {
        for (const view of views) {
          const col = `${seat}_${view}`;
          const measureCost = cost && seat === own;
          const r = await page.evaluate(async ({ at, clean, seatId, measureCost }) => {
            const s = window.__skyline, f = s.flight;
            if (f.state().seat !== seatId) f.setSeat(seatId);
            f.options({ frame: !clean });
            await f.seek({ at });
            await f.whenSettled();
            await f.whenSettled();
            const info = s.perf.info();
            let tp = null, without = null;
            if (measureCost) {
              tp = await s.perf.throughput(40, 8);
              // what the night ground costs the GPU: the same frame without it (its group hidden for the measurement)
              const g = s.scene.getObjectByName('flight-night-ground');
              if (g && g.visible) { g.visible = false; without = await s.perf.throughput(40, 8); g.visible = true; await s.perf.throughput(4, 2); }
            }
            const st = f.state(), stats = f.stats();
            const w = stats.world || {};
            return {
              t: st.t, altMsl: Math.round(st.altMsl), heightAboveGround: +st.heightAboveGround.toFixed(1), headingDeg: +st.headingDeg.toFixed(1),
              rollDeg: +st.rollDeg.toFixed(1), lights: st.lights,
              drawCalls: info.calls, triangles: info.triangles, msPerFrame: tp ? +tp.msPerFrame.toFixed(2) : null,
              msWithoutNightGround: without ? +without.msPerFrame.toFixed(2) : null,
              region: w.region && { triangles: w.region.triangles, drawCalls: w.region.drawCalls },
              airport: w.airport && { drawCalls: w.airport.drawCalls, lights: w.airport.lights, night: w.airport.night },
              ground: w.ground ? { drawn: w.ground.drawn, lit: w.ground.lit, extinctionKm: w.ground.extinctionKm, ambientLux: w.ground.ambientLux, draws: w.ground.draws, updateMs: w.ground.updateMs, lampsInView: w.ground.lamps?.lampsInView } : null,
              sunAltDeg: s.env.state?.sun?.altDeg ?? null,
              exposure: s.env?.nodes?.exposure?.value ?? null,
            };
          }, { at, clean: view !== 'window', seatId: seat, measureCost });
          const side = /[A-C]$/.test(seat) ? 'left' : 'right';
          const found = await page.evaluate(regionsInPage, { side });
          // the light there, before exposure, and the cabin's coverage
          const regions = {};
          for (const [k, g] of Object.entries(found.regions)) {
            if (g.cabin && view !== 'window') continue;
            const L = await page.evaluate(async ([x, y]) => {
              const s = window.__skyline;
              const l = await s.flight.luminance({ x, y });
              const p = await s.pipeline.probe(x, y);
              return { ...l, rgb: p.rgb };
            }, g.ndc);
            // the pane is in the cabin layer too (it draws the outside through itself), so coverage alone does not
            // say the wall is in the way: the picture does
            const covered = false;
            regions[k] = { ndc: g.ndc.map((v) => +v.toFixed(3)), part: g.part, outside: +L.outside.toPrecision(3), composed: +L.composed.toPrecision(3),
              cabin: +L.cabin.toPrecision(3), cabinAlpha: +L.cabinAlpha.toFixed(2), covered, hueSat: hueSat(L.rgb) };
          }
          r.regions = regions;
          r.dipDeg = +found.dipDeg.toFixed(2);
          await page.evaluate(hideUi);
          await page.evaluate(() => window.__skyline.flight.whenSettled());
          const file = path.join(dir, `${id}_${name}_${col}.jpg`);
          const buf = await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
          if (buf.length < 4000) console.log(backend, id, name, col, 'BLANK FRAME');
          await page.evaluate(showUi);
          const boxes = Object.fromEntries(Object.entries(regions).map(([k, g]) => [k, [((g.ndc[0] + 1) / 2) * W, ((1 - g.ndc[1]) / 2) * H]]));
          const pics = await page.evaluate(boxesInPage, { b64: buf.toString('base64'), boxes, half: 20 });
          for (const [k, p] of Object.entries(pics)) regions[k].picture = p;
          (measure.flights[id][col] ??= {})[name] = r;
          console.log(backend, id, name, col, JSON.stringify({ alt: r.altMsl, sun: r.sunAltDeg?.toFixed(2), k: r.exposure, ms: r.msPerFrame, lamps: r.ground?.drawn,
            regions: Object.fromEntries(Object.entries(regions).map(([k, g]) => [k, g.covered ? 'cov' : `${g.composed} ${g.hueSat.hue ?? ''}/${g.hueSat.sat} [${g.picture?.mean}|${g.picture?.peak}]`])) }));
        }
      }
    }
    sheet(dir, id, cols, ORDER.filter((n) => n in moments), measure.flights[id]);
    await page.evaluate(() => window.__skyline.flight.options({ frame: true, hud: true }));
  }
  measure.problems = problems;
  writeFileSync(path.join(dir, 'measure.json'), JSON.stringify(measure, null, 1));
  writeFileSync(path.join(dir, 'table.md'), table(measure));
  if (problems.length) console.log(backend, 'console problems', problems.slice(0, 20));
  await page.close();
}
await browser.close();

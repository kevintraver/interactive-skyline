// Luminance probes of the traffic on plan 01's renderer, in the shipped look (plan 02, D6.4; third stretch, decision
// 6), with the app's window.__skyline.probe (scene-referred cd/m^2 at a screen point, before exposure). Each line prints
// expected, measured, tolerance and PASS or FAIL:
//   probe orientation   a bright marker drawn at NDC y = +0.5 is found there through probeAt (see Orientation)
//   tail lamp at 50 m   the sprite's light at the eye, the sum over its pixels of (L with the vehicle-lamp layer - L
//                       without it) x the pixel's solid angle, against I(c) T / d^2 of the rows drawn there
//   pool under an oncoming head lamp   (L with the pools - L without) x pi / rho on the road 15 m ahead of an oncoming
//                       vehicle's front, against the pool model's lux there (poolsCore.js poolIlluminance x the pool's
//                       scale)
//   lane ribbon at 6 km the ribbons' light along one row of pixels across the strips (L with - L without, summed over
//                       the row in px), against the vehicles they stand for: per strip lambda I(c) T / (d^2 pa^2 |dy/ds|)
//                       (their summed intensity per metre of lane, spread over the drawn width; the row crosses each
//                       strip's whole width)
//
// Orientation. window.__skyline.probe(x, y) (plan 01, src/render/pipeline.js) reads the pixel at NDC (x, -y): it maps y
// to texture v as (y + 1) / 2, and three's node textures have v = 0 at the top. probeAt() mirrors y; the first line
// fails if the probe is ever corrected.
//
// Serve the repository first, then:
//   node tests/manual/traffic-probe.mjs [--port 5325] [--backend webgpu|webgl]
// The exit code is the verdict.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5325));
const backend = opt('backend', 'webgpu');
const NIGHT = Date.parse('2026-11-22T05:00:00Z');
const only = opt('only', null); // 'tail', 'pool' or 'ribbon': one probe (and the orientation)

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const problems = [];
await page.routeWebSocket(/.*/, () => {});
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
await page.goto(`http://localhost:${port}/?city=lv&renderer=webgpu&backend=${backend}&parts=traffic`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 300000 });

const result = await page.evaluate(async ({ NIGHT, only }) => {
  const s = window.__skyline, d = s.drive;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const settle = () => Promise.race([d.whenSettled(), new Promise((r) => setTimeout(r, 60000))]);
  const { vehicleIntensity } = await import('/src/drive/traffic/lamps.js');
  const { poolIlluminance, ASPHALT_RHO } = await import('/src/drive/traffic/poolsCore.js');
  const { DENSITY_Q_MS } = await import('/src/drive/traffic/ribbonCore.js');
  await d.start('i15n', { s: 52000, t: NIGHT, view: 'clean' });
  d.pause(); d.setView('clean'); d.look({ yaw: 0, pitch: 0, lens: 50 });
  let part = null;
  for (let i = 0; i < 900 && !part?.stats().ready; i++) { await raf(); part = s.scene.getObjectByName('traffic')?.userData.part || null; }
  await settle();
  const lines = [];
  const line = (name, expected, measured, rel, unit, extra = '') => {
    const pass = Number.isFinite(measured) && Number.isFinite(expected) && expected > 0 && Math.abs(measured - expected) <= rel * expected;
    lines.push({ name, expected, measured, tol: `+-${(rel * 100).toFixed(0)} %`, unit, pass, extra });
  };
  const Y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const cityFactor = s.uniforms?.cityFactor?.value ?? 1;
  const probeAt = (x, y) => s.probe(x, -y); // see 'Orientation' at the top
  const probeY = async (x, y) => Y((await probeAt(x, y)).rgb) / cityFactor;
  const current = async () => { for (let i = 0; i < 3; i++) await raf(); d.renderFrame(); s.camera.updateMatrixWorld(true); };
  const target = () => s.pipeline.scenePass.renderTarget;
  /** NDC of a pixel centre of the scene pass (row 0 at the top) */
  const ndcOf = (px, py) => { const t = target(); return [((px + 0.5) / t.width) * 2 - 1, 1 - ((py + 0.5) / t.height) * 2]; };
  const pixelOf = (v) => { const p = v.clone().project(s.camera), t = target(); return [((p.x + 1) / 2) * t.width - 0.5, ((1 - p.y) / 2) * t.height - 0.5, p.z]; };
  const pa = () => (2 * Math.tan((s.camera.getEffectiveFOV() * Math.PI) / 360)) / target().height;
  /** the pixel's solid angle off the camera's axis: pa^2 cos^3 */
  const omega = (px, py) => {
    const t = target(), k = pa(), x = (px + 0.5 - t.width / 2) * k, y = (py + 0.5 - t.height / 2) * k;
    return (k * k) / (1 + x * x + y * y) ** 1.5;
  };
  /** aim the head at a world point (the pose's forward is yaw 0) */
  const aim = async (w, lens) => {
    const p = d.pose(), e = p.eye, dx = w.x - e.x, dz = w.z - e.z, dy = w.y - e.y;
    let yaw = ((Math.atan2(-dz, dx) - Math.atan2(-p.forward.z, p.forward.x)) * 180) / Math.PI;
    yaw = ((yaw + 540) % 360) - 180;
    d.look({ yaw, pitch: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI, lens });
    await current();
  };
  const V = (x, y, z) => new s.three.Vector3(x, y, z);
  // hide a mesh from the camera by its layer: every draw runs the parts' beforeRender, which sets `visible` again
  const hide = (mesh, off) => { if (off) mesh.layers.set(31); else mesh.layers.set(0); };

  // ---- the probe's orientation: a bright square 5 m in front of the eye at NDC (0, +0.5)
  {
    await current();
    const at = V(0, 0.5, 0.5).unproject(s.camera), eye = s.camera.position.clone();
    const mat = new s.webgpu.MeshBasicNodeMaterial();
    mat.colorNode = s.tsl.vec3(50, 50, 50);
    const marker = new s.webgpu.Mesh(new s.webgpu.PlaneGeometry(0.4, 0.4), mat);
    marker.position.copy(eye).addScaledVector(at.sub(eye).normalize(), 5);
    marker.quaternion.copy(s.camera.quaternion);
    s.scene.add(marker);
    const top = await probeY(0, 0.5), bottom = await probeY(0, -0.5);
    s.scene.remove(marker);
    const bare = await probeY(0, 0.5);
    lines.push({ name: 'probe orientation', expected: 'marker at y +0.5', measured: +(top / Math.max(bare, 1e-6)).toFixed(1), tol: '> 10x bare', unit: '',
      pass: top > 10 * Math.max(bare, 1e-3) && top > 10 * Math.max(bottom, 1e-3), extra: `marker ${top.toFixed(1)}, mirrored point ${bottom.toFixed(2)}, without it ${bare.toFixed(2)} cd/m2` });
  }

  // ---- a tail lamp's sprite at about 50 m
  if (!only || only === 'tail') {
    const lamps = part.lamps, layer = lamps.layer, [P, C, X] = layer.data, eye0 = s.camera.position;
    let best = -1;
    for (let o = 0; o < lamps.count; o++) {
      const i = 4 * o, dist = Math.hypot(P[i] - eye0.x, P[i + 1] - eye0.y, P[i + 2] - eye0.z);
      const n = lamps.exponents[C[i + 3]];
      if (n !== 4 || C[i + 1] > 0.1 || dist < 35 || dist > 70) continue; // a red lobe-4 lamp (tail or stop)
      if (best < 0 || Math.abs(dist - 50) < Math.abs(Math.hypot(P[4 * best] - eye0.x, P[4 * best + 1] - eye0.y, P[4 * best + 2] - eye0.z) - 50)) best = o;
    }
    if (best < 0) lines.push({ name: 'tail lamp at 50 m', expected: null, measured: null, tol: '', unit: 'lux', pass: false, extra: 'no tail lamp 35 to 70 m away' });
    else {
      const w = V(P[4 * best], P[4 * best + 1], P[4 * best + 2]);
      await aim(w, 50);
      // the rows drawn at that lamp (a braking vehicle's stop sprite sits on its tail lamp)
      const eye = s.camera.position, vis = part.model().ribbons.uniforms.uVisibility.value || 80000;
      let E = 0, dist = 0;
      for (let o = 0; o < lamps.count; o++) {
        const i = 4 * o;
        if (Math.hypot(P[i] - w.x, P[i + 1] - w.y, P[i + 2] - w.z) > 0.05) continue;
        const ex = eye.x - P[i], ey = eye.y - P[i + 1], ez = eye.z - P[i + 2];
        dist = Math.hypot(ex, ey, ez);
        const c = (X[i] * ex + X[i + 1] * ey + X[i + 2] * ez) / dist;
        E += (P[i + 3] * Math.max(c, 0) ** lamps.exponents[C[i + 3]] * Math.exp(-dist / vis)) / (dist * dist);
      }
      const [cx, cy] = pixelOf(w), R = 7;
      const on = [], off = [];
      const pts = [];
      for (let y = Math.round(cy) - R; y <= Math.round(cy) + R; y++) for (let x = Math.round(cx) - R; x <= Math.round(cx) + R; x++) pts.push([x, y]);
      for (const [x, y] of pts) on.push(await probeY(...ndcOf(x, y)));
      hide(layer.mesh, true);
      for (const [x, y] of pts) off.push(await probeY(...ndcOf(x, y)));
      hide(layer.mesh, false);
      let meas = 0, edge = 0;
      pts.forEach(([x, y], k) => {
        const v = (on[k] - off[k]) * omega(x, y);
        meas += v;
        if (Math.abs(x - Math.round(cx)) === R || Math.abs(y - Math.round(cy)) === R) edge += v;
      });
      line('tail lamp at 50 m', E, meas, 0.05, 'lux', `d ${dist.toFixed(1)} m, window ${2 * R + 1} px, its rim ${((edge / meas) * 100).toFixed(2)} % of it`);
    }
  }

  // ---- the road under an oncoming vehicle's head lamp pool, 15 m ahead of its front. On US-93 by Henderson, whose
  // median has no barrier: on I-15 the median's barrier hides the far carriageway's pavement from the eye (1.2 m up)
  if (!only || only === 'pool') {
    await d.start('us93', { s: 27000, t: NIGHT, view: 'clean' });
    d.pause(); d.setView('clean'); d.look({ yaw: 0, pitch: 0, lens: 50 });
    for (let i = 0; i < 900 && !(part.stats().ready && part.stats().route === 'us93'); i++) await raf();
    await settle();
    await current();
    const pools = part.pools, fwd = d.pose().forward;
    let pick = null;
    for (let a = 0; a < 32; a++) {
      const q = pools.instance(a);
      if (!q) break;
      if (q.fwd[0] * fwd.x + q.fwd[2] * fwd.z > -0.9 || q.scale < 0.99) continue; // oncoming, whole
      const front = V(...q.origin), dist = front.distanceTo(s.camera.position);
      if (dist < 40 || dist > 140) continue;
      if (!pick || dist < pick.dist) pick = { q, dist };
    }
    if (!pick) lines.push({ name: 'pool under an oncoming head lamp', expected: null, measured: null, tol: '', unit: 'lux', pass: false, extra: 'no whole oncoming pool 40 to 140 m away' });
    else {
      const { q } = pick, ALONG = 15;
      const w = V(q.origin[0] + q.fwd[0] * ALONG + q.up[0] * 0.02, q.origin[1] + q.fwd[1] * ALONG + q.up[1] * 0.02, q.origin[2] + q.fwd[2] * ALONG + q.up[2] * 0.02);
      await aim(w, 50);
      const [cx, cy] = pixelOf(w);
      const at = ndcOf(Math.round(cx), Math.round(cy));
      const lOn = await probeY(...at);
      hide(pools.mesh, true);
      const lOff = await probeY(...at);
      hide(pools.mesh, false);
      const E = poolIlluminance(0, ALONG, q.half, q.height) * q.scale * pools.uniforms.uGain.value;
      line('pool under an oncoming head lamp', E, ((lOn - lOff) * Math.PI) / ASPHALT_RHO, 0.1, 'lux',
        `vehicle front ${pick.dist.toFixed(0)} m away, point ${ALONG} m ahead of it on its axis; road ${lOff.toFixed(4)} cd/m2 without the pool, ${lOn.toFixed(4)} with`);
    }
  }

  // ---- a lane ribbon at 6 km ahead
  if (!only || only === 'ribbon') {
    // a place on I-15 whose lanes 6 km ahead are in sight (no road or ground between the eye and them: a crest hides
    // them as it should), found by casting a ray at each candidate
    await d.start('i15n', { s: 12000, t: NIGHT, view: 'clean' });
    d.pause(); d.setView('clean');
    for (let i = 0; i < 900 && !(part.stats().ready && part.stats().route === 'i15n'); i++) await raf();
    const rc = new s.three.Raycaster();
    let model, rib, g, u, pos, info, tan, truck, strips, centre = null, sT = 0, where = 0;
    for (const sCand of [4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000, 26000, 28000, 30000, 32000, 34000, 36000, 38000, 40000]) {
      d.seek({ s: sCand, t: NIGHT });
      d.look({ yaw: 0, pitch: 0, lens: 50 });
      await settle();
      await current();
      model = part.model(); rib = model.ribbons; g = rib.mesh.geometry; u = rib.uniforms;
      pos = g.attributes.position.array; info = g.attributes.aInfo.array; tan = g.attributes.aTangent.array; truck = g.attributes.aTruck.array;
      sT = d.pose().s + 6000;
      // the vertex pairs nearest sT of each strip
      strips = new Map();
      for (let v = 0; v < info.length / 4; v += 2) {
        const row = Math.round(info[4 * v + 1]), dS = Math.abs(info[4 * v] - sT);
        if (!strips.has(row) || dS < strips.get(row).dS) strips.set(row, { v, dS, row });
      }
      // clear sight from the eye to both carriageways' outer strips from 500 m short of sT to 200 m past it
      const clear = (row) => {
        for (let v = 0; v < info.length / 4; v += 2) {
          if (Math.round(info[4 * v + 1]) !== row || info[4 * v] < sT - 500 || info[4 * v] > sT + 200) continue;
          const q = V(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]), e = s.camera.position.clone(), dir = q.clone().sub(e), L = dir.length();
          rc.set(e, dir.normalize()); rc.far = L - 1;
          if (rc.intersectObjects(s.scene.children, true).some((h) => h.object.visible && !/traffic|valley|sprite|lamp/.test(h.object.name))) return false;
        }
        return true;
      };
      const first = [...strips.values()].find((x) => x.row < 8);
      const c = V(pos[3 * first.v], pos[3 * first.v + 1], pos[3 * first.v + 2]);
      const hit = !(clear(0) && clear(8));
      if (!hit) { centre = c; where = sCand; break; }
    }
    if (!centre) { lines.push({ name: 'lane ribbon at 6 km', expected: null, measured: null, tol: '', unit: 'cd/m2 px', pass: false, extra: 'no candidate place sees its lanes 6 km ahead' }); return { lines, renderer: s.rendererInfo }; }
    await aim(centre, 200);
    const k = pa(), eye = s.camera.position, simMs = s.clock.timeMs;
    const qn = Math.floor(simMs / DENSITY_Q_MS), f = (simMs - qn * DENSITY_Q_MS) / DENSITY_Q_MS;
    const dens = new Float32Array(8), dens1 = new Float32Array(8);
    const lambdaAt = (row, sq, w) => {
      model.traffic.laneDensities(row < 8 ? 'with' : 'against', sq, qn * DENSITY_Q_MS, dens);
      model.traffic.laneDensities(row < 8 ? 'with' : 'against', sq, (qn + 1) * DENSITY_Q_MS, dens1);
      return (dens[row % 8] * (1 - f) + dens1[row % 8] * f) * w;
    };
    // one lane alone: the oncoming lane with the most vehicles at sT; the other lanes' rows of the density table are
    // emptied for the measurement (the lanes lie within a pixel or two of each other at 6 km) and restored after
    const one = [...strips.values()].filter((x) => x.row >= 8).map((x) => ({ ...x, lambda: lambdaAt(x.row, info[4 * x.v], info[4 * x.v + 3]) }))
      .sort((a, b) => b.lambda - a.lambda)[0];
    const tex = u.tDensity.value, data = tex.image.data, bins = u.uBins.value, saved = data.slice();
    for (let r = 0; r < data.length / bins; r++) if (r % 16 !== one.row) data.fill(0, r * bins, (r + 1) * bins);
    tex.needsUpdate = true;
    await current();
    const v = one.v, p = V(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]), t = V(tan[3 * v], tan[3 * v + 1], tan[3 * v + 2]);
    const [ax, ay] = pixelOf(p), [tx, ty] = pixelOf(p.clone().add(t));
    const dpx = tx - ax, dpy = ty - ay, pxPerM = Math.hypot(dpx, dpy);
    const dist = p.distanceTo(eye), c = t.dot(eye.clone().sub(p).divideScalar(dist));
    const I = vehicleIntensity(c, truck[v]), T = Math.exp(-dist / u.uVisibility.value) / (dist * dist);
    // the lamps' summed intensity per metre of lane (lambda I T / d^2, lux per metre) over the strip's drawn width: W
    // pixels across x pxPerM pixels per metre, each pa^2 sr; at the pixel nearest the lane, its Gaussian across there
    const W = u.uWidthPx.value, sigma = W / Math.sqrt(Math.PI);
    const peak = (one.lambda * (I[0] + I[1] + I[2]) * T * u.uLit.value * u.uGain.value) / (k * k * pxPerM * W);
    const px = Math.round(ax), py = Math.round(ay);
    const across = Math.abs(((px - ax) * -dpy + (py - ay) * dpx) / pxPerM);
    const expected = peak * Math.exp(-((across / sigma) ** 2));
    const at = ndcOf(px, py);
    const lOn = await probeY(...at);
    // the column through the lane, for the share of the strip's width that is drawn (see the report line)
    const col = [];
    for (let y = py - 4; y <= py + 4; y++) col.push(await probeY(...ndcOf(px, y)));
    hide(rib.mesh, true);
    const lOff = await probeY(...at);
    const colOff = [];
    for (let y = py - 4; y <= py + 4; y++) colOff.push(await probeY(...ndcOf(px, y)));
    hide(rib.mesh, false);
    data.set(saved); tex.needsUpdate = true;
    const meas = lOn - lOff;
    const drawn = col.reduce((a, l, i) => a + l - colOff[i], 0) / ((peak * W) / Math.max(Math.abs(dpx) / pxPerM, 1e-3));
    line('lane ribbon at 6 km', expected, meas, 0.15, 'cd/m2',
      `I-15 at s ${where}, lane row ${one.row} (oncoming) ${(dist / 1000).toFixed(2)} km away, ${(one.lambda * 1000).toFixed(2)} vehicles/km, ${(I[0] + I[1] + I[2]).toFixed(0)} cd each toward the eye, ${pxPerM.toExponential(2)} px/m, lens 200 mm; the column through it holds ${(drawn * 100).toFixed(0)} % of the strip's light (see the report)`);
  }
  return { lines, renderer: s.rendererInfo };
}, { NIGHT, only });

console.log(`renderer ${result.renderer.kind}/${result.renderer.backend}\n`);
console.log('probe                              expected        measured        tolerance   unit        verdict');
let failed = 0;
for (const l of result.lines) {
  if (!l.pass) failed++;
  const f = (v) => (typeof v === 'number' ? (Math.abs(v) < 0.01 ? v.toExponential(3) : v.toFixed(4)) : String(v));
  console.log(`${l.name.padEnd(34)} ${f(l.expected).padStart(14)}  ${f(l.measured).padStart(14)}  ${String(l.tol).padStart(10)}   ${String(l.unit).padEnd(10)}  ${l.pass ? 'PASS' : 'FAIL'}  ${l.extra}`);
}
const p = [...new Set(problems)];
if (p.length) console.log(`\nthe page said:\n  ${p.slice(0, 10).join('\n  ')}`);
console.log(`\n${result.lines.length} probes, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);

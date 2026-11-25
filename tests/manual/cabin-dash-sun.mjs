// The dashboard in the Sun (plan 02, D4.2; a defect seen 2026-11-24): from the cabin, driving south at midday with the
// Sun ahead, the dashboard's top went white, brighter than the sunlit road beyond the windshield. A dashboard is dark
// plastic (an albedo near 0.03 to 0.05 against asphalt's 0.1 to 0.15), so its sunlit top must sit below the sunlit road
// and never near white. GPU, shipped look, cabin view, every part, quality pinned before Drive is entered.
//
// Serve the repository first (pnpm exec vite --port 5353 --strictPort), then:
//   node tests/manual/cabin-dash-sun.mjs [--port 5353] [--backends webgpu,webgl] [--quality high|low] [--out <dir>]
//        [--only i15s-noon,i15s-dusk,i15n-noon,i15s-night,i15s-rain-dusk] [--knob '<JSON>'] [--at 'x,y;...']
//
// Each scene is read from the displayed frame (window.__skyline.capture). Its pixels are classified by casting the
// eye's ray through them (every 4th pixel): "dash top" where the first hit is a cabin surface of the dashboard's paint
// (CabinDash or CabinTrim) facing up (normal . car up > 0.5); "road" where the ray passes the cabin and meets the road
// 8 to 120 m ahead. Lines per scene:
//   dash top sunlit mean Y <= 0.5 x road mean Y   (displayed relative luminance, the sRGB decoded; the top's faces
//                                                 toward the Sun, or the whole top when fewer than 50 samples face it)
//   dash top near white <= 2 %                    (pixels with every channel >= 235)
// for i15s-noon (the defect), i15s-dusk and i15n-noon (the controls); the night and heavy-rain dusk scenes are printed
// and their frames written, for looking at, not asserted. The scene-referred luminance (cd/m^2, the scene pass read
// back, the pre-exposure divided out) is printed beside each mean, and a table per cabin material.
// With --out, each scene's frame and its classes painted over it (-classes.png: sunlit dash top yellow, the rest of the
// top red, the road green, other cabin surfaces blue) are written there. --at 'x,y;x,y' prints what the eye's ray meets
// at those pixels (material, node, distance, normal . up). --knob (for diagnosis): { "lights": { "<name>": 0 } } holds
// a cabin light's intensity at 0 (names: hemi, sun, city, fill, glow); { "paint": { "<material>": [r, g, b, roughness] } }
// overrides a cabin material. The quality level is pinned from the address (?q=) and again before Drive is entered.
// The Low level on the WebGPU backend draws an empty frame in Drive (seen 2026-11-24, before and after this check's fix).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5353));
const backends = opt('backends', 'webgpu,webgl').split(',').filter(Boolean);
const level = opt('quality', 'high');
const out = opt('out', null);
const only = opt('only', null)?.split(',');
const knob = JSON.parse(opt('knob', '{}'));
const atPoints = opt('at', null)?.split(';').map((p) => p.split(',').map(Number)); // --at 'x,y;x,y': what the eye's ray meets there
const W = 1280, H = 720;
const NOON = '2026-11-21T20:30:00Z', DUSK = '2026-11-22T00:22:00Z', NIGHT = '2026-11-22T05:00:00Z';
const SM = 39900; // i15s, 280 m before the Spring Mountain Rd sign (Exit 39)
const SCENES = [
  { name: 'i15s-noon', route: 'i15s', s: SM, t: NOON, assert: true },
  { name: 'i15s-dusk', route: 'i15s', s: SM, t: DUSK, assert: true },
  { name: 'i15n-noon', route: 'i15n', s: 45000, t: NOON, assert: true },
  { name: 'i15s-night', route: 'i15s', s: SM, t: NIGHT },
  { name: 'i15s-rain-dusk', route: 'i15s', s: SM, t: DUSK, rain: 12, dt: 0.35 },
].filter((c) => !only || only.includes(c.name));
if (out) mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
});

const PAGE = String.raw`
window.__ds = (() => {
  const sk = window.__skyline, T = sk.three;
  const frames = (n = 3) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const Y = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fromHalf = (u) => { const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff; if (e === 0) return s * f * 2 ** -24; if (e === 31) return f ? NaN : s * Infinity; return s * (1 + f / 1024) * 2 ** (e - 15); };
  const held = [];
  function hold(obj, key, value) { Object.defineProperty(obj, key, { configurable: true, get: () => value, set: () => {} }); held.push([obj, key]); }
  function cabinLights() {
    const car = sk.scene.getObjectByName('cabin');
    let ln = null; car?.traverse((o) => { if (!ln && o.isMesh && o.material?.lightsNode) ln = o.material.lightsNode; });
    const L = ln ? ln.getLights() : [];
    const by = {};
    for (const l of L) {
      if (l.isHemisphereLight) by.hemi = l; else if (l.isDirectionalLight) by.sun = l; else if (l.isPointLight) by.glow = l;
      else if (l.isAmbientLight && l.name === 'city light') by.city = l; else if (l.isAmbientLight) by.fill = l;
    }
    return by;
  }
  function applyKnob(k) {
    const by = cabinLights();
    for (const [n, v] of Object.entries(k.lights || {})) if (by[n]) hold(by[n], 'intensity', v);
    const car = sk.scene.getObjectByName('cabin');
    for (const [name, p] of Object.entries(k.paint || {})) car?.traverse((o) => {
      if (o.isMesh && o.material?.name === name) { o.material.color.setRGB(p[0], p[1], p[2]); if (p[3] != null) o.material.roughness = p[3]; }
    });
    return Object.fromEntries(Object.entries(by).map(([n, l]) => [n, +(+l.intensity).toPrecision(3)]));
  }
  // the scene pass read back whole, cd/m^2 per pixel, rows from the top
  async function sceneLuminance() {
    const pl = sk.pipeline; pl.render();
    const rt = pl.scenePass.renderTarget, w = rt.width, h = rt.height;
    const px = await sk.renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
    const k = 1 / sk.env.nodes.exposure.value, half = px instanceof Uint16Array;
    const outp = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      outp[i] = (half ? Y(fromHalf(px[o]), fromHalf(px[o + 1]), fromHalf(px[o + 2])) : Y(px[o], px[o + 1], px[o + 2])) * k;
    }
    return { w, h, data: outp };
  }
  /** What the eye's ray meets at pixels [[x, y], ...]: material, distance, normal . up (the side facing the eye). */
  function at(points) {
    const cam = sk.camera; cam.updateMatrixWorld();
    const car = sk.scene.getObjectByName('cabin'); car.updateMatrixWorld(true);
    const ms = []; car.traverse((o) => { if (o.isMesh && o.visible && !/windshield|veil|rain/i.test(o.material?.name || o.name || '')) ms.push(o); });
    const p = sk.drive.pose(); const up = new T.Vector3(p.up.x, p.up.y, p.up.z).normalize();
    const o = new T.Vector3().setFromMatrixPosition(cam.matrixWorld), ray = new T.Raycaster();
    const w = sk.renderer.domElement.width, h = sk.renderer.domElement.height;
    return points.map(([x, y]) => {
      const d = new T.Vector3((x + 0.5) / w * 2 - 1, 1 - (y + 0.5) / h * 2, 0.5).unproject(cam).sub(o).normalize();
      ray.set(o, d); ray.far = 6; const hc = ray.intersectObjects(ms, false)[0];
      if (!hc) return [x, y, null];
      const n = hc.face.normal.clone().transformDirection(hc.object.matrixWorld); if (n.dot(d) > 0) n.negate();
      return [x, y, hc.object.material?.name, hc.object.name, +hc.distance.toFixed(2), +n.dot(up).toFixed(2)];
    });
  }
  async function measure({ stride = 4 }) {
    const cam = sk.camera; cam.updateMatrixWorld();
    const car = sk.scene.getObjectByName('cabin');
    car.updateMatrixWorld(true);
    // the opaque cabin: not the windshield's veil (glass, seen through)
    const cabinMeshes = []; car.traverse((o) => { if (o.isMesh && o.visible && !/windshield|veil|rain/i.test(o.material?.name || o.name || '')) cabinMeshes.push(o); });
    const road = []; sk.scene.getObjectByName('drive')?.traverse((o) => { if (o.isMesh && o.visible && o.material?.userData?.surfaceLight === 'road') road.push(o); });
    const p = sk.drive.pose(); const up = new T.Vector3(p.up.x, p.up.y, p.up.z).normalize();
    const ray = new T.Raycaster(); const o = new T.Vector3().setFromMatrixPosition(cam.matrixWorld);
    // the displayed frame
    const blob = await sk.capture('image/png');
    const bmp = await createImageBitmap(blob);
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d'); g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, bmp.width, bmp.height); const D = img.data, w = bmp.width, h = bmp.height;
    const scene = await sceneLuminance();
    // the sun's direction (the scene's shadow-casting light), to tell the dash top's sunlit faces from its shaded ones
    let sunL = null; for (const l of sk.scene.children) if (l.isDirectionalLight && l.castShadow && !sunL) sunL = l;
    const toSun = sunL ? sunL.position.clone().sub(sunL.target.position).normalize() : new T.Vector3(0, -1, 0);
    const cls = []; // [x, y, class, material]
    for (let y = stride / 2; y < h; y += stride) for (let x = stride / 2; x < w; x += stride) {
      const d = new T.Vector3((x + 0.5) / w * 2 - 1, 1 - (y + 0.5) / h * 2, 0.5).unproject(cam).sub(o).normalize();
      ray.set(o, d); ray.near = 0; ray.far = 6;
      const hc = ray.intersectObjects(cabinMeshes, false)[0];
      if (hc) {
        const n = hc.face.normal.clone().transformDirection(hc.object.matrixWorld);
        if (n.dot(d) > 0) n.negate(); // double-sided: the side facing the eye
        const mat = hc.object.material?.name || hc.object.name || '?';
        const top = (mat === 'CabinDash' || mat === 'CabinTrim') && n.dot(up) > 0.5;
        cls.push([x, y, top ? (n.dot(toSun) > 0.2 ? 'dashLit' : 'dash') : 'cabin', mat]);
        continue;
      }
      ray.far = 400;
      const hr = ray.intersectObjects(road, false)[0];
      if (hr && hr.distance > 8 && hr.distance < 120) cls.push([x, y, 'road', 'road']);
    }
    // per group: displayed relative luminance Y (sRGB decoded) and scene cd/m^2 (the scene pass read back runs from the
    // top on the WebGPU backend, from the bottom on WebGL2: checked by the displays' dark faces, tens of cd/m^2)
    const bottomUp = sk.rendererInfo?.backend === 'webgl2';
    const groups = { dash: [], dashLit: [], road: [] }, mats = {};
    for (const [x, y, c, mat] of cls) {
      const i = (y * w + x) * 4, r = D[i], gg = D[i + 1], b = D[i + 2];
      const v = [Y(lin(r), lin(gg), lin(b)), r >= 235 && gg >= 235 && b >= 235 ? 1 : 0, scene.data[(bottomUp ? scene.h - 1 - y : y) * scene.w + x]];
      if (c === 'dashLit') groups.dash.push(v);
      groups[c]?.push(v);
      if (c !== 'road') (mats[mat] ||= []).push(v);
    }
    // the classes painted over the frame (dash red, road green, other cabin blue), for checking the classifier
    const mg = new OffscreenCanvas(w, h).getContext('2d'); mg.putImageData(img, 0, 0);
    for (const [x, y, c] of cls) { mg.fillStyle = c === 'dashLit' ? '#ff0' : c === 'dash' ? '#f00' : c === 'road' ? '#0f0' : '#00f'; mg.fillRect(x - 1, y - 1, 2, 2); }
    const mb = await mg.canvas.convertToBlob({ type: 'image/png' });
    const mask = await new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(mb); });
    const fin = (a) => {
      const n = a.length, mean = (k) => (n ? a.reduce((t, v) => t + v[k], 0) / n : NaN);
      const ys = a.map((v) => v[0]).sort((p, q) => p - q), q = (f) => (n ? ys[Math.min(n - 1, Math.floor(f * n))] : NaN);
      return { n, Y: mean(0), white: mean(1), cd: mean(2), p50: q(0.5), p90: q(0.9) };
    };
    const st = sk.drive.cabin()?.stats?.() || {};
    return { dash: fin(groups.dash), dashLit: fin(groups.dashLit), road: fin(groups.road), mats: Object.fromEntries(Object.entries(mats).map(([k, v]) => [k, fin(v)])),
      sunInside: st.sunInside, model: st.model, level: st.level, exposure: sk.env.nodes.exposure.value, sunElevation: p.sunElevation, mask };
  }
  return { frames, applyKnob, measure, cabinLights, at };
})();
`;

let failed = 0;
for (const backend of backends) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 200)}`));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
  await page.routeWebSocket(/./, () => {}); // other work in the checkout must not reload the page
  await page.goto(`http://localhost:${port}/?city=lv&backend=${backend}&q=${level}`); // the level pinned from the start (a level change on WebGPU breaks the shadow map)
  await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 180000 });
  const info = await page.evaluate(async (level) => { const s = window.__skyline; s.quality?.set(level); s.attractions?.freeze(20); await s.attractions?.ready; return { ...s.rendererInfo, quality: s.quality?.level }; }, level);
  await page.addScriptTag({ content: PAGE });
  console.log(`${backend}: ${JSON.stringify(info)}`);
  for (const c of SCENES) {
    const r = await page.evaluate(async ({ c, knob, atPoints }) => {
      const d = window.__skyline.drive, t = Date.parse(c.t);
      if (!d.active() || d.route()?.id !== c.route) await d.start(c.route, { s: c.s, t, view: 'cabin' });
      await new Promise((res) => { const f = () => (d.cabin() ? res() : setTimeout(f, 100)); f(); });
      d.pause(); d.setView('cabin');
      d.cabin().weather?.setRain?.(c.rain || 0);
      d.seek({ s: c.s, t });
      if (c.dt) d.seek({ t: t + c.dt * 1000 });
      d.look({ yaw: 0, pitch: 0 });
      await Promise.race([d.whenSettled(), new Promise((res) => setTimeout(res, 60000))]);
      for (let i = 0; i < 20 && c.rain && !d.cabin().glass?.rain?.raining; i++) await new Promise((res) => setTimeout(res, 100));
      const lights = window.__ds.applyKnob(knob);
      await window.__ds.frames(4);
      return { lights, ...(await window.__ds.measure({})), at: atPoints ? window.__ds.at(atPoints) : null };
    }, { c, knob, atPoints });
    if (r.at) for (const a of r.at) console.log(`   at ${JSON.stringify(a)}`);
    if (out) {
      const png = await page.evaluate(async () => { const b = await window.__skyline.capture('image/png'); return new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); }); });
      writeFileSync(`${out}/${backend}-${level}-${c.name}.png`, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
      writeFileSync(`${out}/${backend}-${level}-${c.name}-classes.png`, Buffer.from(r.mask.slice(r.mask.indexOf(',') + 1), 'base64'));
    }
    const f = (v, n = 3) => (Number.isFinite(v) ? v.toPrecision(n) : String(v));
    console.log(`${backend} ${c.name}: sun ${f(r.sunElevation)} deg, model ${r.model}/${r.level}, sunInside ${r.sunInside}, lights ${JSON.stringify(r.lights)}`);
    const line = (k, a) => console.log(`   ${k.padEnd(16)} n ${String(a.n).padStart(5)}  mean Y ${f(a.Y)}  p50 ${f(a.p50)}  p90 ${f(a.p90)}  near white ${f(100 * a.white, 2).padStart(4)} %  scene ${f(a.cd)} cd/m2`);
    line('dash top', r.dash); line('dash top sunlit', r.dashLit); line('road', r.road);
    for (const [m, a] of Object.entries(r.mats)) line(`  ${m}`, a);
    if (c.assert) {
      // the sunlit part of the top where the sun reaches it (by day; at dusk the whole top when too little of it faces the sun)
      const lit = r.dashLit.n > 50 ? r.dashLit : r.dash;
      // "well below": dark plastic (albedo 0.05 at most) against asphalt (0.1 at least) under the same light
      const okL = lit.n > 50 && r.road.n > 50 && lit.Y <= 0.5 * r.road.Y;
      const okW = r.dash.n > 50 && r.dash.white <= 0.02;
      console.log(`   ${okL ? 'PASS' : 'FAIL'} dash top${lit === r.dashLit ? ' sunlit' : ''} mean Y ${f(lit.Y)} <= half the road's mean Y ${f(r.road.Y)}`);
      console.log(`   ${okW ? 'PASS' : 'FAIL'} dash top near white ${f(100 * r.dash.white, 2)} % <= 2 %`);
      if (!okL || !okW) failed++;
    }
  }
  if (problems.length) console.log(`page errors:\n  ${[...new Set(problems)].slice(0, 10).join('\n  ')}`);
  await page.close();
}
await browser.close();
console.log(failed ? `FAIL (${failed} scene${failed > 1 ? 's' : ''})` : 'PASS');
process.exit(failed ? 1 : 0);

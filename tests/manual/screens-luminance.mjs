// Luminance probes of the drive's screens and billboards on plan 01's renderer, in the shipped look (plan 02, D7.3 to
// D7.5; third stretch, decision 6), with the app's window.__skyline.probe (scene-referred cd/m^2 at a screen point,
// before exposure and bloom). Each line prints expected, measured, tolerance and PASS or FAIL:
//
//   digital day / night    a digital face's emitted luminance (the face's frame minus the same frame with its level at
//                          0, so the sunlight it reflects is not counted), averaged over a grid of points on the face,
//                          against the picture there (the atlas texels, linear, in the hold and fade the face shows) x
//                          the plan's level: 6,000 cd/m^2 by day and 300 at night for a white (section 7.9 [L9])
//   static night           a static face's floodlit luminance (minus the frame with its floodlights off) against the
//                          picture x VINYL x 400 lx / pi x the floodlights' gradient
//   sphere lux, ground     a white card (albedo 1) on the ground 100 m from the Sphere's centre, lit by the Sphere's
//                          term (light on minus off): its illuminance, pi x delta L, against the registry's prediction
//                          E = pi L (R / d)^2 cos(theta) x fade with L the Sphere's mean luminance; then the ground there
//                          without the card: lit (delta L > 0), with the albedo that implies printed
//   sphere hidden, moved   the card again with the Sphere hidden (no light) and moved 60 m east (the prediction from
//                          the moved centre)
//   flash <rate>           the card's illuminance sampled at 60 frames a second of real time at 0.25x, 1x, 4x and 16x,
//                          normalised by the Sphere's peak (a white skin), through screens/flash.js: at most 3 flashes
//                          a second (section 4.11)
//
// Serve the repository first (pnpm exec vite --port 5322 --strictPort), then:
//   node tests/manual/screens-luminance.mjs [--port 5322] [--backend webgpu|webgl] [--out <dir outside the repo>]
// The exit code is the verdict.
//
// Orientation. window.__skyline.probe(x, y) (plan 01, src/render/pipeline.js) reads the pixel at NDC (x, -y) on both
// backends: it maps y to texture v as (y + 1) / 2, and three's node textures have v = 0 at the top. This script reads
// through probeAt(), which mirrors y, and checks the mirror first ('probe orientation': a bright marker drawn at NDC
// y = +0.5 must be found there), so the line goes red if the probe is corrected and the mirror becomes wrong.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5322));
const backend = opt('backend', 'webgpu');
const out = opt('out', `/private/tmp/screens-luminance-${Date.now()}`);
mkdirSync(out, { recursive: true });

const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T05:00:00Z');
const SPHERE = 'w976405284';

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const problems = [];
await page.routeWebSocket(/.*/, () => {}); // other work in the checkout must not reload the page
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
await page.goto(`http://localhost:${port}/?city=lv&renderer=webgpu&backend=${backend}&parts=screens,billboards`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 300000 });

const result = await page.evaluate(async ({ DAY, NIGHT, SPHERE }) => {
  const s = window.__skyline, d = s.drive;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const settle = () => Promise.race([d.whenSettled(), new Promise((r) => setTimeout(r, 60000))]);
  await s.attractions?.ready;
  await d.start('i15n', { s: 46000, t: NIGHT, view: 'clean' });
  d.pause();
  d.setView('clean');
  let bb = null, scr = null;
  for (let i = 0; i < 900 && !(bb && scr); i++) {
    await raf();
    bb = s.scene.getObjectByName('billboards')?.userData.billboardsPart || null;
    scr = s.scene.getObjectByName('drive')?.userData.screensPart || null;
  }
  const info = { renderer: s.rendererInfo, billboards: !!bb, screens: !!scr };
  const lines = [];
  const line = (name, expected, measured, tol, unit, extra = '') => {
    const ok = Number.isFinite(measured) && Number.isFinite(expected) && (tol.abs !== undefined ? Math.abs(measured - expected) <= tol.abs : Math.abs(measured - expected) <= tol.rel * Math.abs(expected));
    lines.push({ name, expected, measured, tol: tol.abs !== undefined ? `+-${tol.abs} ${unit}` : `+-${(tol.rel * 100).toFixed(0)} %`, unit, pass: ok, extra });
  };
  const absent = (name, what) => lines.push({ name, expected: null, measured: null, tol: '', unit: '', pass: false, extra: `${what} not on this renderer` });
  const Y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const cityFactor = s.uniforms?.cityFactor?.value ?? 1;
  const probeAt = (x, y) => s.probe(x, -y); // see 'Orientation' at the top
  const probeY = async (x, y) => Y((await probeAt(x, y)).rgb) / cityFactor; // cd/m^2 as authored (the lights-out slider out)
  /** draw a frame so the rig's camera is current, then bring its matrices up to date (projections use them) */
  const current = () => { d.renderFrame(); s.camera.updateMatrixWorld(true); };

  // the probe's orientation: a bright square 5 m in front of the eye at NDC (0, +0.5), against the frame without it
  {
    current();
    const at = new s.three.Vector3(0, 0.5, 0.5).unproject(s.camera), eye = s.camera.position.clone();
    const dir = at.sub(eye).normalize();
    const mat = new s.webgpu.MeshBasicNodeMaterial();
    mat.colorNode = s.tsl.vec3(50, 50, 50);
    const marker = new s.webgpu.Mesh(new s.webgpu.PlaneGeometry(0.4, 0.4), mat);
    marker.position.copy(eye).addScaledVector(dir, 5);
    marker.quaternion.copy(s.camera.quaternion);
    s.scene.add(marker);
    const top = await probeY(0, 0.5), bottom = await probeY(0, -0.5);
    s.scene.remove(marker);
    const bare = await probeY(0, 0.5);
    lines.push({ name: 'probe orientation', expected: 'marker at y +0.5', measured: +(top / Math.max(bare, 1e-6)).toFixed(1), tol: '> 10x bare', unit: '',
      pass: top > 10 * Math.max(bare, 1e-3) && top > 10 * Math.max(bottom, 1e-3), extra: `marker ${top.toFixed(1)}, mirrored point ${bottom.toFixed(2)}, without it ${bare.toFixed(2)} cd/m2 (probeAt mirrors y)` });
  }

  // ------------------------------------------------------------------ billboards
  if (!bb) { for (const n of ['digital day', 'digital night', 'static night']) absent(n, 'the billboards part'); } else {
    await bb.whenSettled();
    const { adFrame } = await import('/src/drive/roadside/billboardsImages.js');
    const { contentSeconds } = await import('/src/drive/screens/clock.js');
    const { VINYL } = await import('/src/drive/screens/digital.js');
    // the atlas as pixels (the bitmap is flipped as uploaded: texture v = 0 is its row 0)
    const img = bb.uniforms.uAds.value.image;
    const cv = new OffscreenCanvas(img.width, img.height), g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const atlas = g.getImageData(0, 0, img.width, img.height).data;
    const table = bb.uniforms.uAdTable.value.image, nImg = table.width;
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    /** linear colour of image i at image uv, a box of texels about one screen pixel's footprint */
    const texel = (i, u, v, box) => {
      const r = table.data.subarray(i * 4, i * 4 + 4), mean = table.data.subarray((nImg + i) * 4, (nImg + i) * 4 + 3);
      if (u < 0 || u > 1 || v < 0 || v > 1) return [mean[0] * 0.7, mean[1] * 0.7, mean[2] * 0.7];
      const cx = (r[0] + u * r[2]) * img.width, cy = (r[1] + v * r[3]) * img.height, out = [0, 0, 0];
      let n = 0;
      for (let dy = -box; dy <= box; dy++) for (let dx = -box; dx <= box; dx++) {
        const x = Math.min(img.width - 1, Math.max(0, Math.round(cx + dx))), y = Math.min(img.height - 1, Math.max(0, Math.round(cy + dy))), o = (y * img.width + x) * 4;
        out[0] += lin(atlas[o]); out[1] += lin(atlas[o + 1]); out[2] += lin(atlas[o + 2]); n++;
      }
      return out.map((c) => c / n);
    };
    /** aim the head at face f from about `dist` metres short of it (as screens-ads.mjs) */
    const aim = async (f, t, dist) => {
      let sNow = d.pose().s;
      d.seek({ s: sNow, t }); await settle();
      let p = d.pose();
      for (let i = 0; i < 6; i++) {
        const e = p.eye, along = (f.cx - e.x) * p.forward.x + (f.cz - e.z) * p.forward.z;
        const lateral = Math.hypot(f.cx - e.x, f.cz - e.z) ** 2 - along ** 2;
        const ds = along - Math.sqrt(Math.max(0, dist * dist - lateral));
        if (Math.abs(ds) < 2) break;
        sNow += ds; d.seek({ s: sNow, t }); await settle(); p = d.pose();
      }
      const e = p.eye, dx = f.cx - e.x, dz = f.cz - e.z, dy = f.cy - e.y;
      let yaw = ((Math.atan2(-dz, dx) - Math.atan2(-p.forward.z, p.forward.x)) * 180) / Math.PI;
      yaw = ((yaw + 540) % 360) - 180;
      d.look({ yaw, pitch: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI, lens: 50 });
      await settle();
      for (let i = 0; i < 3; i++) await raf();
      current();
      return Math.round(Math.hypot(dx, dy, dz));
    };
    /** the face's emission: probes on a grid of the face with its level on and at 0; and the picture there */
    const measure = async (f, t, key) => {
      const a = bb.assignment(f.index), fr = adFrame(a, f.phase, contentSeconds(t));
      const ux = f.nz, uz = -f.nx, ul = Math.hypot(ux, uz); // the face's x axis: up x normal
      const V = new s.three.Vector3();
      const pts = [];
      for (const v of [0.3, 0.5, 0.7]) for (const u of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
        V.set(f.cx + (ux / ul) * (u - 0.5) * f.w + f.nx * 0.05, f.cy + (v - 0.5) * f.h, f.cz + (uz / ul) * (u - 0.5) * f.w + f.nz * 0.05).project(s.camera);
        if (Math.abs(V.x) < 0.98 && Math.abs(V.y) < 0.98 && V.z < 1) pts.push({ u, v, x: V.x, y: V.y });
      }
      const u0 = bb.uniforms[key].value;
      const level = u0;
      const on = [], off = [];
      for (const p of pts) on.push(await probeY(p.x, p.y));
      bb.uniforms[key].value = 0;
      for (const p of pts) off.push(await probeY(p.x, p.y));
      bb.uniforms[key].value = u0;
      // footprint: image texels per screen pixel, from two neighbouring probe points
      const pxPerFace = pts.length > 1 ? Math.abs(pts[1].x - pts[0].x) * 640 / Math.abs(pts[1].u - pts[0].u) : 200;
      const box = Math.max(0, Math.round((a.fit[0] * (bb.uniforms.uAdTable.value.image.data[(fr.cur) * 4 + 2] * img.width)) / pxPerFace / 2));
      const exp = pts.map((p) => {
        const iu = (p.u - 0.5) * a.fit[0] + 0.5, iv = (p.v - 0.5) * a.fit[1] + 0.5;
        const c0 = texel(fr.prev, iu, iv, box), c1 = texel(fr.cur, iu, iv, box);
        const c = c0.map((x, k) => x + (c1[k] - x) * fr.fade);
        const grad = f.digital ? 1 : 1.35 + (0.65 - 1.35) * p.v;
        return Y(c) * level * grad;
      });
      const mean = (xs) => xs.reduce((q, x) => q + x, 0) / Math.max(1, xs.length);
      return { n: pts.length, level, emitted: mean(on.map((x, i) => x - off[i])), expected: mean(exp), reflected: mean(off), box, image: fr.cur, fade: +fr.fade.toFixed(2) };
    };
    const digital = bb.faces[164], statics = bb.faces[179];
    for (const [when, t, plan] of [['day', DAY, 6000], ['night', NIGHT, 300]]) {
      d.seek({ s: 46000, t }); await settle();
      const dist = await aim(digital, t, 60);
      const lv = d.stats()?.billboards?.level;
      line(`digital level ${when}`, plan, lv?.digital, { rel: 0.01 }, 'cd/m2', `ambient ${lv?.ambientLux} lx (section 7.9: ${plan} cd/m2)`);
      const m = await measure(digital, t, 'uDigitalLevel');
      line(`digital ${when}`, m.expected, m.emitted, { rel: 0.15 }, 'cd/m2', `face ${digital.index} at ${dist} m, ${m.n} points, image ${m.image}, fade ${m.fade}, reflected ${m.reflected.toFixed(1)} cd/m2`);
    }
    d.seek({ s: 52300, t: NIGHT }); await settle();
    const dist = await aim(statics, NIGHT, 60);
    const lvs = d.stats()?.billboards?.level;
    line('static level night', (VINYL * 400) / Math.PI, lvs?.static, { rel: 0.01 }, 'cd/m2 per unit', 'vinyl 0.82 under 400 lx');
    const m = await measure(statics, NIGHT, 'uStaticLevel');
    line('static night', m.expected, m.emitted, { rel: 0.15 }, 'cd/m2', `face ${statics.index} at ${dist} m, ${m.n} points, image ${m.image}, unlit ${m.reflected.toFixed(2)} cd/m2`);
  }

  // ------------------------------------------------------------------ the Sphere's light
  if (!scr) { for (const n of ['sphere lux 100 m', 'ground 100 m', 'sphere hidden', 'sphere moved', 'flash']) absent(n, 'the screens part'); } else {
    d.seek({ s: 59500, t: NIGHT }); await settle();
    for (let i = 0; i < 3; i++) await raf();
    const { lambert } = await import('/src/drive/roadside/lambert.js');
    const { ledScale } = await import('/src/drive/screens/led.js');
    const entry = s.tall.find((e) => e.data.id === SPHERE);
    const U = scr.uniforms.uScrSphere.value;
    const C0 = { x: U.x, y: U.y, z: U.z, R: U.w };
    // a spot on open ground 100 m from the centre: the first direction whose ray down hits a level surface below the centre
    const ray = new s.three.Raycaster(), down = new s.three.Vector3(0, -1, 0);
    let spot = null;
    for (let a = 0; a < 360 && !spot; a += 20) {
      const x = C0.x + 100 * Math.cos((a * Math.PI) / 180), z = C0.z + 100 * Math.sin((a * Math.PI) / 180);
      ray.set(new s.three.Vector3(x, C0.y + 400, z), down);
      const hit = ray.intersectObjects(s.scene.children, true).find((h) => h.object.isMesh && h.object.visible && !/billboard/.test(h.object.name));
      if (hit && hit.face && Math.abs(hit.face.normal.y) > 0.95 && hit.point.y < C0.y - 20) spot = { x, y: hit.point.y, z, a, on: hit.object.name || hit.object.parent?.name || '?' };
    }
    const cam = s.camera.clone();
    cam.fov = 40; cam.near = 0.5; cam.far = 5000; cam.aspect = 1280 / 720;
    cam.position.set(spot.x + 25, spot.y + 45, spot.z + 25); cam.up.set(0, 1, 0); cam.lookAt(spot.x, spot.y, spot.z);
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    const card = new s.webgpu.Mesh(new s.webgpu.PlaneGeometry(6, 6).rotateX(-Math.PI / 2), lambert(false, { color: 0xffffff }));
    card.position.set(spot.x, spot.y + 0.3, spot.z);
    card.name = 'lux meter';
    s.scene.add(card);
    scr.attachLight(card.material);
    s.pipeline.setCamera(cam);
    const meanNow = () => s.drive.stats()?.screens?.sphereLight?.mean || [0, 0, 0];
    const predicted = (C) => {
      const dx = C.x - card.position.x, dy = C.y - card.position.y, dz = C.z - card.position.z, dd = Math.hypot(dx, dy, dz);
      const dc = Math.max(dd, C.R * 1.02), fade = 1 - (t0 => t0 * t0 * (3 - 2 * t0))(Math.min(1, Math.max(0, (dd - 540) / 360)));
      return { E: Math.PI * Y(meanNow()) * (C.R / dc) ** 2 * Math.max(0, dy / dd) * fade, dd, peak: Math.PI * (C.R / dc) ** 2 * Math.max(0, dy / dd) * fade };
    };
    const cardLux = async () => {
      scr.setLight(true); const on = await probeY(0, 0);
      scr.setLight(false); const off = await probeY(0, 0);
      scr.setLight(true);
      return Math.PI * (on - off); // albedo 1
    };
    await raf(); await raf();
    const p0 = predicted(C0);
    line('sphere lux 100 m', p0.E, await cardLux(), { rel: 0.05 }, 'lx', `card at ${p0.dd.toFixed(0)} m from the centre (100 m across, on ${spot.on}), L = ${Y(meanNow()).toFixed(2)} cd/m2`);
    card.visible = false;
    scr.setLight(true); const gOn = await probeY(0, 0);
    scr.setLight(false); const gOff = await probeY(0, 0);
    scr.setLight(true);
    card.visible = true;
    const albedo = (Math.PI * (gOn - gOff)) / p0.E;
    lines.push({ name: 'ground 100 m', expected: '0.03 to 0.8', measured: +albedo.toFixed(3), tol: 'albedo', unit: '', pass: albedo > 0.03 && albedo < 0.8,
      extra: `delta L ${(gOn - gOff).toFixed(3)} cd/m2 under ${p0.E.toFixed(2)} lx: the albedo it implies` });
    // hidden (the map's edit event: place() announces buildings:changed), then moved 60 m east
    entry.mesh.visible = false; s.place(entry, 0, 0); await raf(); await raf();
    line('sphere hidden', 0, await cardLux(), { abs: 0.01 }, 'lx', `state ${s.drive.stats()?.screens?.sphereLight?.state}`);
    entry.mesh.visible = true; s.place(entry, 0, 0); await raf(); await raf();
    s.place(entry, 60, 0); await raf(); await raf();
    const C1 = { x: U.x, y: U.y, z: U.z, R: U.w }, p1 = predicted(C1);
    line('sphere moved 60 m', p1.E, await cardLux(), { rel: 0.05 }, 'lx', `centre moved ${(C1.x - C0.x).toFixed(1)} m east, card ${p1.dd.toFixed(0)} m from it`);
    s.place(entry, 0, 0); await raf(); await raf();
    // the flash limit on the rendered light: 3 s of real time at 60 samples a second per rate
    const { measureFlash, FLASH_LIMIT_HZ } = await import('/src/drive/screens/flash.js');
    const signs = s.uniforms?.switchOn?.signs?.value ?? 1;
    const peak = predicted(C0).peak * ledScale({ display: 'physical', signs });
    const off = (scr.setLight(false), await probeY(0, 0)); scr.setLight(true);
    for (const rate of [0.25, 1, 4, 16]) {
      const ys = [];
      for (let i = 0; i < 180; i++) {
        d.seek({ s: 59500, t: NIGHT + 600000 + i * (1000 / 60) * rate });
        await raf(); await raf();
        ys.push((Math.PI * ((await probeY(0, 0)) - off)) / peak);
      }
      const m = measureFlash((tt) => { const y = ys[Math.min(ys.length - 1, Math.round((tt / rate) * 60))]; return [y, y, y]; }, { rate, seconds: 3 });
      line(`flash ${rate}x`, FLASH_LIMIT_HZ, m.flashesPerSecond, { abs: 0 }, 'per s', `at most; ${m.transitions} transitions, light ${Math.min(...ys).toFixed(3)} to ${Math.max(...ys).toFixed(3)} of peak`);
      const last = lines[lines.length - 1]; last.pass = m.flashesPerSecond <= FLASH_LIMIT_HZ; last.tol = '<=';
    }
    s.pipeline.setCamera(s.camera);
    s.scene.remove(card);
  }
  return { info, lines };
}, { DAY, NIGHT, SPHERE });

const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : String(v));
console.log(`renderer ${JSON.stringify(result.info)}\n`);
console.log('probe                  expected        measured        tolerance        verdict');
for (const l of result.lines) {
  console.log(`${l.name.padEnd(22)} ${fmt(l.expected).padStart(12)} ${fmt(l.measured).padStart(15)}   ${String(l.tol).padEnd(14)} ${l.pass ? 'PASS' : 'FAIL'}  ${l.unit} ${l.extra}`);
}
const failed = result.lines.filter((l) => !l.pass).length;
if (problems.length) console.log(`\nthe page said:\n  ${[...new Set(problems)].slice(0, 15).join('\n  ')}`);
writeFileSync(join(out, 'screens-luminance.json'), JSON.stringify(result, null, 1));
console.log(`\n${result.lines.length} probes, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);

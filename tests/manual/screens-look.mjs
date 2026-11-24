// Frames of the drive's screens and billboards on plan 01's renderer in the shipped look (plan 02, D7.3 to D7.5; third
// stretch, "looking at it"), canvas only (no interface), for a person to look at:
//   boards-{day,night}        boards by day and at night along I-15 near the city (52.6 km, 35 mm)
//   digital-{a,b,c}           a digital face from 120 m at night, before, during and after a change of advertisement
//   digital-day               the same face by day
//   sphere-road-night         the Sphere at night from the road (63 km, 100 mm, aimed at it)
//   sphere-light-{shown,hidden,moved}   the Sphere's light on the ground and buildings around it, from a camera 350 m up
//                             and south-east of it (the light reaches 900 m; from the road it covers a few dozen pixels)
// Prints the exposure (EV100), the digital and static levels and the Sphere's light state with each frame.
//
// Serve the repository first, then:
//   node tests/manual/screens-look.mjs [--port 5322] [--backend webgpu|webgl] [--out <dir outside the repo>] [--display classic]
//        [--parts all | a,b]   (default screens,billboards; `all` loads every part the renderer runs, so the night's
//                               exposure is the one a driver gets with the lamps and traffic in view)
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(opt('port', 5322));
const backend = opt('backend', 'webgpu');
const display = opt('display', null);
const parts = opt('parts', 'screens,billboards');
const out = opt('out', `/private/tmp/screens-look-${Date.now()}`);
mkdirSync(out, { recursive: true });
const DAY = Date.parse('2026-11-21T20:30:00Z'), NIGHT = Date.parse('2026-11-22T05:00:00Z');

const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu',
    '--host-resolver-rules=MAP *.open-meteo.com ~NOTFOUND, MAP aviationweather.gov ~NOTFOUND, MAP api.weather.gov ~NOTFOUND, MAP mesonet.agron.iastate.edu ~NOTFOUND'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.routeWebSocket(/.*/, () => {});
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('slc-skyline-hinted', '1'); } catch { /* none */ } });
await page.goto(`http://localhost:${port}/?city=lv&renderer=webgpu&backend=${backend}${display ? `&display=${display}` : ''}${parts === 'all' ? '' : `&parts=${parts}`}`);
await page.waitForFunction(() => performance.getEntriesByName('skyline-ready').length > 0 && window.__skyline?.drive, null, { timeout: 300000 });
await page.evaluate(async (NIGHT) => {
  const s = window.__skyline, d = s.drive;
  await s.attractions?.ready;
  await d.start('i15n', { s: 46000, t: NIGHT, view: 'clean' });
  d.pause(); d.setView('clean');
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (s.scene.getObjectByName('billboards')?.userData.billboardsPart && s.scene.getObjectByName('drive')?.userData.screensPart) break;
  }
  await s.scene.getObjectByName('billboards').userData.billboardsPart.whenSettled();
}, NIGHT);

/** Set up a view in the page (`how` is evaluated there with (s, d, helpers)), draw it and keep the canvas. */
async function shot(name, how, arg) {
  const r = await page.evaluate(async ({ how, arg }) => {
    const s = window.__skyline, d = s.drive, raf = () => new Promise((res) => requestAnimationFrame(res));
    const settle = () => Promise.race([d.whenSettled(), new Promise((res) => setTimeout(res, 60000))]);
    const bb = s.scene.getObjectByName('billboards').userData.billboardsPart, scr = s.scene.getObjectByName('drive').userData.screensPart;
    const aim = (f) => {
      const p = d.pose(), e = p.eye, dx = f.cx - e.x, dz = f.cz - e.z, dy = f.cy - e.y;
      let yaw = ((Math.atan2(-dz, dx) - Math.atan2(-p.forward.z, p.forward.x)) * 180) / Math.PI;
      yaw = ((yaw + 540) % 360) - 180;
      return { yaw, pitch: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI };
    };
    const probeCam = () => {
      const cam = s.camera.clone();
      cam.fov = 50; cam.near = 1; cam.far = 20000; cam.aspect = 1280 / 720;
      const C = { x: 966.2, y: 20, z: -726.3 };
      cam.position.set(C.x + 350, C.y + 350, C.z + 350); cam.up.set(0, 1, 0); cam.lookAt(C.x, C.y, C.z);
      cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      return cam;
    };
    // eslint-disable-next-line no-new-func
    const setup = new Function('s', 'd', 'h', `return (async () => { ${how} })();`);
    const cam = await setup(s, d, { settle, raf, bb, scr, aim, probeCam, arg });
    await settle();
    for (let i = 0; i < 3; i++) await raf();
    if (cam) s.pipeline.setCamera(cam);
    d.renderFrame();
    const canvas = s.renderer.domElement;
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no picture'))), 'image/png'));
    if (cam) s.pipeline.setCamera(s.camera);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const st = d.stats();
    return {
      png: btoa(bin),
      info: {
        s: Math.round(d.pose().s), ev100: +(s.env?.state?.exposure?.ev100 ?? NaN).toFixed(2), level: st?.billboards?.level, units: st?.billboards?.units,
        sphere: st?.screens?.sphereLight, images: st?.billboards?.images?.state,
      },
    };
  }, { how, arg });
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.png, 'base64'));
  console.log(name.padEnd(22), JSON.stringify(r.info));
}

const at = (s, t, look) => `d.seek({ s: ${s}, t: ${t} }); await h.settle(); d.look(${JSON.stringify(look)}); return null;`;
await shot('boards-day', at(52600, DAY, { yaw: 0, pitch: 0, lens: 35 }));
await shot('boards-night', at(52600, NIGHT, { yaw: 0, pitch: 0, lens: 35 }));
// a digital face from about 120 m: the car short of it, the head on it; then across its next change of advertisement
const face = `const f = h.bb.faces[164];
  d.seek({ s: 46080, t: ${NIGHT} + h.arg * 1000 }); await h.settle();
  d.look({ ...h.aim(f), lens: 70 }); return null;`;
const { phase } = await page.evaluate(() => ({ phase: window.__skyline.scene.getObjectByName('billboards').userData.billboardsPart.faces[164].phase }));
const content = (NIGHT % 3600000) / 1000, hold = 8, next = Math.ceil((content + phase) / hold) * hold - phase - content; // seconds to the next change
await shot('digital-a', face, next - 2);
await shot('digital-b', face, next + 0.3);
await shot('digital-c', face, next + 2);
await shot('digital-day', face.replace(String(NIGHT), String(DAY)), 0);
await shot('sphere-road-night', at(63000, NIGHT, { yaw: -107.65, pitch: 0.6, lens: 100 }));
const sphere = (state) => `d.seek({ s: 59500, t: ${NIGHT} }); await h.settle();
  const e = s.tall.find((x) => x.data.id === 'w976405284');
  e.mesh.visible = ${state !== 'hidden'}; s.place(e, ${state === 'moved' ? '-200, -150' : '0, 0'}); await h.raf(); await h.raf();
  return h.probeCam();`;
await shot('sphere-light-shown', sphere('shown'));
await shot('sphere-light-hidden', sphere('hidden'));
await shot('sphere-light-moved', sphere('moved'));
await page.evaluate(() => { const s = window.__skyline, e = s.tall.find((x) => x.data.id === 'w976405284'); e.mesh.visible = true; s.place(e, 0, 0); });
console.log(`frames in ${out}`);
await browser.close();

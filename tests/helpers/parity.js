// Comparing the new renderer with the classic one in the same run (plan 01, phase 2: T2.2, T2.3, T2.4, T2.11).
// Both are opened side by side, put into the same scene, and their pictures compared as the mean absolute
// difference of their RGB values, as a fraction of full scale (0.03 = 3 %). These specs stay for as long as
// ?renderer=legacy exists (phase 3 deletes both).
//
// `?display=classic` holds the new renderer at the classic display: ACES at exposure 1, no bloom, no automatic
// exposure (T2.4 to T2.6 change all three for the shipped look), so the comparison is of materials and lighting.
import { boot, frames, SHOW_TIME } from './app.js';

export const NEW = 'backend=webgl&display=classic';
export const LEGACY = 'renderer=legacy';

/** Open one city on both renderers, each in its own page of the same browser. */
export async function openPair(browser, city, { fresh = NEW, legacy = LEGACY } = {}) {
  const make = async (query) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await boot(page, city, query);
    return page;
  };
  return { legacy: await make(legacy), fresh: await make(fresh) };
}

/**
 * Put a page into a scene: a view or a framing ({ view } | { target: { id } | { extra } | { point }, bearing, elev,
 * dist }), pinned day or night ({ look }) or a clock instant ({ timeMs }), the show clocks at `show`.
 */
export async function stageScene(page, scene) {
  await page.evaluate(({ scene, show }) => {
    const s = window.__skyline;
    s.attractions.freeze(scene.show ?? show);
    if (scene.timeMs !== undefined) { s.env.enterClock(); s.clock.set(scene.timeMs); }
    else s.setSetting('night', scene.look === 'night');
    if (scene.view) s.setView(scene.view);
    if (scene.target) {
      // frame a building, an extra or a point the way the landmark checker does (bearing, elevation, distance)
      let box;
      if (scene.target.id) { const t = s.tall.find((e) => e.data.id === scene.target.id); t.mesh.geometry.computeBoundingBox(); box = t.mesh.geometry.boundingBox.clone(); }
      else if (scene.target.extra) { const o = s.attractions.find(scene.target.extra); o.updateMatrixWorld(true); box = boxOf(o); }
      else { const p = scene.target.point; box = { min: { x: p[0] - 50, y: p[1], z: p[2] - 50 }, max: { x: p[0] + 50, y: p[1] + 100, z: p[2] + 50 } }; }
      const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, h = box.max.y - box.min.y;
      const size = Math.max(h, 0.5 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z));
      const ty = box.min.y + 0.45 * h, d = (scene.dist ?? 2.2) * size, el = ((scene.elev ?? 18) * Math.PI) / 180, b = ((scene.bearing ?? 200) * Math.PI) / 180;
      Object.assign(s.controls, { minDistance: 1, maxDistance: 1e7, enableDamping: false });
      s.camera.position.set(cx + d * Math.cos(el) * Math.sin(b), ty + d * Math.sin(el), cz - d * Math.cos(el) * Math.cos(b));
      s.controls.target.set(cx, ty, cz);
      s.controls.update();
    }
    s.renderer.shadowMap.needsUpdate = true;
    s.invalidate();
    function boxOf(o) {
      const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
      o.traverse((m) => {
        if (!m.isMesh) return;
        m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox, e = m.matrixWorld.elements;
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wy = e[1] * x + e[5] * y + e[9] * z + e[13], wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          min.x = Math.min(min.x, wx); min.y = Math.min(min.y, wy); min.z = Math.min(min.z, wz);
          max.x = Math.max(max.x, wx); max.y = Math.max(max.y, wy); max.z = Math.max(max.z, wz);
        }
      });
      return { min, max };
    }
  }, { scene, show: SHOW_TIME });
  await frames(page, 4);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')).opacity === '0');
  await page.evaluate(() => { window.__skyline.renderer.shadowMap.needsUpdate = true; window.__skyline.invalidate(); });
  await frames(page, 3);
}

/**
 * The canvas as RGB bytes, from capture() (the scene only, no interface), cropped to `clip` ({ x, y, w, h } in CSS
 * pixels, default the whole canvas) and reduced by `step` (every step-th pixel each way).
 */
export function grab(page, { clip = null, step = 2 } = {}) {
  return page.evaluate(async ({ clip, step }) => {
    const blob = await window.__skyline.capture();
    const bmp = await createImageBitmap(blob);
    const sx = bmp.width / innerWidth;
    const c = clip || { x: 0, y: 0, w: innerWidth, h: innerHeight };
    const w = Math.floor(c.w / step), h = Math.floor(c.h / step);
    const canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(bmp, c.x * sx, c.y * sx, c.w * sx, c.h * sx, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, rgb = new Array(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
    return { w, h, rgb };
  }, { clip, step });
}

/** Mean absolute difference of two grabs, 0..1 of full scale; also the mean luminance of each. */
export function compare(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`sizes differ: ${a.w}x${a.h} and ${b.w}x${b.h}`);
  let sum = 0, la = 0, lb = 0;
  for (let i = 0; i < a.rgb.length; i++) { sum += Math.abs(a.rgb[i] - b.rgb[i]); la += a.rgb[i]; lb += b.rgb[i]; }
  const n = a.rgb.length;
  return { mad: sum / n / 255, meanA: la / n / 255, meanB: lb / n / 255 };
}

/** A golden PNG (a Buffer) decoded in the page, as RGB bytes reduced by `step`, like grab(). */
export function decodePng(page, buffer, { step = 2 } = {}) {
  return page.evaluate(async ({ b64, step }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const w = Math.floor(bmp.width / step), h = Math.floor(bmp.height / step);
    const canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(bmp, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, rgb = new Array(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
    return { w, h, rgb };
  }, { b64: buffer.toString('base64'), step });
}

/** A full-page screenshot as RGB bytes reduced by `step` (the goldens are full-page, interface included). */
export async function pageShot(page, { step = 2 } = {}) {
  return decodePng(page, await page.screenshot({ animations: 'disabled', caret: 'hide' }), { step });
}

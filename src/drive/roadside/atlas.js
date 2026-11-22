/**
 * The sign atlas: every distinct face packed onto one or a few square pages, then drawn there.
 * Packing is pure (shelves, tallest first); drawing takes a context factory so it runs without a
 * canvas under Node.
 */
import { drawFace, edgeColour } from './faces.js';

export const PAGE = 2048;
export const GUTTER = 4; // px of edge colour around each face, so mipmaps do not bleed between faces
const SMALL = new Set(['speed', 'mile', 'route', 'tab', 'gore']);
// pixels per metre: large panels as dense as one page allows within these bounds; small signs
// (read from close by) twice as dense
const PPM_MAX = 72, PPM_MIN = 40;

/**
 * Pack faces into pages.
 * @param {{ key: string, face: { kind: string, w: number, h: number } }[]} faces distinct faces
 * @param {{ page?: number, ppm?: number }} [opts] ppm fixes the large-panel density (else chosen)
 * @returns {{ ppm: number, pages: { w: number, h: number }[],
 *   rects: Map<string, { page: number, x: number, y: number, w: number, h: number, ppm: number }> }}
 *   x, y, w, h are the face itself in px (the gutter lies outside)
 */
export function packAtlas(faces, { page = PAGE, ppm } = {}) {
  const dens = (f, p) => (SMALL.has(f.kind) ? 2 * p : p);
  if (!ppm) {
    // the density at which everything fills about 80% of one page, within bounds
    const area = faces.reduce((a, { face: f }) => a + f.w * f.h * (SMALL.has(f.kind) ? 4 : 1), 0);
    ppm = Math.max(PPM_MIN, Math.min(PPM_MAX, Math.floor(Math.sqrt((0.8 * page * page) / Math.max(area, 1e-9)))));
  }
  const items = faces.map(({ key, face }) => {
    const p = dens(face, ppm);
    const w = Math.ceil(face.w * p), h = Math.ceil(face.h * p);
    if (w + 2 * GUTTER > page || h + 2 * GUTTER > page) throw new Error(`sign face ${w}x${h} px does not fit a ${page} px page`);
    return { key, w, h, ppm: p };
  }).sort((a, b) => b.h - a.h || b.w - a.w);
  const pages = [];
  const rects = new Map();
  let cur = null;
  const newPage = () => { cur = { w: page, h: 0, shelfY: 0, shelfH: 0, x: 0 }; pages.push(cur); };
  newPage();
  for (const it of items) {
    const W = it.w + 2 * GUTTER, H = it.h + 2 * GUTTER;
    if (cur.x + W > page) { cur.shelfY += cur.shelfH; cur.x = 0; cur.shelfH = 0; }
    if (cur.shelfY + H > page) newPage();
    rects.set(it.key, { page: pages.length - 1, x: cur.x + GUTTER, y: cur.shelfY + GUTTER, w: it.w, h: it.h, ppm: it.ppm });
    cur.x += W;
    cur.shelfH = Math.max(cur.shelfH, H);
    cur.h = Math.max(cur.h, cur.shelfY + cur.shelfH);
  }
  // trim each page to the rows it uses (a multiple of 4)
  return { ppm, pages: pages.map((p) => ({ w: p.w, h: Math.max(4, Math.ceil(p.h / 4) * 4) })), rects };
}

/**
 * Draw every face into its page.
 * @param {object} atlas from packAtlas  @param {Map<string, object>} faceByKey
 * @param {(w: number, h: number) => { getContext(t: '2d'): CanvasRenderingContext2D|null }|null} makeCanvas
 * @returns {object[]} one canvas per page (null where makeCanvas gave none)
 */
export function drawAtlas(atlas, faceByKey, makeCanvas) {
  const canvases = atlas.pages.map((p) => makeCanvas(p.w, p.h));
  const ctxs = canvases.map((c) => c?.getContext('2d') || null);
  for (const [key, r] of atlas.rects) {
    const ctx = ctxs[r.page];
    if (!ctx) continue;
    const face = faceByKey.get(key);
    ctx.fillStyle = edgeColour(face);
    ctx.fillRect(r.x - GUTTER, r.y - GUTTER, r.w + 2 * GUTTER, r.h + 2 * GUTTER);
    drawFace(ctx, face, r.x, r.y, r.w / face.w);
  }
  return canvases;
}

/**
 * Sign faces drawn with any 2D context: green guide signs with white legend and border, the exit
 * number plaque, gore signs, white regulatory speed limits, green mile markers and the plain route
 * shield. Pure apart from the context it is handed, so layout and text fitting run under Node with
 * a stand-in context.
 *
 * The layout (margins, row heights, gaps in units of the letter height) is the one
 * scripts/lib/roadside_panels.py sizes the panels with. Keep the two together.
 */

/**
 * The typeface, in one place. No font files ship with the app (an open highway face such as the
 * Roadgeek 2014 set can be dropped in later by naming it first); until then a bold system sans,
 * condensed where the platform has one, stands in for highway lettering.
 */
export const SIGN_FONT = '"Roadgeek 2014 Series EM", Overpass, Bahnschrift, "DIN Alternate", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
/** Cap height as a fraction of the font size, for a typical grotesque. */
export const CAP_RATIO = 0.72;
/** Narrowest horizontal scale text may be condensed to before it takes a second line or shrinks. */
export const MIN_CONDENSE = 0.8;

/** Sign colours, sRGB (FHWA's daytime colours as commonly reproduced). */
export const COLOURS = { green: '#006b45', white: '#f4f5f0', black: '#141414', yellow: '#f5c400' };

const IN = 0.0254;
// layout in units of the letter height (scripts/lib/roadside_panels.py)
export const LAYOUT = { side: 1.0, topbot: 0.75, gap: 0.75, shield: 2.25, arrow: 1.6, border: 2 * IN, edge: 1 * IN };
const TAB = { word: 12 * IN, num: 15 * IN };

const font = (capPx) => `bold ${capPx / CAP_RATIO}px ${SIGN_FONT}`;

/**
 * Fit text to a width by rule: the letter height first, then condensing down to MIN_CONDENSE,
 * then (when `lines` allows) a second line split at the best space, and only then a smaller
 * letter. Never overflows.
 * @param {{ font: string, measureText(t: string): { width: number } }} ctx
 * @param {string} text  @param {number} capPx letter height  @param {number} maxWidth px
 * @param {{ lines?: number }} [opts]
 * @returns {{ lines: { text: string, width: number }[], capPx: number, scaleX: number, shrunk: boolean }}
 *   width is the drawn width of each line after scaleX
 */
export function fitText(ctx, text, capPx, maxWidth, { lines = 1 } = {}) {
  ctx.font = font(capPx);
  const w = (t) => ctx.measureText(t).width;
  const one = w(text);
  if (one <= maxWidth) return { lines: [{ text, width: one }], capPx, scaleX: 1, shrunk: false };
  if (one * MIN_CONDENSE <= maxWidth) {
    const scaleX = maxWidth / one;
    return { lines: [{ text, width: one * scaleX }], capPx, scaleX, shrunk: false };
  }
  const words = text.split(' ');
  if (lines >= 2 && words.length > 1) {
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      const m = Math.max(w(a), w(b));
      if (!best || m < best.m) best = { a, b, m };
    }
    if (best.m * MIN_CONDENSE <= maxWidth) {
      const scaleX = Math.min(1, maxWidth / best.m);
      return { lines: [best.a, best.b].map((t) => ({ text: t, width: w(t) * scaleX })), capPx, scaleX, shrunk: false };
    }
  }
  const k = maxWidth / (one * MIN_CONDENSE);
  const capSmall = capPx * k;
  ctx.font = font(capSmall);
  return { lines: [{ text, width: w(text) * MIN_CONDENSE }], capPx: capSmall, scaleX: MIN_CONDENSE, shrunk: true };
}

/**
 * Extra stroke weight, as a fraction of the letter height, for the small signs read from far off
 * at a few pixels: highway numerals (FHWA Series E) are heavier than a system bold, and a thin
 * stroke averages away into the panel in the texture's smaller mip levels.
 */
export const WEIGHT = { speedWord: 0.06, speedNum: 0.08, mileWord: 0.06, mileNum: 0.09, route: 0.05 };

/** Draw fitted text with its left end at x and its baseline at y, thickened by `weight` letter heights. */
function drawFitted(ctx, fit, x, y, lineGap = 0, weight = 0) {
  ctx.font = font(fit.capPx);
  fit.lines.forEach((ln, i) => {
    ctx.save();
    ctx.translate(x, y + i * (fit.capPx + lineGap));
    ctx.scale(fit.scaleX, 1);
    ctx.fillText(ln.text, 0, 0);
    if (weight > 0 && ctx.strokeText) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = weight * fit.capPx;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.strokeText(ln.text, 0, 0);
    }
    ctx.restore();
  });
}

/** fitText for a weighted legend: the stroke's extra width stays inside maxWidth. */
const fitWeighted = (ctx, text, capPx, maxWidth, weight) => {
  const f = fitText(ctx, text, capPx, maxWidth - weight * capPx);
  f.lines.forEach((ln) => { ln.width += weight * f.capPx; });
  return f;
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Background, then a border of width b inset by e, with rounded corners. */
function panel(ctx, w, h, bg, fg, b, e, r) {
  ctx.fillStyle = COLOURS[bg];
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = COLOURS[fg];
  roundRect(ctx, e, e, w - 2 * e, h - 2 * e, r);
  ctx.fill();
  ctx.fillStyle = COLOURS[bg];
  roundRect(ctx, e + b, e + b, w - 2 * (e + b), h - 2 * (e + b), Math.max(0, r - b));
  ctx.fill();
}

/** The plain route shield of this project's own drawing (no Interstate colours): w x h at (x, y). */
export function drawShield(ctx, num, x, y, w, h) {
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x + 0.06 * w, y);
    ctx.lineTo(x + 0.94 * w, y);
    ctx.quadraticCurveTo(x + w, y + 0.02 * h, x + w, y + 0.12 * h);
    ctx.lineTo(x + w, y + 0.48 * h);
    ctx.quadraticCurveTo(x + w, y + 0.86 * h, x + 0.5 * w, y + h);
    ctx.quadraticCurveTo(x, y + 0.86 * h, x, y + 0.48 * h);
    ctx.lineTo(x, y + 0.12 * h);
    ctx.quadraticCurveTo(x, y + 0.02 * h, x + 0.06 * w, y);
    ctx.closePath();
  };
  path();
  ctx.fillStyle = COLOURS.black;
  ctx.fill();
  const t = 0.05 * w;
  ctx.save();
  ctx.translate(x + w / 2, y + h * 0.47);
  ctx.scale(1 - (2 * t) / w, 1 - (2 * t) / h);
  ctx.translate(-(x + w / 2), -(y + h * 0.47));
  path();
  ctx.fillStyle = COLOURS.white;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = COLOURS.black;
  const fit = fitText(ctx, num, 0.42 * h, 0.78 * w);
  drawFitted(ctx, fit, x + (w - fit.lines[0].width) / 2, y + 0.46 * h + fit.capPx / 2);
}

/** A diagonal arrow pointing up and away, filling a box `size` square at (x, y). */
function drawArrow(ctx, x, y, size, left) {
  ctx.save();
  ctx.translate(x + size / 2, y + size / 2);
  ctx.rotate(left ? -Math.PI / 4 : Math.PI / 4);
  const L = size * 0.62, sw = size * 0.13, hw = size * 0.3, hl = size * 0.32;
  ctx.beginPath();
  ctx.moveTo(-sw / 2, L);
  ctx.lineTo(-sw / 2, -L + hl);
  ctx.lineTo(-hw, -L + hl);
  ctx.lineTo(0, -L);
  ctx.lineTo(hw, -L + hl);
  ctx.lineTo(sw / 2, -L + hl);
  ctx.lineTo(sw / 2, L);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The legend rows of a green guide sign, heights in letter heights (as guide_rows in Python). */
export function guideRows(face) {
  const rows = [];
  if (face.shields?.length) rows.push({ kind: 'shields', h: LAYOUT.shield });
  for (const t of face.lines || []) rows.push({ kind: 'line', text: t, h: 1 });
  if (face.action) rows.push({ kind: 'action', text: face.action, h: 1 });
  if (face.arrow) rows.push({ kind: 'arrow', h: LAYOUT.arrow });
  for (const r of face.rows || []) rows.push({ kind: 'seq', row: r, h: 1 });
  return rows;
}

/**
 * Lay out a guide face: where each row goes, in px, for a panel W x H px with letters capPx tall.
 * @returns {{ rows: object[], fits: object[] }} each row gains y (its top), and text rows a fit
 */
export function layoutGuide(ctx, face, W, H, capPx) {
  const rows = guideRows(face);
  const inner = W - 2 * LAYOUT.side * capPx;
  const total = rows.reduce((a, r) => a + r.h * capPx, 0) + LAYOUT.gap * capPx * (rows.length - 1);
  let y = (H - total) / 2;
  for (const r of rows) {
    r.y = y;
    if (r.kind === 'line' || r.kind === 'action') r.fit = fitText(ctx, r.text, capPx, inner);
    if (r.kind === 'seq') {
      r.dist = fitText(ctx, r.row.dist, capPx, inner / 3);
      r.fit = fitText(ctx, r.row.text, capPx, inner - r.dist.lines[0].width - 2 * capPx);
    }
    y += r.h * capPx + LAYOUT.gap * capPx;
  }
  return { rows, inner };
}

/**
 * Left edge, in px, of a guide face's arrow box: centred under EXIT and its number on a gore sign
 * (MUTCD E5-1), at the side of the exit on any other guide sign.
 */
export function arrowX(face, W, capPx) {
  const a = LAYOUT.arrow * capPx;
  if (face.centreArrow || face.kind === 'gore') return (W - a) / 2;
  return face.arrow === 'left' ? LAYOUT.side * capPx : W - LAYOUT.side * capPx - a;
}

function drawGuide(ctx, face, W, H, ppm) {
  const capPx = face.cap * ppm;
  panel(ctx, W, H, face.bg, face.fg, LAYOUT.border * ppm, LAYOUT.edge * ppm, Math.min(W, H) * 0.08);
  ctx.fillStyle = COLOURS[face.fg];
  const { rows } = layoutGuide(ctx, face, W, H, capPx);
  const left = LAYOUT.side * capPx, right = W - LAYOUT.side * capPx;
  for (const r of rows) {
    if (r.kind === 'line' || r.kind === 'action') drawFitted(ctx, r.fit, (W - r.fit.lines[0].width) / 2, r.y + capPx);
    else if (r.kind === 'seq') {
      drawFitted(ctx, r.fit, left, r.y + capPx);
      drawFitted(ctx, r.dist, right - r.dist.lines[0].width, r.y + capPx);
    } else if (r.kind === 'arrow') {
      const a = LAYOUT.arrow * capPx;
      drawArrow(ctx, arrowX(face, W, capPx), r.y, a, face.arrow === 'left');
    } else if (r.kind === 'shields') drawShieldRow(ctx, face.shields, W, r.y, capPx);
    ctx.fillStyle = COLOURS[face.fg];
  }
}

function drawShieldRow(ctx, shields, W, y, capPx) {
  const sh = LAYOUT.shield * capPx;
  const items = shields.map((s) => {
    const sw = sh * (s.num.length <= 2 ? 1 : 1.3);
    let dw = 0;
    if (s.dir) { ctx.font = font(0.75 * capPx); dw = 0.4 * capPx + ctx.measureText(s.dir.toUpperCase()).width; }
    return { s, sw, dw };
  });
  const total = items.reduce((a, it) => a + it.sw + it.dw, 0) + capPx * (items.length - 1);
  const k = Math.min(1, (W - 2 * LAYOUT.side * capPx) / total); // never wider than the panel
  let x = (W - total * k) / 2;
  for (const it of items) {
    drawShield(ctx, it.s.num, x, y + sh * (1 - k) / 2, it.sw * k, sh * k);
    x += it.sw * k;
    if (it.s.dir) {
      ctx.fillStyle = COLOURS.white;
      const fit = fitText(ctx, it.s.dir.toUpperCase(), 0.75 * capPx * k, it.dw * k);
      drawFitted(ctx, fit, x + 0.4 * capPx * k, y + sh / 2 + fit.capPx / 2);
      x += it.dw * k;
    }
    x += capPx * k;
  }
}

function drawTab(ctx, face, W, H, ppm) {
  panel(ctx, W, H, 'green', 'white', LAYOUT.border * ppm, LAYOUT.edge * ppm, H * 0.18);
  const [word, num] = face.text.split(' ');
  let x = 8 * IN * ppm;
  const base = H / 2 + (TAB.num * ppm) / 2;
  if (face.left) {
    ctx.font = font(TAB.word * ppm);
    const lw = ctx.measureText('LEFT').width;
    const pad = 4 * IN * ppm;
    const e = (LAYOUT.edge + LAYOUT.border) * ppm;
    ctx.fillStyle = COLOURS.yellow;
    ctx.fillRect(e, e, lw + 2 * pad + 2 * IN * ppm, H - 2 * e);
    ctx.fillStyle = COLOURS.black;
    ctx.fillText('LEFT', e + pad + IN * ppm, base);
    x = e + lw + 2 * pad + 2 * IN * ppm + 6 * IN * ppm;
  }
  ctx.fillStyle = COLOURS.white;
  const avail = W - x - 6 * IN * ppm;
  const wordFit = fitText(ctx, word, TAB.word * ppm, num ? avail * 0.5 : avail);
  drawFitted(ctx, wordFit, x, base);
  if (num) {
    const nx = x + wordFit.lines[0].width + 0.4 * TAB.word * ppm;
    drawFitted(ctx, fitText(ctx, num, TAB.num * ppm, W - nx - 6 * IN * ppm), nx, base);
  }
}

function drawGore(ctx, face, W, H, ppm) {
  drawGuide(ctx, { ...face, lines: face.number ? ['EXIT', face.number] : ['EXIT'], arrow: face.arrow, centreArrow: true }, W, H, ppm);
}

function drawSpeed(ctx, face, W, H, ppm) {
  panel(ctx, W, H, 'white', 'black', 0.75 * IN * ppm, 0.5 * IN * ppm, 3 * IN * ppm);
  ctx.fillStyle = COLOURS.black;
  const inner = W - 6 * IN * ppm;
  const word = 8 * IN * ppm;
  for (const [t, y] of [['SPEED', 5], ['LIMIT', 16]]) {
    const f = fitWeighted(ctx, t, word, inner, WEIGHT.speedWord);
    drawFitted(ctx, f, (W - f.lines[0].width) / 2 + (WEIGHT.speedWord * f.capPx) / 2, (y * IN) * ppm + word, 0, WEIGHT.speedWord);
  }
  const f = fitWeighted(ctx, String(face.mph), face.cap * ppm, inner, WEIGHT.speedNum);
  drawFitted(ctx, f, (W - f.lines[0].width) / 2 + (WEIGHT.speedNum * f.capPx) / 2, 30 * IN * ppm + f.capPx, 0, WEIGHT.speedNum);
}

function drawMile(ctx, face, W, H, ppm) {
  panel(ctx, W, H, 'green', 'white', 0.5 * IN * ppm, 0.375 * IN * ppm, 1.5 * IN * ppm);
  ctx.fillStyle = COLOURS.white;
  const inner = W - 2 * IN * ppm;
  const f = fitWeighted(ctx, 'MILE', 4 * IN * ppm, inner, WEIGHT.mileWord);
  drawFitted(ctx, f, (W - f.lines[0].width) / 2 + (WEIGHT.mileWord * f.capPx) / 2, 2 * IN * ppm + f.capPx, 0, WEIGHT.mileWord);
  let y = 8 * IN * ppm;
  for (const d of String(face.mile)) { // stacked digits, as on freeway reference location signs
    const g = fitWeighted(ctx, d, face.cap * ppm, inner, WEIGHT.mileNum);
    drawFitted(ctx, g, (W - g.lines[0].width) / 2 + (WEIGHT.mileNum * g.capPx) / 2, y + g.capPx, 0, WEIGHT.mileNum);
    y += g.capPx + 2 * IN * ppm;
  }
}

function drawRoute(ctx, face, W, H, ppm) {
  ctx.fillStyle = COLOURS.white;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = COLOURS.black;
  ctx.lineWidth = 0.75 * IN * ppm;
  const plaque = 18 * IN * ppm;
  roundRect(ctx, 0.75 * IN * ppm, 0.75 * IN * ppm, W - 1.5 * IN * ppm, plaque - 1.5 * IN * ppm, 1.5 * IN * ppm);
  ctx.stroke();
  ctx.fillStyle = COLOURS.black;
  const f = fitText(ctx, face.dir, 10 * IN * ppm, W - 6 * IN * ppm);
  drawFitted(ctx, f, (W - f.lines[0].width) / 2, plaque / 2 + f.capPx / 2);
  const s = H - plaque - 2 * IN * ppm;
  drawShield(ctx, face.route.num, (W - s) / 2, plaque + IN * ppm, s, s);
}

const DRAW = { advance: drawGuide, exit: drawGuide, sequence: drawGuide, gore: drawGore, tab: drawTab, speed: drawSpeed, mile: drawMile, route: drawRoute };

/**
 * Draw one face into the rectangle (x, y, w*ppm, h*ppm) of ctx.
 * @param {object} face from faceOf(): { kind, w, h, cap, bg, fg, ... } in metres
 * @param {number} ppm pixels per metre
 */
export function drawFace(ctx, face, x, y, ppm) {
  const W = face.w * ppm, H = face.h * ppm;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  ctx.textBaseline = 'alphabetic';
  DRAW[face.kind](ctx, face, W, H, ppm);
  ctx.restore();
}

/** The colour of a face's outermost pixels, for the atlas gutter around it. */
export const edgeColour = (face) => COLOURS[face.kind === 'route' || face.kind === 'speed' ? 'white' : 'green'];

/**
 * The faces one sign record shows: its panel, and the exit number plaque above a guide sign.
 * @param {object} rec a signs.json record  @param {object[]} exits the road's exit table
 * @returns {{ key: string, face: object, plate: 'panel'|'tab' }[]}
 */
export function facesOf(rec, exits) {
  const e = rec.exit != null ? exits[rec.exit] : null;
  const face = { kind: rec.kind, w: rec.w, h: rec.h, cap: rec.cap, bg: rec.bg, fg: rec.fg };
  if (rec.kind === 'advance' || rec.kind === 'exit') Object.assign(face, { lines: e.lines, shields: e.shields });
  if (rec.action) face.action = rec.action;
  if (rec.arrow) face.arrow = rec.arrow;
  if (rec.rows) face.rows = rec.rows;
  if (rec.kind === 'gore') face.number = e.number;
  if (rec.kind === 'speed') face.mph = rec.mph;
  if (rec.kind === 'mile') face.mile = rec.mile;
  if (rec.kind === 'route') Object.assign(face, { route: rec.route, dir: rec.dir });
  const out = [{ key: JSON.stringify(face), face, plate: 'panel' }];
  if (e?.tab && rec.kind !== 'gore' && rec.kind !== 'sequence') {
    const tab = { kind: 'tab', w: e.tab.w, h: e.tab.h, text: e.tab.text, left: e.tab.left };
    out.push({ key: JSON.stringify(tab), face: tab, plate: 'tab' });
  }
  return out;
}

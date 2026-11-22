// Shared helpers for the roadside tests: the real signs.json and roadnet, and a 2D context stand-in.
import { readFileSync } from 'node:fs';
import { decodeRoadNet } from '../../../src/drive/roadnet/format.js';

export const BASE = 620;
export const EARTH_R = (6371000 * 7) / 6;
const data = new URL('../../../public/data/lv/', import.meta.url);

export const signsJson = () => JSON.parse(readFileSync(new URL('signs.json', data), 'utf8'));

export function realRoadnet() {
  const json = JSON.parse(readFileSync(new URL('roadnet.json', data), 'utf8'));
  const b = readFileSync(new URL('roadnet.bin', data));
  return decodeRoadNet(json, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

// Helvetica Bold advance widths per 1000 em: the metrics scripts/lib/roadside_legend.py sizes panels with
const W = {};
' !"#$%&\'()*+,-./'.split('').forEach((c, i) => { W[c] = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278][i]; });
'0123456789'.split('').forEach((c) => { W[c] = 556; });
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { W[c] = [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611][i]; });
'abcdefghijklmnopqrstuvwxyz'.split('').forEach((c, i) => { W[c] = [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500][i]; });
W['½'] = W['¼'] = W['¾'] = 834;

/**
 * A 2D context that measures text with fixed metrics (scaled by `wide`) and records where text
 * lands, through translate/scale transforms.
 */
export function fakeContext({ wide = 1 } = {}) {
  let t = [1, 1, 0, 0]; // sx, sy, tx, ty
  const stack = [];
  const ctx = {
    font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, textBaseline: 'alphabetic',
    texts: [], fills: [],
    measureText(text) {
      const px = parseFloat(/([\d.]+)px/.exec(this.font)[1]);
      return { width: [...text].reduce((a, c) => a + (W[c] ?? 600), 0) / 1000 * px * wide };
    },
    save() { stack.push([...t]); },
    restore() { t = stack.pop(); },
    translate(x, y) { t = [t[0], t[1], t[2] + t[0] * x, t[3] + t[1] * y]; },
    scale(x, y) { t = [t[0] * x, t[1] * y, t[2], t[3]]; },
    rotate() {},
    fillText(text, x, y) {
      const w = this.measureText(text).width;
      ctx.texts.push({ text, left: t[2] + t[0] * x, right: t[2] + t[0] * (x + w), y: t[3] + t[1] * y, font: this.font });
    },
    fillRect(x, y, w, h) { ctx.fills.push({ color: this.fillStyle, x: t[2] + t[0] * x, y: t[3] + t[1] * y, w: w * t[0], h: h * t[1] }); },
  };
  for (const k of ['beginPath', 'moveTo', 'lineTo', 'arcTo', 'quadraticCurveTo', 'closePath', 'fill', 'stroke', 'rect', 'clip']) ctx[k] = () => {};
  return ctx;
}

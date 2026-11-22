import { describe, it, expect } from 'vitest';
import { fitText, layoutGuide, drawFace, facesOf, MIN_CONDENSE, CAP_RATIO, COLOURS, SIGN_FONT } from '../../../src/drive/roadside/faces.js';
import { fakeContext, signsJson } from './helpers.js';

const road = signsJson().roads[0];
const allFaces = () => {
  const m = new Map();
  for (const rec of road.signs) for (const f of facesOf(rec, road.exits)) m.set(f.key, f.face);
  return [...m.values()];
};

describe('text fitting', () => {
  const ctx = fakeContext();
  const width = (t, cap) => { ctx.font = `bold ${cap / CAP_RATIO}px x`; return ctx.measureText(t).width; };

  it('keeps the letter height when the text fits', () => {
    const f = fitText(ctx, 'Sloan', 40, 1000);
    expect(f).toMatchObject({ capPx: 40, scaleX: 1, shrunk: false });
    expect(f.lines).toHaveLength(1);
  });

  it('condenses next, down to MIN_CONDENSE, keeping the letter height', () => {
    const w = width('Silverado Ranch Blvd', 40);
    const f = fitText(ctx, 'Silverado Ranch Blvd', 40, w * 0.9);
    expect(f.capPx).toBe(40);
    expect(f.scaleX).toBeCloseTo(0.9, 6);
    expect(f.lines[0].width).toBeCloseTo(w * 0.9, 6);
  });

  it('takes a second line when condensing is not enough and two are allowed', () => {
    const w = width('Southern Highlands Pkwy', 40);
    const f = fitText(ctx, 'Southern Highlands Pkwy', 40, w * 0.6, { lines: 2 });
    expect(f.lines).toHaveLength(2);
    expect(f.lines.map((l) => l.text).join(' ')).toBe('Southern Highlands Pkwy');
    expect(f.capPx).toBe(40);
    for (const l of f.lines) expect(l.width).toBeLessThanOrEqual(w * 0.6 + 1e-9);
  });

  it('shrinks only as a last resort, and never overflows', () => {
    for (const maxW of [10, 50, 120, 300]) {
      const f = fitText(ctx, 'Martin L King', 40, maxW);
      for (const l of f.lines) expect(l.width).toBeLessThanOrEqual(maxW + 1e-9);
      expect(f.scaleX).toBeGreaterThanOrEqual(MIN_CONDENSE - 1e-9);
    }
    expect(fitText(ctx, 'Martin L King', 40, 50).shrunk).toBe(true);
  });

  it('names one font family constant, bold sans with a condensed choice', () => {
    expect(SIGN_FONT).toMatch(/sans-serif$/);
    expect(SIGN_FONT).toMatch(/Narrow|Condensed|Bahnschrift/);
  });
});

describe('guide sign layout against the panels the pipeline sized', () => {
  it('fits every legend of signs.json at its letter height without condensing, inside the panel', () => {
    const ppm = 50;
    for (const face of allFaces().filter((f) => ['advance', 'exit', 'sequence', 'gore'].includes(f.kind))) {
      const ctx = fakeContext();
      const W = face.w * ppm, H = face.h * ppm, cap = face.cap * ppm;
      const f = face.kind === 'gore' ? { ...face, lines: face.number ? ['EXIT', face.number] : ['EXIT'] } : face;
      const { rows, inner } = layoutGuide(ctx, f, W, H, cap);
      expect(rows[0].y).toBeGreaterThanOrEqual(0.7 * cap); // the top margin holds
      const last = rows[rows.length - 1];
      expect(last.y + last.h * cap).toBeLessThanOrEqual(H - 0.7 * cap);
      for (const r of rows.filter((x) => x.fit)) {
        expect(r.fit.shrunk).toBe(false);
        expect(r.fit.scaleX).toBe(1);
        expect(r.fit.lines[0].width).toBeLessThanOrEqual(inner + 1e-6);
      }
    }
  });

  it('still never overflows when the real font is 20% wider than the sizing metrics', () => {
    for (const face of allFaces()) {
      const ctx = fakeContext({ wide: 1.2 });
      const ppm = 60;
      drawFace(ctx, face, 100, 50, ppm);
      for (const t of ctx.texts) {
        expect(t.left).toBeGreaterThanOrEqual(100 - 1e-6);
        expect(t.right).toBeLessThanOrEqual(100 + face.w * ppm + 1e-6);
      }
    }
  });

  it('draws every kind of face, with the legend it carries', () => {
    const kinds = new Set();
    for (const face of allFaces()) {
      const ctx = fakeContext();
      drawFace(ctx, face, 0, 0, 40);
      kinds.add(face.kind);
      const text = ctx.texts.map((t) => t.text).join(' ');
      if (face.lines) for (const l of face.lines) expect(text).toContain(l);
      if (face.kind === 'speed') expect(text).toContain(String(face.mph));
      if (face.kind === 'tab') expect(text).toContain(face.text.split(' ').pop());
      if (face.kind === 'tab' && face.left) expect(ctx.fills.some((f) => f.color === COLOURS.yellow)).toBe(true);
    }
    expect([...kinds].sort()).toEqual(['advance', 'exit', 'gore', 'mile', 'route', 'sequence', 'speed', 'tab']);
  });

  it('uses MUTCD colours: green guide signs, white regulatory signs', () => {
    const hue = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mx === g ? 60 * ((b - r) / (mx - mn) + 2) : NaN;
    };
    expect(hue(COLOURS.green)).toBeGreaterThan(135);
    expect(hue(COLOURS.green)).toBeLessThan(175);
    for (const face of allFaces()) {
      if (['advance', 'exit', 'sequence', 'gore', 'mile'].includes(face.kind)) expect([face.bg, face.fg]).toEqual(['green', 'white']);
      if (['speed', 'route'].includes(face.kind)) expect([face.bg, face.fg]).toEqual(['white', 'black']);
    }
  });
});

// D7.4: the advertisements on the billboard faces. The image set (public/textures/billboards/manifest.json, when it
// exists) and its packed atlas (scripts/pack_billboards.py), the choice of image per face, the digital rotation and
// its flash measure (plan 02, section 4.11), and the fallback to the generated artwork when the images fail.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as THREE from 'three';
import { adFrame, adMean, assignImages, fitOf, imageAt, kindForAspect, NO_REPEAT_BOARDS, shaderTables, stepFor, textureBytes } from '../../../src/drive/roadside/billboardsImages.js';
import { boardOf, panelsOf, faceSeed, createBillboardsPart } from '../../../src/drive/roadside/billboards.js';
import { PLAIN } from '../../../src/drive/roadside/billboardsFace.js';
import { HOLD_S, FADE_S, phaseOf } from '../../../src/drive/screens/digital.js';
import { measureFlash, luminance, FLASH_LIMIT_HZ } from '../../../src/drive/screens/flash.js';
import { hash32 } from '../../../src/drive/screens/art.js';

const ROOT = path.resolve(__dirname, '../../..');
const DIR = path.join(ROOT, 'public/textures/billboards');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const manifest = fs.existsSync(path.join(DIR, 'manifest.json')) ? readJson(path.join(DIR, 'manifest.json')) : null;
const atlasDoc = fs.existsSync(path.join(DIR, 'atlas.json')) ? readJson(path.join(DIR, 'atlas.json')) : null;
const SIZES = { bulletin: [1024, 300], poster: [768, 384] };

/** Width and height of a WebP file from its header (VP8, VP8L or VP8X). */
function webpSize(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
  if (kind === 'VP8X') return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  return null;
}

/** The deny-list's terms as whole-word, case-insensitive patterns (scripts/lib/roadside_legend.py's rule). */
function denyPatterns() {
  return fs.readFileSync(path.join(ROOT, 'data/sign_denylist.txt'), 'utf8').split('\n')
    .map((l) => l.split('#')[0].trim()).filter(Boolean)
    .map((t) => [t, new RegExp(`(?<![\\p{L}\\p{N}_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")}(?![\\p{L}\\p{N}_])`, 'iu')]);
}
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

/** The real boards' faces, as billboards.js lays them out. */
function realFaces() {
  const doc = readJson(path.join(ROOT, 'public/data/lv/billboards.json'));
  const faces = [];
  doc.boards.map((r) => boardOf(r, doc.fields)).forEach((b, bi) => panelsOf(b).forEach((p, i) => {
    faces.push({ board: bi, x: b.x, y: b.y, seed: faceSeed(b.seed >>> 0, i), aspect: b.w / b.h, digital: b.digital === 1 });
  }));
  return faces;
}
const testImages = () => (atlasDoc ? atlasDoc.images : [
  ...Array.from({ length: 32 }, (_, i) => ({ id: `bulletin-${i}`, kind: 'bulletin', aspect: 1024 / 300, mean: [0.2 + i / 100, 0.3, 0.4] })),
  ...Array.from({ length: 8 }, (_, i) => ({ id: `poster-${i}`, kind: 'poster', aspect: 2, mean: [0.5, 0.2 + i / 50, 0.1] })),
]);

describe.skipIf(!manifest)('the image set', () => {
  it('has the manifest\'s shape', () => {
    expect(manifest.version).toBe(1);
    expect(Array.isArray(manifest.images)).toBe(true);
    const ids = new Set();
    for (const im of manifest.images) {
      expect(typeof im.id).toBe('string');
      expect(ids.has(im.id), im.id).toBe(false);
      ids.add(im.id);
      expect(Object.keys(SIZES)).toContain(im.kind);
      expect([im.w, im.h], im.id).toEqual(SIZES[im.kind]);
      expect(im.file).toMatch(/^[\w-]+\.webp$/);
      expect(Array.isArray(im.text) && im.text.every((t) => typeof t === 'string')).toBe(true);
      for (const k of ['business', 'idea', 'method']) expect(typeof im[k], `${im.id}.${k}`).toBe('string');
    }
    expect(manifest.images.filter((i) => i.kind === 'bulletin').length).toBeGreaterThanOrEqual(NO_REPEAT_BOARDS * 2);
    expect(manifest.images.filter((i) => i.kind === 'poster').length).toBeGreaterThanOrEqual(2);
  });

  it('every file is present at its stated size', () => {
    for (const im of manifest.images) {
      const f = path.join(DIR, im.file);
      expect(fs.existsSync(f), im.file).toBe(true);
      expect(webpSize(fs.readFileSync(f)), im.file).toEqual([im.w, im.h]);
    }
  });

  it('names no trade name of the deny-list anywhere', () => {
    const pats = denyPatterns();
    expect(pats.length).toBeGreaterThan(20);
    expect(pats.some(([, re]) => re.test('Welcome to the Bellagio'))).toBe(true); // the rule bites
    const hits = [];
    for (const s of strings(manifest)) for (const [t, re] of pats) if (re.test(s)) hits.push(`${t}: ${s}`);
    expect(hits).toEqual([]);
  });

  it('is packed: atlas.json matches the manifest and the files (rerun scripts/pack_billboards.py if not)', () => {
    expect(atlasDoc).toBeTruthy();
    for (const [f, sha] of Object.entries(atlasDoc.sources)) {
      expect(crypto.createHash('sha1').update(fs.readFileSync(path.join(DIR, f))).digest('hex'), `${f} changed since the atlas was packed`).toBe(sha);
    }
    expect(atlasDoc.images.map((i) => i.id).sort()).toEqual(manifest.images.map((i) => i.id).sort());
  });
});

describe.skipIf(!atlasDoc)('the atlas', () => {
  it('fits the budgets: one request a device, under 2.5 MB, 24 MiB of texture memory on desktops and half on the low tier', () => {
    const { high, low } = atlasDoc.tiers;
    for (const t of [high, low]) {
      const f = path.join(DIR, t.file);
      expect(fs.statSync(f).size).toBe(t.bytes);
      expect(webpSize(fs.readFileSync(f))).toEqual([t.w, t.h]);
      expect(t.w).toBeLessThanOrEqual(4096);
      expect(t.h).toBeLessThanOrEqual(4096);
    }
    expect(high.bytes + fs.statSync(path.join(DIR, 'atlas.json')).size).toBeLessThan(2.5e6);
    expect(textureBytes(high.w, high.h)).toBeLessThan(24 * 2 ** 20);
    expect(textureBytes(low.w, low.h)).toBeLessThan(12 * 2 ** 20);
  });

  it('keeps every image in its own rectangle, a gutter apart, the image\'s shape kept', () => {
    const g = atlasDoc.gutter;
    expect(g).toBeGreaterThanOrEqual(4);
    for (const tier of ['high', 'low']) {
      const { w, h } = atlasDoc.tiers[tier];
      const rs = atlasDoc.images.map((im) => {
        const [x, y, rw, rh] = im.rect[tier];
        expect(x - g).toBeGreaterThanOrEqual(0);
        expect(y - g).toBeGreaterThanOrEqual(0);
        expect(x + rw + g).toBeLessThanOrEqual(w);
        expect(y + rh + g).toBeLessThanOrEqual(h);
        expect(Math.abs(rw / rh - im.aspect) / im.aspect).toBeLessThan(0.01);
        return [x - g, y - g, x + rw + g, y + rh + g];
      });
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const [a, b] = [rs[i], rs[j]];
        expect(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], `${tier} ${i} ${j} overlap`).toBe(true);
      }
      // the shader's table: bottom-left texture coordinates inside 0..1
      const { rects } = shaderTables(atlasDoc, tier);
      for (let i = 0; i < rects.length; i += 4) {
        expect(rects[i]).toBeGreaterThan(0);
        expect(rects[i + 1]).toBeGreaterThan(0);
        expect(rects[i] + rects[i + 2]).toBeLessThan(1);
        expect(rects[i + 1] + rects[i + 3]).toBeLessThan(1);
      }
    }
    // each kind's images together (the shader indexes base + i)
    const kinds = atlasDoc.images.map((i) => i.kind);
    expect(kinds.filter((k, i) => i && k !== kinds[i - 1]).length).toBe(new Set(kinds).size - 1);
  });

  it('keeps each image\'s mean colour, linear', () => {
    for (const im of atlasDoc.images) {
      expect(im.mean.length).toBe(3);
      for (const v of im.mean) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }
      expect(im.luminance).toBeCloseTo(luminance(...im.mean), 5);
    }
  });
});

describe('the choice of image', () => {
  const images = testImages();
  const faces = realFaces();
  const got = assignImages(faces, images);

  it('takes the kind nearer the face\'s shape, and never stretches it', () => {
    const aspects = { bulletin: 1024 / 300, poster: 2 };
    expect(kindForAspect(14.63 / 4.27, aspects)).toBe('bulletin');
    expect(kindForAspect(7.32 / 3.66, aspects)).toBe('poster');
    expect(kindForAspect(8.53 / 7.32, aspects)).toBe('poster');
    expect(kindForAspect(12.19 / 3.05, aspects)).toBe('bulletin');
    faces.forEach((f, i) => {
      const a = got[i], im = images[imageAt(a, 0)];
      expect(im.kind).toBe(a.kind);
      expect(a.kind).toBe(kindForAspect(f.aspect, aspects));
      // the shown part of the image has the image's own shape: face aspect x sy / sx = image aspect
      expect((f.aspect * a.fit[1]) / a.fit[0]).toBeCloseTo(im.aspect, 6);
      // it either fills the face (a crop of at most 6%) or is whole inside it (letterbox)
      expect(Math.min(...a.fit)).toBeGreaterThanOrEqual(1 - 0.06 - 1e-9);
    });
    expect(fitOf(2, 2)).toEqual([1, 1]);
    expect(fitOf(4, 2)).toEqual([2, 1]); // letterboxed: bars at the sides
    expect(fitOf(1, 2)).toEqual([1, 2]); // letterboxed: bars above and below
    expect(fitOf(2.1, 2)[0]).toBe(1); // cropped a little at the top and bottom
  });

  it('is stable: the same board shows the same advertisement whatever the order of the data', () => {
    expect(assignImages(faces, images)).toEqual(got);
    const order = faces.map((f, i) => i).sort((a, b) => hash32(a) - hash32(b));
    const shuffled = assignImages(order.map((i) => faces[i]), images);
    order.forEach((i, j) => expect(shuffled[j]).toEqual(got[i]));
  });

  it(`shows no image twice among the faces of the ${NO_REPEAT_BOARDS} nearest boards`, () => {
    const boards = new Map();
    faces.forEach((f, i) => { if (!boards.has(f.board)) boards.set(f.board, { x: f.x, y: f.y, faces: [] }); boards.get(f.board).faces.push(i); });
    const statics = (b) => boards.get(b).faces.filter((i) => !faces[i].digital);
    let pairs = 0;
    for (const [b, B] of boards) {
      const near = [...boards.keys()].filter((o) => o !== b).sort((p, q) => ((boards.get(p).x - B.x) ** 2 + (boards.get(p).y - B.y) ** 2) - ((boards.get(q).x - B.x) ** 2 + (boards.get(q).y - B.y) ** 2) || p - q).slice(0, NO_REPEAT_BOARDS);
      const mine = statics(b), theirs = [b, ...near].flatMap(statics);
      for (const i of mine) for (const j of theirs) {
        if (i === j || got[i].kind !== got[j].kind) continue;
        // posters are few (8 images): only bulletins can promise it everywhere
        if (got[i].kind === 'bulletin') expect(imageAt(got[i], 0), `faces ${i} and ${j}`).not.toBe(imageAt(got[j], 0));
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(1000);
  });

  it('spreads the images: every bulletin is used', () => {
    const used = new Set(got.filter((a) => a.kind === 'bulletin' && !a.step).map((a) => imageAt(a, 0)));
    expect(used.size).toBe(images.filter((i) => i.kind === 'bulletin').length);
  });
});

describe('the digital rotation', () => {
  const images = testImages();
  const faces = realFaces().filter((f) => f.digital);
  const got = assignImages(faces, images);

  it('holds each image HOLD_S seconds with a quick fade, a pure function of the time', () => {
    const a = got[0], phase = phaseOf(faces[0].seed);
    const t0 = 5 * HOLD_S - phase;
    expect(adFrame(a, phase, t0 + 1).k).toBe(5);
    expect(adFrame(a, phase, t0 + HOLD_S - 0.01).cur).toBe(imageAt(a, 5));
    expect(adFrame(a, phase, t0 + HOLD_S + 0.01).cur).toBe(imageAt(a, 6));
    expect(adFrame(a, phase, t0).fade).toBe(0);
    expect(adFrame(a, phase, t0 + FADE_S).fade).toBe(1);
    expect(adFrame(a, phase, t0 + 3)).toEqual(adFrame(a, phase, t0 + 3));
    expect(a.kind).toBe('bulletin');
  });

  it('shows every image of its kind once before any repeats', () => {
    for (const a of got) {
      const seen = new Set(Array.from({ length: a.n }, (_, k) => imageAt(a, k - 3)));
      expect(seen.size).toBe(a.n);
    }
    for (let n = 1; n < 50; n++) for (let s = 0; s < 20; s++) {
      const st = stepFor(s * 7919, n);
      expect(st).toBeGreaterThanOrEqual(1);
      let g = st, m = n; while (m) [g, m] = [m, g % m];
      expect(g).toBe(1);
    }
  });

  it('agrees with the face shader\'s index rule, negative holds included', () => {
    const glsl = fs.readFileSync(path.join(ROOT, 'src/drive/roadside/billboardsFace.js'), 'utf8');
    expect(glsl).toContain('( int( vAd.z + 0.5 ) + k * int( vAd.w + 0.5 ) ) % n');
    expect(glsl).toContain('int( vAd.x + 0.5 ) + ( i < 0 ? i + n : i )');
    const a = { base: 32, n: 8, start: 5, step: 3 };
    // GLSL's % on negative ints follows C (sign of the dividend), as JavaScript's does
    const shader = (k) => { const i = (a.start + k * a.step) % a.n; return a.base + (i < 0 ? i + a.n : i); };
    for (let k = -20; k < 20; k++) expect(imageAt(a, k)).toBe(shader(k));
  });

  const means = Float32Array.from(images.flatMap((i) => i.mean));
  const peak = Math.max(...images.map((i) => luminance(...i.mean)));
  for (const rate of [1, 4, 16]) {
    it(`stays under ${FLASH_LIMIT_HZ} Hz at ${rate}x, measured with the images' own luminance`, () => {
      for (let i = 0; i < got.length; i++) {
        const phase = phaseOf(faces[i].seed);
        const m = measureFlash((t) => adMean(means, got[i], phase, t).map((v) => v / peak), { rate, seconds: 20 });
        expect(m.flashesPerSecond).toBeLessThanOrEqual(FLASH_LIMIT_HZ);
        if (rate === 1) expect(m.flashesPerSecond).toBeLessThanOrEqual(0.5); // one change in 8 s
      }
    }, 60000);
  }
});

// ---------------------------------------------------------------- the part, loading and the fallback
function fakeCtx() {
  const fields = ['x', 'y', 'facing', 'facing2', 'w', 'h', 'bottom', 'digital', 'sides', 'seed', 'sources'];
  const doc = { fields, boards: [[0, 0, 90, null, 14.63, 4.27, 7.62, 0, 1, 7, 1], [100, 0, -110, 110, 14.63, 4.27, 7.62, 1, 2, 9, 1], [200, 0, 90, null, 7.32, 3.66, 4, 0, 1, 11, 1]] };
  const renderer = { capabilities: { getMaxAnisotropy: () => 16 }, getContext: () => { throw new Error('no GL here'); }, initTexture: vi.fn() };
  return {
    optional: async () => doc,
    terrain: { groundY: () => 600, surfaceY: () => 600 },
    env: { lighting: { units: { nit: 0.1 }, ambientLux: () => 1e4 } },
    app: { renderer, invalidate: () => {} },
    group: new THREE.Group(),
  };
}

describe('the faces while loading, loaded, and when the images fail', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('falls back to the generated artwork when the images fail: never blank or black', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const part = await createBillboardsPart(fakeCtx());
    expect(part.stats().images.state).toBe('loading');
    const plain = part.screens[0].meanColor(0);
    expect(plain.every((v) => v === 0)).toBe(true); // by day the static lamps are off: level 0
    part.setLook({ lights: 1 });
    part.screens.forEach((s) => s.meanColor(0)); // a plain face meanwhile
    await part.whenSettled();
    expect(part.stats().images.state).toBe('art');
    for (const s of part.screens) {
      const m = s.meanColor(Date.parse('2026-11-22T03:00:00Z'));
      expect(Math.max(...m)).toBeGreaterThan(0.005);
    }
    part.dispose();
  });

  it('shows the advertisements once the atlas is in, the registry\'s colours from the images\' means', async () => {
    if (!atlasDoc) return;
    const ctx = fakeCtx();
    vi.stubGlobal('fetch', async (url) => {
      const f = path.join(DIR, String(url).replace('/textures/billboards/', ''));
      if (!fs.existsSync(f)) return { ok: false, status: 404 };
      const buf = fs.readFileSync(f);
      return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), blob: async () => ({ size: buf.length }) };
    });
    vi.stubGlobal('createImageBitmap', async () => ({ width: atlasDoc.tiers.high.w, height: atlasDoc.tiers.high.h, close() {} }));
    const part = await createBillboardsPart(ctx);
    await part.whenSettled();
    const st = part.stats().images;
    expect(st.state).toBe('ads');
    expect(st.tier).toBe('high');
    expect(st.images).toBe(atlasDoc.images.length);
    expect(ctx.app.renderer.initTexture).toHaveBeenCalled();
    part.setLook({ lights: 1 });
    const means = atlasDoc.images.map((i) => i.mean);
    // a static face's colour is one image's mean x its lamps' level
    const m = part.screens[0].meanColor(0);
    const k = part.stats().level.static;
    expect(means.some((mm) => mm.every((v, c) => Math.abs(v * k - m[c]) < 1e-3))).toBe(true);
    expect(PLAIN.every((v, c) => Math.abs(v * k - m[c]) > 1e-6)).toBe(true);
    part.dispose();
  });
});

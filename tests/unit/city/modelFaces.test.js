// Faces of one model in one plane, facing the same way and overlapping, flicker (z-fighting): the last flicker the
// stability pass found (Salt Lake City's 560 East South Temple and Clift Building, The Cosmopolitan Boulevard Tower).
// coplanar.js moves them apart as a city's models load. Here: the geometry on made-up faces, then every model of
// both cities read from its GLB file, as the app flattens it: how many have such faces (a number to update when a
// model arrives with them, or is fixed), that after the separation none is left and nothing moved over 5 cm, and
// that public/models/coplanar.json, the faces to move worked out ahead of time, still matches the models.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { flatten } from '../../../src/customModels.js';
import { coplanarOverlaps, coplanarFaces, overlapArea, separateCoplanarFaces, separateModels, separationTable, outlinePositions, SEPARATION, TABLE } from '../../../src/city/coplanar.js';
import { ROOT } from '../../helpers/staticServer.js';

// models with faces to separate, by city (45 of 131 and 32 of 76 on 23 November 2026)
const AFFECTED = { lv: 45, slc: 32 };

/** A made-up model of loose triangles: `quads` are [corners (4 x [x, y, z]), colour]. */
function model(quads) {
  const m = { pos: [], nor: [], col: [], glow: [], win: [], led: [] };
  for (const [c, colour] of quads) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      m.pos.push(...c[i]); m.nor.push(0, 1, 0); m.col.push(...colour); m.glow.push(0, 0, 0); m.win.push(0); m.led.push(0);
    }
  }
  return m;
}
const square = (x0, z0, x1, z1, y) => [[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]]; // faces up
const ys = (m) => [...new Set(Array.from({ length: m.pos.length / 3 }, (_, i) => Math.round(m.pos[i * 3 + 1] * 1000) / 1000))];
const GLASS = [0.2, 0.3, 0.35], ROOF = [0.48, 0.49, 0.5], BAND = [0.6, 0.6, 0.6];

describe('coplanar faces: the geometry', () => {
  it('overlapArea: the area two triangles share, nothing for a shared edge', () => {
    expect(overlapArea([[0, 0], [2, 0], [0, 2]], [[0, 0], [2, 0], [0, 2]])).toBeCloseTo(2);
    expect(overlapArea([[0, 0], [2, 0], [0, 2]], [[0, 0], [0, 2], [2, 0]])).toBeCloseTo(2); // either winding
    expect(overlapArea([[0, 0], [2, 0], [0, 2]], [[0, 0], [1, 0], [0, 1]])).toBeCloseTo(0.5);
    expect(overlapArea([[0, 0], [2, 0], [0, 2]], [[2, 0], [0, 2], [2, 2]])).toBeCloseTo(0);
    expect(overlapArea([[0, 0], [1, 0], [0, 1]], [[5, 5], [6, 5], [5, 6]])).toBe(0);
  });

  it('finds faces of two parts in one plane, not those a hair apart, facing away, or of one part', () => {
    const glassTop = model([[square(0, 0, 10, 10, 40), GLASS]]), cap = model([[square(-1, -1, 11, 11, 40), ROOF]]);
    const pos = [...glassTop.pos, ...cap.pos], part = [0, 0, 1, 1];
    expect(coplanarOverlaps(pos, part).map((p) => [p.a, p.b])).toEqual(expect.arrayContaining([[0, 2], [1, 3]]));
    expect(coplanarOverlaps(pos, part).reduce((s, p) => s + p.area, 0)).toBeCloseTo(100, 0);
    expect(coplanarOverlaps(pos, [0, 0, 0, 0])).toEqual([]);
    const lifted = model([[square(-1, -1, 11, 11, 40.05), ROOF]]);
    expect(coplanarOverlaps([...glassTop.pos, ...lifted.pos], part)).toEqual([]);
    const facingDown = model([[square(-1, -1, 11, 11, 40).reverse(), ROOF]]);
    expect(coplanarOverlaps([...glassTop.pos, ...facingDown.pos], part)).toEqual([]);
  });

  it('a model\'s buried bottom (facing down at or below its ground) is left out', () => {
    const down = (y) => square(0, 0, 10, 10, y).reverse();
    const m = model([[down(-2), GLASS], [down(-2), ROOF], [down(6), GLASS], [down(6), ROOF]]);
    expect(new Set(coplanarFaces(m).map((p) => Math.round(-p.d)))).toEqual(new Set([6]));
  });
});

describe('coplanar faces: separated', () => {
  it('the earlier face moves 5 cm behind the later one, which stays', () => {
    const m = model([[square(0, 0, 10, 10, 40), GLASS], [square(-1, -1, 11, 11, 40), ROOF]]);
    expect(separateCoplanarFaces(m)).toBe(2);
    expect(m.pos.slice(0, 18).filter((_, i) => i % 3 === 1).every((y) => Math.abs(y - (40 - SEPARATION)) < 1e-9)).toBe(true);
    expect(m.pos.slice(18).filter((_, i) => i % 3 === 1).every((y) => y === 40)).toBe(true);
    expect(coplanarFaces(m)).toEqual([]);
  });

  it('faces that look the same stay where they are (they draw the same pixels)', () => {
    const m = model([[square(0, 0, 10, 10, 40), ROOF], [square(-1, -1, 11, 11, 40), ROOF]]);
    const before = m.pos.slice();
    expect(separateCoplanarFaces(m)).toBe(0);
    expect(m.pos).toEqual(before);
  });

  it('separateModels takes a model\'s faces from the table while the entry fits it, else works them out', () => {
    const make = () => model([[square(0, 0, 10, 10, 40), GLASS], [square(-1, -1, 11, 11, 40), ROOF]]);
    const table = separationTable(new Map([['a', make()]]));
    expect(table.a.moved).toEqual([[0, SEPARATION], [1, SEPARATION]]);
    // a table entry is used as it stands: here one that moves only the first face, 1 cm
    const fromTable = separateModels(new Map([['a', make()]]), { a: { ...table.a, moved: [[0, 0.01]] } }).get('a');
    expect(fromTable.pos[1]).toBeCloseTo(39.99);
    expect(fromTable.pos[10]).toBe(40);
    // an entry for another model (other triangle count or positions) is ignored
    for (const stale of [{ ...table.a, tris: 3, moved: [[0, 0.01]] }, { ...table.a, check: table.a.check ^ 1, moved: [[0, 0.01]] }]) {
      const m = separateModels(new Map([['a', make()]]), { a: stale }).get('a');
      expect(m.pos[1]).toBeCloseTo(40 - SEPARATION);
      expect(m.pos[10]).toBeCloseTo(40 - SEPARATION);
    }
    // and its edge lines are drawn from the faces as modelled, wherever it is placed
    const m = separateModels(new Map([['a', make()]])).get('a');
    const placed = Float32Array.from(m.pos, (v, i) => v + [100, 3, -50][i % 3]);
    const outline = outlinePositions(m, placed);
    expect(Array.from(outline.slice(0, 18)).filter((_, i) => i % 3 === 1).every((y) => Math.abs(y - 43) < 1e-4)).toBe(true);
    expect(Array.from(outline.slice(18))).toEqual(Array.from(placed.slice(18)));
  });

  it('a stack of three shares the 5 cm: the last on top, each earlier one further back', () => {
    const m = model([[square(0, 0, 10, 10, 40), GLASS], [square(-1, -1, 11, 11, 40), ROOF], [square(2, 2, 8, 8, 40), BAND]]);
    separateCoplanarFaces(m);
    expect(ys(m).sort()).toEqual([40 - SEPARATION, 40 - SEPARATION / 2, 40]);
    expect(m.pos[1]).toBeCloseTo(40 - SEPARATION); // the glass, first, at the back
    expect(m.pos[37]).toBe(40); // the band, last, on top
    expect(coplanarFaces(m)).toEqual([]);
  });
});

describe('coplanar faces: every model of both cities', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/models.json'), 'utf8'));
  const models = {};
  beforeAll(async () => {
    const loader = new GLTFLoader();
    for (const city of Object.keys(AFFECTED)) {
      models[city] = [];
      for (const [id, spec] of Object.entries(manifest[city])) {
        const buf = fs.readFileSync(path.join(ROOT, 'public', spec.url));
        const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
        models[city].push({ id, name: spec.name, model: flatten(gltf.scene) });
      }
    }
  }, 120_000);

  for (const city of Object.keys(AFFECTED)) {
    it(`${city}: ${AFFECTED[city]} models have faces to separate`, () => {
      const affected = models[city].filter((m) => coplanarFaces(m.model).length).map((m) => `${m.id} ${m.name}`);
      expect(affected.length, affected.join('\n')).toBe(AFFECTED[city]);
    });

    it(`${city}: once separated none is left, and no face moved more than 5 cm`, () => {
      for (const { id, model: original } of models[city]) {
        const m = { ...original, pos: original.pos.slice() };
        separateCoplanarFaces(m);
        expect(coplanarFaces(m), id).toEqual([]);
        let most = 0;
        for (let i = 0; i < m.pos.length; i += 3) most = Math.max(most, Math.hypot(m.pos[i] - original.pos[i], m.pos[i + 1] - original.pos[i + 1], m.pos[i + 2] - original.pos[i + 2]));
        expect(most, id).toBeLessThanOrEqual(SEPARATION + 1e-9);
      }
    });
  }

  it(`${TABLE} is up to date (node tools/stability/model-faces.mjs --write)`, () => {
    const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', TABLE), 'utf8'));
    for (const city of Object.keys(AFFECTED)) {
      const now = separationTable(new Map(models[city].map((m) => [m.id, m.model])));
      expect(Object.keys(table[city]).sort(), city).toEqual(Object.keys(now).sort());
      for (const id of Object.keys(now)) expect(table[city][id], `${city} ${id}`).toEqual(now[id]);
    }
  });

  it('the four models the stability pass named are among them, and lose their fights', () => {
    const named = { slc: ['w595951117', 'w172543253'], lv: ['w472669744'] };
    for (const [city, ids] of Object.entries(named)) for (const id of ids) expect(coplanarFaces(models[city].find((m) => m.id === id).model).length, id).toBeGreaterThan(0);
    // Park MGM's flicker in the Arte Museum view is its window columns' edges under the nudge, not faces in one plane
    expect(coplanarFaces(models.lv.find((m) => m.id === 'w27831695').model)).toEqual([]);
  });
});

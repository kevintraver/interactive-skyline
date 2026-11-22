// The route picker's states (src/drive/ui/routecard.js pickerReduce, pickerView): open while Drive loads,
// collapsed to its chip once the drive is under way, open and collapsed again by the chip, Escape, a press
// elsewhere and a choice; and the outline map a card draws before its route's RoadNet is loaded (routemap.js).
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { pickerReduce, pickerView, PICKER_INITIAL, STARTS } from '../../../src/drive/ui/routecard.js';
import { outlineShape } from '../../../src/drive/ui/routemap.js';

const run = (events, from = { ...PICKER_INITIAL, current: 'i15n' }) => events.reduce(pickerReduce, from);

describe('route picker states', () => {
  it('is hidden in Map', () => {
    expect(pickerView(PICKER_INITIAL)).toEqual({ box: false, chip: false, list: false, expanded: 'false', progress: false });
    expect(run([{ type: 'toggle' }]).open).toBe(false); // the chip cannot be pressed while hidden
  });

  it('opens when Drive is entered, shows the line while loading, and folds to its chip once the drive is under way', () => {
    const loading = run([{ type: 'enter' }, { type: 'loading', on: true }]);
    expect(pickerView(loading)).toEqual({ box: true, chip: true, list: true, expanded: 'true', progress: true });
    const driving = run([{ type: 'loading', on: false }, { type: 'underway' }], loading);
    expect(pickerView(driving)).toEqual({ box: true, chip: true, list: false, expanded: 'false', progress: false });
  });

  it('the chip opens and collapses it; Escape or a press elsewhere collapses it', () => {
    const driving = run([{ type: 'enter' }, { type: 'underway' }]);
    const open = run([{ type: 'toggle' }], driving);
    expect(pickerView(open).list).toBe(true);
    expect(pickerView(run([{ type: 'toggle' }], open)).list).toBe(false);
    expect(pickerView(run([{ type: 'dismiss' }], open)).list).toBe(false);
    expect(run([{ type: 'dismiss' }], driving)).toBe(driving); // nothing to do
  });

  it('choosing another route collapses it at once, with that route current and loading', () => {
    const open = run([{ type: 'enter' }, { type: 'underway' }, { type: 'toggle' }]);
    const chosen = run([{ type: 'choose', route: 'us93' }, { type: 'loading', on: true }], open);
    expect(chosen.current).toBe('us93');
    expect(pickerView(chosen)).toEqual({ box: true, chip: true, list: false, expanded: 'false', progress: true });
    expect(pickerView(run([{ type: 'loading', on: false }, { type: 'underway' }], chosen)).list).toBe(false);
  });

  it('leaving Drive hides it and stops the line; entering again opens it', () => {
    const left = run([{ type: 'enter' }, { type: 'loading', on: true }, { type: 'exit' }]);
    expect(pickerView(left)).toEqual({ box: false, chip: false, list: false, expanded: 'false', progress: false });
    expect(pickerView(run([{ type: 'enter' }], left)).list).toBe(true);
  });

  it('a test can set it open or collapsed', () => {
    const driving = run([{ type: 'enter' }, { type: 'underway' }]);
    expect(run([{ type: 'open', open: true }], driving).open).toBe(true);
    expect(run([{ type: 'open', open: false }], driving).open).toBe(false);
  });

  it('offers the three starts of section 4.2', () => {
    expect(STARTS.map(([k]) => k)).toEqual(['reveal', 'start', 'city']);
  });
});

describe('outline maps', () => {
  const doc = JSON.parse(readFileSync(new URL('../../../public/data/lv/routes.json', import.meta.url), 'utf8'));

  it('every route has an outline in routes.json, drawn inside the card with the city in frame', () => {
    for (const r of doc.routes) {
      expect(Array.isArray(r.outline), r.id).toBe(true);
      expect(r.outline.length, r.id).toBeGreaterThan(1);
      const shape = outlineShape(r.outline, { s0: r.s0, s1: r.s1 });
      expect(shape.d.startsWith('M')).toBe(true);
      expect(shape.points).toBe(r.outline.length);
      for (const s of [r.s0, r.reveal.s, r.s1]) {
        const [x, y] = shape.at(s);
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(64);
        expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(64);
      }
      const [cx, cy] = shape.mark(0, 0);
      expect(cx).toBeGreaterThanOrEqual(0); expect(cy).toBeLessThanOrEqual(64);
    }
  });

  it('places a chainage by its share of the route along the outline, north up', () => {
    const shape = outlineShape([[0, 0], [0, 1000], [1000, 1000]], { s0: 0, s1: 4000, include: [] });
    expect(shape.at(0)).toEqual(shape.mark(0, 0));
    expect(shape.at(2000)).toEqual(shape.mark(0, 1000)); // half the route: the corner, half the outline's length
    expect(shape.at(4000)).toEqual(shape.mark(1000, 1000));
    expect(shape.at(9999)).toEqual(shape.mark(1000, 1000)); // clamped
    expect(shape.mark(0, 1000)[1]).toBeLessThan(shape.mark(0, 0)[1]); // north is up
  });
});
